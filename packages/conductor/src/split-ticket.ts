/**
 * Turning an approved split plan into GitHub issues and links (#601, 0118 §12).
 *
 * **Writes in order, each one read back, and nothing on the log until all of
 * them were.** A partial split leaves no event, so the next call resumes from
 * GitHub's own state: it reads the parent's sub-issues, adopts a child whose
 * title is a plan entry, and writes only what is missing. A timed-out create
 * is not proof of absence, so every child carries an invisible marker
 * (`splitMarker`) and a create that threw is looked for by it before anything
 * is created again — `githubTicketStore`'s `propose` does the same for
 * findings.
 *
 * The last step is `resolveWaitHolding`, still the only writer of
 * `WaitResolved`; it appends `TicketSplit` ahead of it in the same
 * transaction, so a retry after a lost race re-reads and lands only that.
 * The board is not wired to this here — #604 is.
 */
import { reduceTicket, ticketStream, type WaitId } from '@lingtai/domain'
import { allowedResolutions, splitPlanProblems, describeSplitProblem } from '@lingtai/domain/wait'
import { type EventStore, eventStore } from '@lingtai/event-store'
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
  | 'setLabels'
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
  plan: SplitPlanInput
  /** The recipe's `source.kinds`. */
  kinds: readonly string[]
  /** `owner/repo` of the project — a sub-issue from another repository is not this split's. */
  repository: string
  by: string
  note?: string
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
      refused(options, ticketId, `${ticketId} is being decided by someone else right now. Reload and read it again.`),
    () => splitTicketHolding(options, store, ticketId),
  )
}

function stepNames(plan: SplitPlanInput): string[] {
  return [
    ...plan.children.map((c) => `create ${c.key}`),
    ...plan.children.map((c) => `attach ${c.key}`),
    ...plan.blockedBy.map((d) => `chain ${d.ticket}←${d.blockedBy}`),
    ...plan.children.map((c) => `hold parent ← ${c.key}`),
    'done when',
    'record the split',
    'end the wait',
  ]
}

function refused(options: SplitTicketOptions, ticketId: string, detail: string): SplitTicketResult {
  return {
    ok: false,
    ticketId,
    detail,
    steps: stepNames(options.plan).map((name) => ({ name, status: 'not-reached' as const })),
    children: [],
  }
}

