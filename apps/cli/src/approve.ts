import { userInfo } from 'node:os'

/**
 * `lingtai approve <project> --issue <n>` — grant the approval a held run is
 * waiting for.
 *
 * The counterpart to `lingtai run --once --no-merge`. Without it that flag is
 * half a feature: the only other way to finish a held run is to run it again
 * without the flag, which starts a new run with a new worktree and a new diff
 * — so the thing that lands is not the thing anyone looked at.
 *
 * **Does not merge** (#465). It appends `WaitResolved{Approve}`, and whoever
 * holds the conductor lock continues the run from there; this command's exit
 * code says whether the approval was granted, not whether anything landed.
 */
import { approve as approveRun, currentRecipe, loadProject, ownerlessClient } from '@lingtai/conductor'
import { projectClient } from '@lingtai/conductor/filter'
import { conductorLockHolder } from '@lingtai/daemon'
import { agentBranchOf, reduceTicket, ticketStream, waitWords } from '@lingtai/domain'
import { hasGitHubAuth } from '@lingtai/env'
import { type EventStore, eventStore } from '@lingtai/event-store'

import { withProjector } from './projector.ts'
import { VERBS, logVerdict, refusal, type Answered } from './verdict.ts'

export interface ApproveCommandOptions {
  project: string
  issue: number
  note?: string
  by?: string
}

/** How long `approve` waits for a conductor to land what it approved. */
export const WAIT_MS = 60_000
const POLL_MS = 1_000

export interface FollowWorld {
  /** `conductorLockHolder`: who conducts, null for nobody, a throw where the lock could not be asked. */
  holder: () => Promise<string | null>
  store: Pick<EventStore, 'read'>
  now: () => number
  /** Resolves early when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  /** Settles `op` against `ms` and `signal`; injected so a test needs no real timer. */
  bound?: Bound
}

export type Bound = <T>(
  op: Promise<T>,
  ms: number,
  signal?: AbortSignal,
) => Promise<{ ok: true; value: T } | { ok: false; why: 'timeout' | 'abort' }>

/** A read that never answers must not outlast the 60 seconds or Ctrl+C. */
const boundReal: Bound = (op, ms, signal) =>
  new Promise((resolve) => {
    const end = (r: Parameters<typeof resolve>[0]): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = (): void => end({ ok: false, why: 'abort' })
    const timer = setTimeout(() => end({ ok: false, why: 'timeout' }), Math.max(0, ms))
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    // A rejection is the caller's to see: it comes back through `op`'s own throw.
    op.then(
      (value) => end({ ok: true, value }),
      (err) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(Promise.reject(err))
      },
    )
  })

export interface Followed {
  detail: string
  outcome: 'landed' | 'held' | 'pending' | 'no-conductor' | 'unknown'
  next?: string
  extra?: Record<string, unknown>
}

