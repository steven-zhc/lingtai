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
import { approveEffect } from '@lingtai/conductor/decide'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { currentRecipeEffect, loadProjectEffect } from '@lingtai/conductor/projects'
import { conductorLockHolder } from '@lingtai/daemon'
import { agentBranchOf, ticketReducer, ticketStream, waitWords } from '@lingtai/domain'
import { hasGitHubAuth } from '@lingtai/env'
import { type EventStore, eventStore, log, readThroughSnapshot, type SnapshotStore } from '@lingtai/event-store'
import { Effect } from 'effect'

import { boundReal, type Bound, WAIT_MS } from './conductor-note.ts'
import { VERBS, logVerdict, refusal, type Answered } from './verdict.ts'

export interface ApproveCommandOptions {
  project: string
  issue: number
  note?: string
  by?: string
}

const POLL_MS = 1_000

export { WAIT_MS, type Bound }

export interface FollowWorld {
  /** `conductorLockHolder`: who conducts, null for nobody, a throw where the lock could not be asked. */
  holder: () => Promise<string | null>
  store: Pick<EventStore, 'read' | 'readTypes'>
  /** Read-only: a short command never writes a snapshot (0124 §5). */
  snapshots?: SnapshotStore
  now: () => number
  /** Resolves early when `signal` aborts. */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  signal?: AbortSignal
  /** Settles `op` against `ms` and `signal`; injected so a test needs no real timer. */
  bound?: Bound
}

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
export function followApproval(
  target: { project: string; issue: number },
  world: FollowWorld,
): Effect.Effect<Followed> {
  return Effect.gen(function* () {
    const bound = world.bound ?? boundReal
    // The read runs in the caller's own services, not an empty set: `runPromiseWith` is the
    // run the ratchet does not count, and it hands `bound` the promise it settles against.
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const deadline = world.now() + WAIT_MS
    const status = `lingtai status says when it lands`
    const stopped: Followed = { detail: `stopped waiting; the approval stands, and ${status}`, outcome: 'unknown' }
    const attempt = <T>(op: () => Promise<T>) =>
      Effect.tryPromise({ try: () => op(), catch: (err) => err }).pipe(
        Effect.match({
          onFailure: (err) => ({ threw: true as const, err }),
          onSuccess: (value) => ({ threw: false as const, value }),
        }),
      )
    const asked = yield* attempt(() => bound(world.holder(), WAIT_MS, world.signal))
    if (asked.threw) {
      return {
        detail: `could not tell whether a conductor is running (${why(asked.err)}); lingtai doctor says`,
        outcome: 'unknown',
      } satisfies Followed
    }
    if (!asked.value.ok) {
      return asked.value.why === 'abort'
        ? stopped
        : ({
            detail: `could not tell whether a conductor is running (no answer in ${WAIT_MS / 1000} seconds); lingtai doctor says`,
            outcome: 'unknown',
          } satisfies Followed)
    }
    const holder = asked.value.value
    if (holder === null) {
      return {
        detail: 'it lands when a conductor runs: lingtai start, or lingtai run',
        outcome: 'no-conductor',
      } satisfies Followed
    }
    const stream = ticketStream(target.project, target.issue)
    for (;;) {
      if (world.signal?.aborted) return stopped
      const got = yield* attempt(() =>
        bound(
          run(readThroughSnapshot(world.store, ticketReducer, stream, 'all', { snapshots: world.snapshots })),
          deadline - world.now(),
          world.signal,
        ),
      )
      if (got.threw) {
        return {
          detail: `could not read the outcome (${why(got.err)}); ${status}`,
          outcome: 'unknown',
        } satisfies Followed
      }
      const read = got.value
      if (!read.ok) {
        return read.why === 'abort'
          ? stopped
          : ({ detail: `${holder} is continuing it; ${status}`, outcome: 'pending' } satisfies Followed)
      }
      const ticket = read.value
      const lifecycle = ticket.lifecycle
      switch (lifecycle.status) {
        case 'landed':
          return {
            detail: `landed on ${lifecycle.base} in ${lifecycle.mergeCommit.slice(0, 7)}`,
            outcome: 'landed',
            extra: { mergeCommit: lifecycle.mergeCommit, base: lifecycle.base },
          } satisfies Followed
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
          } satisfies Followed
        case 'closed':
        case 'backlog':
          return {
            detail: lifecycle.status === 'closed' ? 'closed' : 'requeued',
            outcome: 'held',
            extra: { became: lifecycle.status === 'closed' ? 'closed' : 'requeued' },
          } satisfies Followed
        default:
          break
      }
      if (world.now() >= deadline) {
        return { detail: `${holder} is continuing it; ${status}`, outcome: 'pending' } satisfies Followed
      }
      yield* Effect.promise(() => world.sleep(POLL_MS, world.signal))
    }
  })
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