/** Exported for the unit half alone — the lock is the filesystem. */
export async function splitTicketHolding(
  options: SplitTicketOptions,
  store: EventStore,
  ticketId: string,
): Promise<SplitTicketResult> {
  const { github, plan, waitId, repository } = options
  const stop = (detail: string) => refused(options, ticketId, detail)

  // **Refuse before writing**, with no GitHub call until every check passed.
  const events = await store.read(ticketId)
  const item = reduceTicket(events)
  if (item.lifecycle.status !== 'blocked' || item.lifecycle.waitId !== waitId)
    return stop(`${ticketId} is not waiting on ${waitId} — nothing was written. Reload and read it again.`)
  if (!allowedResolutions(item.lifecycle.reason).includes('Split'))
    return stop(`Split is not offered for ${describeReason(item.lifecycle.reason)} — nothing was written.`)
  const problems = splitPlanProblems(plan, { kinds: options.kinds })
  if (problems.length > 0)
    return stop(`the split plan is refused — nothing was written: ${problems.map(describeSplitProblem).join('; ')}.`)
  const titles = plan.children.map((c) => c.title.trim())
  const twice = titles.find((t, i) => titles.indexOf(t) !== i)
  if (twice !== undefined)
    return stop(`two children are titled "${twice}" — a retry could not tell them apart. Nothing was written.`)

  const started = events.find((e) => e.type === 'WaitStarted' && (e.data as { waitId?: string }).waitId === waitId)
  const since = new Date((started ?? events[0]!).at.getTime() - SKEW_MS)

  // What GitHub already has, never what the log says: a partial split left nothing on it.
  const have = new Map<string, { number: number; id?: number }>()
  const here = (l: LinkedIssue) => l.repository === repository
  try {
    const subs = (await github.listSubIssues(options.issue)).filter(here)
    for (const child of plan.children) {
      const match = subs.filter((s) => s.title.trim() === child.title.trim())
      if (match.length > 1)
        return stop(
          `#${options.issue} has ${match.length} sub-issues titled "${child.title.trim()}" — nothing was written. Close the extras first.`,
        )
      if (match[0] !== undefined) {
        have.set(child.key, { number: match[0].number, id: match[0].id })
      }
    }
  } catch (err) {
    return stop(`the parent's sub-issues could not be read: ${errorMessage(err)}`)
  }

  /** Children created by an earlier call whose response was lost, found by their marker. */
  async function adoptMarked(): Promise<void> {
    const missing = plan.children.filter((c) => !have.has(c.key))
    if (missing.length === 0) return
    const listed = (await github.listIssuesSince(since)).sort((a, b) => a.number - b.number)
    for (const child of missing) {
      const marker = splitMarker(waitId, child.key)
      const found = listed.find((i) => i.body.includes(marker))
      if (found !== undefined) have.set(child.key, { number: found.number })
    }
  }
  try {
    await adoptMarked()
  } catch (err) {
    return stop(`the issues opened since this wait started could not be listed: ${errorMessage(err)}`)
  }

  const numberOf = (key: string) => have.get(key)!.number
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
  const same = (a: string, b: string) => a.replace(/\r\n/g, '\n').trimEnd() === b.replace(/\r\n/g, '\n').trimEnd()

  /** An adopted child is the approved one only if its body and kind label are: write what is not, read it back. */
  async function repair(child: SplitPlanInput['children'][number], number: number, body: string): Promise<StepStatus> {
    const current = await github.getIssue(number)
    const labels = current.labels.map((l) => l.name)
    const bodyOk = same(current.body, body)
    const labelOk = labels.includes(child.kind)
    if (bodyOk && labelOk) return 'skipped'
    if (!bodyOk) await github.updateBody(number, body)
    if (!labelOk) await github.setLabels(number, [...labels, child.kind])
    const after = await github.getIssue(number)
    if (!same(after.body, body) || !after.labels.some((l) => l.name === child.kind))
      throw new Error(`#${number} does not carry the approved body and kind on read-back`)
    return 'done'
  }

  async function writeDoneWhen(): Promise<StepStatus> {
    const numbers = plan.children.map((c) => numberOf(c.key))
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
    ...plan.children.map((child) => ({
      name: `create ${child.key}`,
      run: async (): Promise<StepStatus> => {
        const body = expectedBody(child)
        const existing = have.get(child.key)
        if (existing !== undefined) return repair(child, existing.number, body)
        try {
          const opened = await github.createIssue({ title: child.title.trim(), body, labels: [child.kind] })
          have.set(child.key, { number: opened.number })
        } catch (err) {
          // A timed-out create is not proof of absence: look before failing.
          await adoptMarked()
          if (!have.has(child.key)) throw err
          return repair(child, numberOf(child.key), body)
        }
        return 'done'
      },
    })),
    ...plan.children.map((child) => ({
      name: `attach ${child.key}`,
      run: async (): Promise<StepStatus> => {
        return ensure(
          () => github.listSubIssues(options.issue),
          () => github.addSubIssue(options.issue, numberOf(child.key)),
          numberOf(child.key),
        )
      },
    })),
    ...plan.blockedBy.map((d) => ({
      name: `chain ${d.ticket}←${d.blockedBy}`,
      run: () =>
        ensure(
          () => github.listBlockedBy(numberOf(d.ticket)),
          () => github.addBlockedBy(numberOf(d.ticket), numberOf(d.blockedBy)),
          numberOf(d.blockedBy),
        ),
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
      // Every child is a sub-issue by now, and that listing is where GitHub's
      // `id` comes from: no create call returns one.
      name: 'record the split',
      run: async (): Promise<StepStatus> => {
        const subs = (await github.listSubIssues(options.issue)).filter(here)
        payload = {
          waitId,
          children: plan.children.map((c) => {
            const sub = subs.find((s) => s.number === numberOf(c.key))
            if (sub === undefined) throw new Error(`#${numberOf(c.key)} is not a sub-issue on read-back`)
            return { key: c.key, number: sub.number, id: sub.id }
          }),
          blockedBy: plan.blockedBy,
        }
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
  const known = () => plan.children.filter((c) => have.has(c.key)).map((c) => ({ key: c.key, number: numberOf(c.key) }))

  for (const [i, action] of actions.entries()) {
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
        result = { ok: false, ticketId, detail: `${action.name}: ${outcome.detail}`, steps, children: known() }
        break
      }
    } catch (err) {
      steps[i]!.status = 'failed'
      steps[i]!.detail = errorMessage(err)
      if (action.name === 'end the wait') {
        steps[i - 1]!.status = 'failed'
        steps[i - 1]!.detail = errorMessage(err)
      }
      result = {
        ok: false,
        ticketId,
        detail: `${action.name} failed: ${errorMessage(err)}. Nothing was recorded — call again to write what is missing.`,
        steps,
        children: known(),
      }
      break
    }
  }

  return result ?? { ok: true, ticketId, detail: 'split written, and back in the queue', steps, children: known() }
}