const why = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * What became of an approval (#748). **The approval has committed by the time
 * this runs, so nothing here throws and nothing turns the exit code.** A
 * conductor re-claims the ticket before it lands it, so `claimed` is still
 * "continuing" — only `landed`, `blocked`, `closed` and `backlog` end the wait.
 */
export async function followApproval(
  target: { project: string; issue: number },
  world: FollowWorld,
): Promise<Followed> {
  const bound = world.bound ?? boundReal
  const deadline = world.now() + WAIT_MS
  const status = `lingtai status says when it lands`
  const stopped: Followed = { detail: `stopped waiting; the approval stands, and ${status}`, outcome: 'unknown' }
  let holder: string | null
  try {
    const asked = await bound(world.holder(), WAIT_MS, world.signal)
    if (!asked.ok) {
      return asked.why === 'abort'
        ? stopped
        : {
            detail: `could not tell whether a conductor is running (no answer in ${WAIT_MS / 1000} seconds); lingtai doctor says`,
            outcome: 'unknown',
          }
    }
    holder = asked.value
  } catch (err) {
    return {
      detail: `could not tell whether a conductor is running (${why(err)}); lingtai doctor says`,
      outcome: 'unknown',
    }
  }
  if (holder === null) {
    return { detail: 'it lands when a conductor runs: lingtai start, or lingtai run', outcome: 'no-conductor' }
  }
  const stream = ticketStream(target.project, target.issue)
  for (;;) {
    if (world.signal?.aborted) return stopped
    try {
      const read = await bound(world.store.read(stream), deadline - world.now(), world.signal)
      if (!read.ok) {
        return read.why === 'abort' ? stopped : { detail: `${holder} is continuing it; ${status}`, outcome: 'pending' }
      }
      const ticket = reduceTicket(read.value)
      const lifecycle = ticket.lifecycle
      switch (lifecycle.status) {
        case 'landed':
          return {
            detail: `landed on ${lifecycle.base} in ${lifecycle.mergeCommit.slice(0, 7)}`,
            outcome: 'landed',
            extra: { mergeCommit: lifecycle.mergeCommit, base: lifecycle.base },
          }
        case 'blocked':
          return {
            detail: `held again: ${
              waitWords(lifecycle.reason, {
                branch: ticket.externalRef === null ? '' : agentBranchOf(ticket.externalRef),
                base: '',
                findings: [],
              }).line
            }`,
            outcome: 'held',
            next: `lingtai status ${target.project}`,
          }
        case 'closed':
        case 'backlog':
          return {
            detail: lifecycle.status === 'closed' ? 'closed' : 'requeued',
            outcome: 'held',
            extra: { became: lifecycle.status === 'closed' ? 'closed' : 'requeued' },
          }
        default:
          break
      }
    } catch (err) {
      return { detail: `could not read the outcome (${why(err)}); ${status}`, outcome: 'unknown' }
    }
    if (world.now() >= deadline) {
      return { detail: `${holder} is continuing it; ${status}`, outcome: 'pending' }
    }
    await world.sleep(POLL_MS, world.signal)
  }
}

const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

/** `progress` is where `withProjector`'s warnings go: stdout, or stderr under `--json`. */
export async function approveVerdict(
  options: ApproveCommandOptions,
  progress: (line: string) => void,
  world: Partial<FollowWorld> = {},
): Promise<Answered> {
  const project = await loadProject(options.project)
  if (!project) {
    return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
  }

  // **A project with no owner has no App to check and no GitHub client to
  // build** — the same branch `conductWork` takes (`conduct.ts`). Only
  // `refSha` is read off it now (`ApproveOptions.client`).
  let client: Parameters<typeof approveRun>[0]['client']
  if (project.owner === null) {
    const resolved = await currentRecipe(project)
    client = (await ownerlessClient(project, resolved.recipe)).client
  } else {
    if (!hasGitHubAuth()) {
      return refusal(
        1,
        'no-github-app',
        'no GitHub App configured — write github: in ~/.lingtai/config.yml (the /setup/github-app page on the board writes it), see doc/decisions/0114-a-github-app-not-a-token.md',
      )
    }
    client = (await projectClient(project)).client
  }

  const by = options.by ?? `human:${userInfo().username}`

  // This is the command most likely to be run with the board open, and it moves
  // a card off the lane the board exists for. So it follows the log while it
  // works, like every other host that appends — see `withProjector`.
  const approved = await withProjector(progress, async (): Promise<Answered> => {
    // `approveRun`'s own line carries the sha and the actor; it is held back and
    // becomes the verdict's detail, so a success prints one verdict and not two.
    const said: string[] = []
    const result = await approveRun({
      project: options.project,
      issue: options.issue,
      client,
      // An approval is never anonymous. The local account is a weak claim, but it
      // is a true one, and it is what a single-machine deployment has (0007).
      by,
      note: options.note,
      // `'open'`: `approveRun` takes the `deciding` lock and reads the item
      // inside it (`approve.ts`'s own `deciding`), so "the wait it reads" and
      // "the wait it resolves" are the same read — there is no card, read
      // before the lock, for a stale one to disagree with (#508).
      waitId: 'open',
      log: (line) => said.push(line),
    })

    if (!result.ok) {
      return refusal(1, result.reason, result.detail, { ticketId: result.ticketId })
    }
    const unscheduled = result.unscheduled
    return {
      code: 0,
      verdict: {
        outcome: 'accepted',
        ticketId: result.ticketId,
        subject: `#${options.issue}`,
        form: 'sentence',
        detail:
          unscheduled === undefined
            ? (said.at(-1)?.replace(/^approved /, '') ?? `continues at ${result.continuesAt}`)
            : `continues at ${result.continuesAt}, but the continuation was not scheduled (${unscheduled}); run it again to schedule it`,
        ...(unscheduled === undefined ? {} : { next: `lingtai approve ${options.project} --issue ${options.issue}` }),
        extra: { continuesAt: result.continuesAt, ...(unscheduled === undefined ? {} : { unscheduled }) },
      },
    }
  })

  const { verdict } = approved
  if (verdict.outcome === 'refused') {
    // The conductor's sentence names the stream id; the person knows it as `#n`.
    const subject = `#${options.issue}`
    return {
      ...approved,
      verdict: {
        ...verdict,
        subject,
        detail: verdict.ticketId === undefined ? verdict.detail : verdict.detail.replaceAll(verdict.ticketId, subject),
      },
    }
  }
  if (verdict.extra?.['unscheduled'] !== undefined) return approved

  // Ctrl+C is registered only now: before the approval commits it keeps Node's
  // default, and a second one after this is Node's default again.
  const abort = new AbortController()
  const onInt = (): void => abort.abort()
  if (world.signal === undefined) process.once('SIGINT', onInt)
  try {
    const followed = await followApproval(
      { project: options.project, issue: options.issue },
      {
        holder: () => conductorLockHolder(),
        store: eventStore,
        now: Date.now,
        sleep: sleepFor,
        signal: abort.signal,
        ...world,
      },
    )
    return {
      code: 0,
      verdict: {
        ...verdict,
        detail: followed.detail,
        ...(followed.next === undefined ? {} : { next: followed.next }),
        extra: { ...verdict.extra, outcome: followed.outcome, ...followed.extra },
      },
    }
  } finally {
    process.removeListener('SIGINT', onInt)
  }
}

export async function approveCommand(options: ApproveCommandOptions, log = console.log): Promise<number> {
  return logVerdict(VERBS['approve'], await approveVerdict(options, log), log)
}