/** `progress` is where a command's side remarks go: stdout, or stderr under `--json`. */
export function approveVerdict(
  options: ApproveCommandOptions,
  progress: (line: string) => void,
  world: Partial<FollowWorld> = {},
): Effect.Effect<Answered, unknown> {
  return Effect.gen(function* () {
    const project = yield* loadProjectEffect(options.project)
    if (!project) {
      return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
    }

    // **A project with no owner has no App to check and no GitHub client to
    // build** — the same branch `conductWork` takes (`conduct.ts`). Only
    // `refSha` is read off it now (`ApproveOptions.client`).
    let client: Parameters<typeof approveEffect>[0]['client']
    if (project.owner === null) {
      const resolved = yield* currentRecipeEffect(project)
      client = (yield* ownerlessClientEffect(project, resolved.recipe)).client
    } else {
      if (!hasGitHubAuth()) {
        return refusal(
          1,
          'no-github-app',
          'no GitHub App configured — write github: in ~/.lingtai/config.yml (the /setup/github-app page on the board writes it), see doc/decisions/0114-a-github-app-not-a-token.md',
        )
      }
      client = (yield* projectClientEffect(project)).client
    }

    const by = options.by ?? `human:${userInfo().username}`

    // It holds no projector: the conductor that lands the approval is the board's
    // only writer (0100 §13), and `followApproval` below says when none is up.
    const grant = Effect.gen(function* () {
      // `approveEffect`'s own line carries the sha and the actor; it is held back and
      // becomes the verdict's detail, so a success prints one verdict and not two.
      const said: string[] = []
      const result = yield* approveEffect({
        project: options.project,
        issue: options.issue,
        client,
        // An approval is never anonymous. The local account is a weak claim, but it
        // is a true one, and it is what a single-machine deployment has (0007).
        by,
        note: options.note,
        // `'open'`: `approveEffect` takes the `deciding` lock and reads the item
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
      } satisfies Answered
    })
    const approved: Answered = yield* grant

    const { verdict } = approved
    if (verdict.outcome === 'refused') {
      // The conductor's sentence names the stream id; the person knows it as `#n`.
      const subject = `#${options.issue}`
      return {
        ...approved,
        verdict: {
          ...verdict,
          subject,
          detail:
            verdict.ticketId === undefined ? verdict.detail : verdict.detail.replaceAll(verdict.ticketId, subject),
        },
      } satisfies Answered
    }
    if (verdict.extra?.['unscheduled'] !== undefined) return approved

    // Ctrl+C is registered only now: before the approval commits it keeps Node's
    // default, and a second one after this is Node's default again. This scopes a
    // listener's lifetime; the decide hold was `approveEffect`'s and is released.
    const abort = new AbortController()
    const onInt = (): void => abort.abort()
    const followed = yield* Effect.acquireUseRelease(
      Effect.sync(() => {
        if (world.signal === undefined) process.once('SIGINT', onInt)
      }),
      () =>
        followApproval(
          { project: options.project, issue: options.issue },
          {
            holder: () => conductorLockHolder(),
            store: eventStore,
            snapshots: world.store === undefined ? log.snapshots : undefined,
            now: Date.now,
            sleep: sleepFor,
            signal: abort.signal,
            ...world,
          },
        ),
      () =>
        Effect.sync(() => {
          process.removeListener('SIGINT', onInt)
        }),
    )
    return {
      code: 0,
      verdict: {
        ...verdict,
        detail: followed.detail,
        ...(followed.next === undefined ? {} : { next: followed.next }),
        extra: { ...verdict.extra, outcome: followed.outcome, ...followed.extra },
      },
    } satisfies Answered
  })
}

export function approveCommand(options: ApproveCommandOptions, log = console.log): Effect.Effect<number, unknown> {
  return Effect.map(approveVerdict(options, log), (answered) => logVerdict(VERBS['approve'], answered, log))
}
