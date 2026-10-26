/**
 * Turning an approved split plan into GitHub issues and links (#601, #603, 0118 §12).
 *
 * **A reconciliation of a frozen plan against GitHub.** GitHub has no
 * transaction, so what this guarantees is that running it twice is running it
 * once, that running it again after a failure converges on the whole plan, and
 * that it never touches an issue it did not create.
 *
 * - **The plan freezes at the first `SplitStarted`** for the wait. Every later
 *   call uses that plan and ignores `options.plan`.
 * - **A child is known by its marker (`splitMarker`) and nothing else** — never
 *   by title. Found by listing the issues created since the first
 *   `SplitStarted` (`listIssuesSince`, which is complete or throws; never
 *   search, whose index lags a create). An issue without the marker is never
 *   adopted, edited, attached or linked, and a child found keeps GitHub's title
 *   and body.
 * - **One child at a time:** create, attach, `SplitChildWritten`, then the next
 *   child. A crash between a create and its record is accepted: a retry finds
 *   the child by marker.
 * - **`TicketSplit` is the outcome read back:** its `blockedBy` is what GitHub
 *   returned, mapped to keys.
 *
 * The page's *writing* is not read off this log alone: `splitProgressOf` takes
 * whether a writer is running in the asker's process, so a writer whose last
 * append threw reads as interrupted, with Retry.
 *
 * The last step is `resolveWaitHolding`, still the only writer of
 * `WaitResolved`; it appends `TicketSplit` ahead of it in the same
 * transaction, so a retry after a lost race re-reads and lands only that.
 */
import {
  reduceTicket,
  splitProgressOf,
  ticketStream,
  type EventType,
  type PayloadOf,
  type WaitId,
} from '@lingtai/domain'
import { allowedResolutions, splitPlanProblems, describeSplitProblem } from '@lingtai/domain/wait'
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'
import type { GitHubClient, LinkedIssue } from '@lingtai/github'

import { deciding } from './approve.ts'
import { describeReason, resolveWaitHolding } from './resolve-wait.ts'
import { splitDoneWhen } from './split-body.ts'
import { BodyChanged } from './ticket-store.ts'

/** What the writer needs of GitHub — narrower than `GitHubClient`, and not `Tickets` (#599 kept links off it). */
export type SplitClient = Pick<
  GitHubClient,
  | 'getIssue'
  | 'createIssue'
  | 'updateBody'
  | 'addSubIssue'
  | 'listSubIssues'
  | 'addBlockedBy'
  | 'listBlockedBy'
  | 'listIssuesSince'
>

export interface SplitPlanInput {
  children: readonly { key: string; title: string; body: string; kind: string }[]
  blockedBy: readonly { ticket: string; blockedBy: string }[]
}

/** How a child says which wait and plan entry made it. Invisible when rendered. */
export function splitMarker(waitId: string, key: string): string {
  return `<!-- lingtai:split ${waitId} ${key} -->`
}

/** Clocks disagree; see `SKEW_MS` in `ticket-store.ts`. */
const SKEW_MS = 60 * 60_000

export type StepStatus = 'done' | 'skipped' | 'failed' | 'not-reached'

/** One row of the progress the board draws: `skipped` is a write a retry found already made. */
export interface SplitStep {
  name: string
  status: StepStatus
  detail?: string
}

export interface SplitTicketOptions {
  project: string
  issue: number
  waitId: WaitId
  /**
   * Required on the first call only: the plan is frozen by the first
   * `SplitStarted`, and a call after it ignores whatever is passed here.
   */
  plan?: SplitPlanInput
  /** The recipe's `source.kinds`. */
  kinds: readonly string[]
  /** `owner/repo` of the project — a sub-issue from another repository is not this split's. */
  repository: string
  by: string
  /**
   * This board process's id, for `SplitStarted`: a writer whose instance is not
   * the asker's has gone, and the fold reads it as interrupted. Make it once per
   * process and cache it on `globalThis` — a module-level `randomUUID()` is
   * re-evaluated by Next's dev HMR, and a running write would read as
   * interrupted to its own page.
   */
  instance: string
  note?: string
  /** Called straight after this attempt's `SplitStarted` is appended — the write is running from here. */
  onStarted?: () => void
  github: SplitClient
  store?: EventStore
}

export interface SplitTicketResult {
  ok: boolean
  ticketId: string
  detail: string
  steps: SplitStep[]
  /** Every child known so far, in plan order. */
  children: { key: string; number: number }[]
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One decision at a time — the lock `editBodyAndRequeue` takes, held through every write. */
export async function splitTicket(options: SplitTicketOptions): Promise<SplitTicketResult> {
  const store = options.store ?? eventStore
  const ticketId = ticketStream(options.project, options.issue)
  return deciding(
    ticketId,
    () =>
      refused(options.plan, ticketId, `${ticketId} is being decided by someone else right now. Reload and read it again.`),
    () => splitTicketHolding(options, store, ticketId),
  )
}

function stepNames(plan: SplitPlanInput | undefined): string[] {
  if (plan === undefined) return []
  return [
    'read GitHub',
    ...plan.children.map((c) => `write ${c.key}`),
    ...plan.blockedBy.map((d) => `chain ${d.ticket}←${d.blockedBy}`),
    ...plan.children.map((c) => `hold parent ← ${c.key}`),
    'done when',
    'record the split',
    'end the wait',
  ]
}

function refused(plan: SplitPlanInput | undefined, ticketId: string, detail: string): SplitTicketResult {
  return {
    ok: false,
    ticketId,
    detail,
    steps: stepNames(plan).map((name) => ({ name, status: 'not-reached' as const })),
    children: [],
  }
}

/** Exported for the unit half alone — the lock is the filesystem. */
export async function splitTicketHolding(
  options: SplitTicketOptions,
  store: EventStore,
  ticketId: string,
): Promise<SplitTicketResult> {
  const { github, waitId, repository } = options

  // **Refuse before writing**, with no GitHub call until every check passed.
  const events = await store.read(ticketId)
  const first = events.find((e) => e.type === 'SplitStarted' && (e.data as { waitId?: string }).waitId === waitId)
  // The plan is the one the first Create all froze, whatever this call was handed.
  const plan: SplitPlanInput | undefined =
    first === undefined ? options.plan : (first.data as PayloadOf<'SplitStarted'>).plan
  const stop = (detail: string) => refused(plan, ticketId, detail)
  const item = reduceTicket(events)
  if (item.lifecycle.status !== 'blocked' || item.lifecycle.waitId !== waitId)
    return stop(`${ticketId} is not waiting on ${waitId} — nothing was written. Reload and read it again.`)
  if (!allowedResolutions(item.lifecycle.reason).includes('Split'))
    return stop(`Split is not offered for ${describeReason(item.lifecycle.reason)} — nothing was written.`)
  if (plan === undefined) return stop('there is no split plan to write — nothing was written.')
  if (first === undefined) {
    const problems = splitPlanProblems(plan, { kinds: options.kinds })
    if (problems.length > 0)
      return stop(`the split plan is refused — nothing was written: ${problems.map(describeSplitProblem).join('; ')}.`)
  }
  // Before this attempt's own `SplitStarted`: a read that threw after it would leave a start with nothing terminal after it.
  const since = new Date((first?.at ?? new Date()).getTime() - SKEW_MS)

  const prior = splitProgressOf(events, { waitId, instance: options.instance, running: true })
  const known = new Map(prior.state === 'idle' ? [] : prior.children.map((c) => [c.key, c.number] as const))
  const linked = new Set(prior.state === 'idle' ? [] : prior.links.map((l) => `${l.ticket}\u0000${l.blockedBy}`))

  /** Facts about GitHub, not decisions about the stream: append at its current version, once more if it moved. */
  async function note<T extends EventType>(type: T, data: PayloadOf<T>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const current = await store.read(ticketId)
      try {
        await store.append(ticketId, current.at(-1)?.version ?? 0, [{ type, data, actor: options.by }])
        return
      } catch (err) {
        if (!(err instanceof ConcurrencyError) || attempt > 0) throw err
      }
    }
  }
  await note('SplitStarted', {
    waitId,
    plan: { children: [...plan.children], blockedBy: [...plan.blockedBy] },
    instance: options.instance,
  })
  options.onStarted?.()

  /** The terminal event. If it cannot be appended the caller's running set still says the writer is gone. */
  const noteFailed = async (step: string, detail: string): Promise<void> => {
    try {
      await note('SplitFailed', { waitId, step, detail })
    } catch (err) {
      console.error(`could not record SplitFailed for ${ticketId}:`, err)
    }
  }
  const failedAt = async (step: string, detail: string): Promise<SplitTicketResult> => {
    await noteFailed(step, detail)
    return stop(detail)
  }

  // The children GitHub has, by marker alone: never by title, never by search.
  const found = new Map<string, number>()
  async function findMarked(): Promise<void> {
    const listed = (await github.listIssuesSince(since)).sort((a, b) => a.number - b.number)
    for (const child of plan!.children) {
      if (found.has(child.key)) continue
      const marker = splitMarker(waitId, child.key)
      const hit = listed.find((i) => i.body.includes(marker))
      if (hit !== undefined) found.set(child.key, hit.number)
    }
  }
  try {
    await findMarked()
  } catch (err) {
    return failedAt(
      'read GitHub',
      `the issues opened since this wait started could not be listed: ${errorMessage(err)}`,
    )
  }

  const here = (l: LinkedIssue) => l.repository === repository
  const numberOf = (key: string) => found.get(key)!
  const links = (list: readonly LinkedIssue[], number: number) => list.some((l) => here(l) && l.number === number)

  /** Add a link only if absent (GitHub answers a duplicate with a 422), and read it back. */
  async function ensure(
    list: () => Promise<LinkedIssue[]>,
    add: () => Promise<void>,
    number: number,
  ): Promise<StepStatus> {
    if (links(await list(), number)) return 'skipped'
    try {
      await add()
    } catch (err) {
      if (links(await list(), number)) return 'done' // the response was lost, not the write
      throw err
    }
    if (!links(await list(), number)) throw new Error(`#${number} was not linked on read-back`)
    return 'done'
  }

  const expectedBody = (child: SplitPlanInput['children'][number]) =>
    `${child.body.trimEnd()}\n\n${splitMarker(waitId, child.key)}\n`

  /** Create (unless a marker answers), attach, record — and only then is the next child started. */
  async function writeChild(child: SplitPlanInput['children'][number]): Promise<StepStatus> {
    let status: StepStatus = 'skipped'
    if (!found.has(child.key)) {
      try {
        const opened = await github.createIssue({
          title: child.title.trim(),
          body: expectedBody(child),
          labels: [child.kind],
        })
        found.set(child.key, opened.number)
      } catch (err) {
        // A timed-out create is not proof of absence: look by marker before failing.
        try {
          await findMarked()
        } catch {
          throw err
        }
        if (!found.has(child.key)) throw err
      }
      status = 'done'
    }
    const number = numberOf(child.key)
    const attached = await ensure(
      () => github.listSubIssues(options.issue),
      () => github.addSubIssue(options.issue, number),
      number,
    )
    if (attached === 'done') status = 'done'
    // Written means attached; GitHub's `id` is only on the sub-issue listing.
    if (known.get(child.key) !== number) {
      const sub = (await github.listSubIssues(options.issue)).find((s) => here(s) && s.number === number)
      if (sub === undefined) throw new Error(`#${number} is not a sub-issue on read-back`)
      await note('SplitChildWritten', { waitId, key: child.key, number: sub.number, id: sub.id })
      // The key names another issue now, so links recorded for the old one are stale.
      if (known.has(child.key)) for (const l of linked) if (l.split('\u0000').includes(child.key)) linked.delete(l)
      known.set(child.key, number)
    }
    return status
  }

  async function writeDoneWhen(): Promise<StepStatus> {
    const numbers = plan!.children.map((c) => numberOf(c.key))
    for (let attempt = 0; ; attempt++) {
      const body = (await github.getIssue(options.issue)).body
      const next = splitDoneWhen(body, numbers)
      if (next === body) return attempt === 0 ? 'skipped' : 'done'
      try {
        await github.updateBody(options.issue, next, { ifUnchanged: body })
      } catch (err) {
        if (err instanceof BodyChanged && attempt === 0) continue
        throw err
      }
      const after = (await github.getIssue(options.issue)).body
      if (splitDoneWhen(after, numbers) !== after) throw new Error('the Done when section did not land on read-back')
      return 'done'
    }
  }

  let payload: unknown
  let result: SplitTicketResult | null = null

  const actions: { name: string; run: () => Promise<StepStatus | { detail: string }> }[] = [
    { name: 'read GitHub', run: async () => 'done' },
    ...plan.children.map((child) => ({ name: `write ${child.key}`, run: () => writeChild(child) })),
    ...plan.blockedBy.map((d) => ({
      name: `chain ${d.ticket}←${d.blockedBy}`,
      run: async (): Promise<StepStatus> => {
        const status = await ensure(
          () => github.listBlockedBy(numberOf(d.ticket)),
          () => github.addBlockedBy(numberOf(d.ticket), numberOf(d.blockedBy)),
          numberOf(d.blockedBy),
        )
        const link = `${d.ticket}\u0000${d.blockedBy}`
        if (!linked.has(link)) {
          await note('SplitLinkWritten', { waitId, ticket: d.ticket, blockedBy: d.blockedBy })
          linked.add(link)
        }
        return status
      },
    })),
    ...plan.children.map((child) => ({
      name: `hold parent ← ${child.key}`,
      run: () =>
        ensure(
          () => github.listBlockedBy(options.issue),
          () => github.addBlockedBy(options.issue, numberOf(child.key)),
          numberOf(child.key),
        ),
    })),
    { name: 'done when', run: writeDoneWhen },
    {
      // Every read here is GitHub's answer, not the plan's: the sub-issue
      // listing is where the `id` comes from (no create call returns one), and
      // each child's own `blocked_by` is where the recorded links come from.
      name: 'record the split',
      run: async (): Promise<StepStatus> => {
        const subs = (await github.listSubIssues(options.issue)).filter(here)
        const keyOf = new Map(plan.children.map((c) => [numberOf(c.key), c.key] as const))
        const children: { key: string; number: number; id: number }[] = []
        const blockedBy: { ticket: string; blockedBy: string }[] = []
        for (const c of plan.children) {
          const sub = subs.find((s) => s.number === numberOf(c.key))
          if (sub === undefined) throw new Error(`#${numberOf(c.key)} is not a sub-issue on read-back`)
          children.push({ key: c.key, number: sub.number, id: sub.id })
          for (const l of (await github.listBlockedBy(sub.number)).filter(here)) {
            const blocker = keyOf.get(l.number)
            if (blocker !== undefined && blocker !== c.key) blockedBy.push({ ticket: c.key, blockedBy: blocker })
          }
        }
        for (const d of plan.blockedBy)
          if (!blockedBy.some((b) => b.ticket === d.ticket && b.blockedBy === d.blockedBy))
            throw new Error(`${d.ticket}←${d.blockedBy} was not linked on read-back`)
        payload = { waitId, children, blockedBy }
        // Not done until the append lands: marked when 'end the wait' succeeds.
        return 'not-reached'
      },
    },
    {
      name: 'end the wait',
      run: async (): Promise<StepStatus | { detail: string }> => {
        const resolved = await resolveWaitHolding(
          {
            ticketId,
            waitId,
            resolution: { _tag: 'Split', children: [...plan.children], blockedBy: [...plan.blockedBy] },
            by: options.by,
            note: options.note,
            kinds: options.kinds,
            split: payload,
            store,
          },
          ticketId,
        )
        if (!resolved.ok) return { detail: resolved.detail }
        return 'done'
      },
    },
  ]

  const steps: SplitStep[] = actions.map((a) => ({ name: a.name, status: 'not-reached' as const }))
  const knownChildren = () =>
    plan.children.filter((c) => found.has(c.key)).map((c) => ({ key: c.key, number: numberOf(c.key) }))
  steps[0]!.status = 'done'

  let failedStep = ''
  for (const [i, action] of actions.entries()) {
    if (i === 0) continue
    try {
      const outcome = await action.run()
      if (typeof outcome === 'string') {
        steps[i]!.status = outcome
        if (action.name === 'end the wait') steps[i - 1]!.status = 'done'
      } else {
        steps[i]!.status = 'failed'
        steps[i]!.detail = outcome.detail
        steps[i - 1]!.status = 'failed'
        steps[i - 1]!.detail = outcome.detail
        result = { ok: false, ticketId, detail: `${action.name}: ${outcome.detail}`, steps, children: knownChildren() }
        failedStep = action.name
        break
      }
    } catch (err) {
      steps[i]!.status = 'failed'
      steps[i]!.detail = errorMessage(err)
      if (action.name === 'end the wait') {
        steps[i - 1]!.status = 'failed'
        steps[i - 1]!.detail = errorMessage(err)
      }
      failedStep = action.name
      result = {
        ok: false,
        ticketId,
        detail: `${action.name} failed: ${errorMessage(err)}. Nothing was finished — call again to write what is missing.`,
        steps,
        children: knownChildren(),
      }
      break
    }
  }

  // One place on the way out: a failure with no terminal event would read as writing until the board restarts.
  if (result !== null) await noteFailed(failedStep, result.detail)

  return (
    result ?? { ok: true, ticketId, detail: 'split written, and back in the queue', steps, children: knownChildren() }
  )
}
