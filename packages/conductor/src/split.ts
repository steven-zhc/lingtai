/**
 * Reconciling an approved split against GitHub (#561, 0118 §12).
 *
 * **GitHub is the truth and the log keeps what was seen.** A retry reads what
 * exists, writes only what is missing, and reads again; the `SplitReconciled`
 * it appends carries what that last read returned — never what a write said.
 * A write that threw (a timeout, a 5xx, or a 422 because the link was already
 * there) is unknown, not failed and not done, so it is not inferred either way.
 *
 * Order is children, then sub-issue attachments, then blocked-by edges, and the
 * first write that throws stops the writing. Children are made with the
 * `agent:hold` label: they exist before their links do, and a dependent child
 * the queue could claim in that gap would be taken ahead of its blocker (#131).
 * Removing the hold, the parent's epic label and its exclusion from the queue
 * are `WaitResolved{Split}`'s (#562). Children left behind by an abandoned
 * split stay held, and nothing here cleans them up.
 */
import { createHash } from 'node:crypto'

import { type PayloadOf, type ToAppend, type WaitId } from '@lingtai/domain'
import { type SplitObserved, type SplitOwed, type SplitPlan, splitOwed } from '@lingtai/domain/wait'
import { type EventStore } from '@lingtai/event-store'
import type { GitHubClient, IssueId } from '@lingtai/github'

/** The held label every child is created with, until #562 lifts it. */
export const SPLIT_HOLD_LABEL = 'agent:hold'

/** The GitHub verbs a split uses: tickets with their internal ids, and the four links. */
export type SplitPort = Pick<
  GitHubClient,
  | 'listIssuesSince'
  | 'createIssue'
  | 'comment'
  | 'closeIssue'
  | 'subIssues'
  | 'addSubIssue'
  | 'blockedBy'
  | 'addBlockedBy'
  | 'removeSubIssue'
  | 'removeBlockedBy'
>

/**
 * Which plan a marker belongs to: a hash of the keys, titles, bodies, kinds and
 * edges. A child made under a superseded plan (a create that timed out and only
 * became visible later) carries the old hash, so a replacement plan never
 * adopts it as its own child — it is left behind, held, like any abandoned one.
 */
export function splitPlanHash(plan: SplitPlan): string {
  const canonical = JSON.stringify([
    plan.children.map((c) => [c.key, c.title, c.body, c.kind]),
    plan.blockedBy.map((d) => [d.ticket, d.blockedBy]),
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

/** How a GitHub issue says which child of which plan of which split it is. Invisible when rendered. */
export function splitMarker(parent: number, waitId: string, plan: SplitPlan, key: string): string {
  return `<!-- lingtai:split ${parent} ${waitId} ${splitPlanHash(plan)} ${key} -->`
}

/** Clocks disagree; see `ticket-store.ts`'s `SKEW_MS`, which this is the same hour as. */
const SKEW_MS = 60 * 60_000

export interface ReconcileSplitOptions {
  port: SplitPort
  store: EventStore
  ticketId: string
  /** The parent's issue number. */
  parent: number
  waitId: WaitId
  by: string
  /** The plan fixed at the wait's first `SplitStarted`. */
  plan: SplitPlan
  /** When that `SplitStarted` was appended; no child is older than it. */
  startedAt: Date
}

export interface ReconcileSplitResult {
  observed: SplitObserved
  owed: SplitOwed
  failure: string | null
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function reconcileSplit(options: ReconcileSplitOptions): Promise<ReconcileSplitResult> {
  const { port, plan, parent, waitId } = options
  const since = new Date(options.startedAt.getTime() - SKEW_MS)

  /**
   * Each child's issue, found by marker — the oldest match is the child's —
   * and the newer open ones, which are duplicates still to be withdrawn.
   */
  async function findChildren(): Promise<{
    found: Map<string, { number: number; id: IssueId }>
    duplicates: { number: number; of: number }[]
    /** Every issue carrying a child's marker that is not the child, open or closed. */
    extras: { number: number; id: IssueId }[]
  }> {
    const issues = await port.listIssuesSince(since)
    const found = new Map<string, { number: number; id: IssueId }>()
    const duplicates: { number: number; of: number }[] = []
    const extras: { number: number; id: IssueId }[] = []
    for (const child of plan.children) {
      const marker = splitMarker(parent, waitId, plan, child.key)
      const [oldest, ...rest] = issues.filter((i) => i.body.includes(marker)).sort((a, b) => a.number - b.number)
      if (oldest === undefined) continue
      found.set(child.key, { number: oldest.number, id: oldest.id })
      for (const extra of rest) {
        extras.push({ number: extra.number, id: extra.id })
        if (extra.state === 'open') duplicates.push({ number: extra.number, of: oldest.number })
      }
    }
    return { found, duplicates, extras }
  }

  /**
   * Links a withdrawn duplicate still holds: closing an issue detaches nothing,
   * so a duplicate that was attached or made a blocker before it was withdrawn
   * is still a native sub-issue and a blocker until it is unlinked.
   */
  async function strayLinks(): Promise<{
    subs: IssueId[]
    edges: { issue: number; blocker: IssueId }[]
  }> {
    const { found, extras } = await findChildren()
    if (extras.length === 0) return { subs: [], edges: [] }
    const ids = new Set(extras.map((e) => e.id as number))
    const subs = (await port.subIssues(parent)).filter((i) => ids.has(i.id)).map((i) => i.id)
    const edges: { issue: number; blocker: IssueId }[] = []
    for (const ticket of new Set(plan.blockedBy.map((d) => d.ticket))) {
      const dependent = found.get(ticket)
      if (dependent === undefined) continue
      for (const b of await port.blockedBy(dependent.number))
        if (ids.has(b.id)) edges.push({ issue: dependent.number, blocker: b.id })
    }
    // A duplicate that was itself made a dependent (replacement b blocked by a)
    // keeps that blocker after it is closed. What blocks it is ours to remove
    // when the blocker is one of this split's issues, kept or withdrawn.
    const ours = new Set([...ids, ...[...found.values()].map((f) => f.id as number)])
    for (const extra of extras)
      for (const b of await port.blockedBy(extra.number))
        if (ours.has(b.id)) edges.push({ issue: extra.number, blocker: b.id })
    return { subs, edges }
  }

  /** Withdraws a newer duplicate in favour of the older issue that is the child. */
  async function withdraw(duplicate: number, kept: number): Promise<void> {
    await port.comment(
      duplicate,
      `Duplicate of #${kept} — two reconciles of the same split opened this child at once, and the older one is kept.`,
    )
    await port.closeIssue(duplicate, 'not_planned')
  }

  /** Reads everything, recording each part only once its GET has returned. */
  async function readBack(into: SplitObserved): Promise<void> {
    const { found } = await findChildren()
    into.children = plan.children.flatMap((c) => {
      const at = found.get(c.key)
      return at === undefined ? [] : [{ key: c.key, number: at.number, id: at.id }]
    })

    // By id: an issue number is only unique within its repository, and a
    // sub-issue from another one may carry the same number as a child.
    const attached = new Set((await port.subIssues(parent)).map((i) => i.id as number))
    into.subIssues = into.children.filter((c) => attached.has(c.id)).map((c) => c.key)

    const idOf = new Map(into.children.map((c) => [c.key, c.id as number]))
    const edges: SplitObserved['blockedBy'] = []
    for (const ticket of new Set(plan.blockedBy.map((d) => d.ticket))) {
      const dependent = into.children.find((c) => c.key === ticket)
      if (dependent === undefined) continue
      const blockers = new Set((await port.blockedBy(dependent.number)).map((i) => i.id as number))
      for (const d of plan.blockedBy)
        if (d.ticket === ticket && blockers.has(idOf.get(d.blockedBy) ?? -1)) edges.push({ ...d })
    }
    into.blockedBy = edges
  }

  // 1. Read.
  const before: SplitObserved = { children: [], subIssues: [], blockedBy: [] }
  const issues = new Map<string, { number: number; id: IssueId }>()
  let failure: string | null = null
  let readable = true
  try {
    await readBack(before)
    for (const c of before.children) issues.set(c.key, { number: c.number, id: c.id as IssueId })
  } catch (err) {
    readable = false
    failure = `read failed before any write: ${messageOf(err)}`
  }

  // 2. Write what is missing; the first throw stops it.
  if (readable) {
    try {
      // A duplicate left by an earlier attempt — a create that timed out and
      // became visible after a retry made another — is withdrawn first, so a
      // withdrawal that failed is tried again rather than forgotten.
      for (const d of (await findChildren()).duplicates) await withdraw(d.number, d.of)
      const stray = await strayLinks()
      for (const id of stray.subs) await port.removeSubIssue(parent, id)
      for (const e of stray.edges) await port.removeBlockedBy(e.issue, e.blocker)
      for (const child of plan.children) {
        if (issues.has(child.key)) continue
        const marker = splitMarker(parent, waitId, plan, child.key)
        const opened = await port.createIssue({
          title: child.title,
          body: `${child.body.trimEnd()}\n\n${marker}\n`,
          labels: [...new Set([child.kind, SPLIT_HOLD_LABEL])],
        })
        // Look again: a call that raced this one may have opened its own. The
        // older issue is the child, so the newer withdraws.
        const first = (await findChildren()).found.get(child.key)
        if (first !== undefined && first.number < opened.number) {
          await withdraw(opened.number, first.number)
          issues.set(child.key, first)
        } else {
          issues.set(child.key, { number: opened.number, id: opened.id })
        }
      }

      const attached = new Set(before.subIssues)
      for (const child of plan.children) {
        if (attached.has(child.key)) continue
        await port.addSubIssue(parent, issues.get(child.key)!.id)
      }

      const have = new Set(before.blockedBy.map((d) => JSON.stringify([d.ticket, d.blockedBy])))
      for (const d of plan.blockedBy) {
        if (have.has(JSON.stringify([d.ticket, d.blockedBy]))) continue
        await port.addBlockedBy(issues.get(d.ticket)!.number, issues.get(d.blockedBy)!.id)
      }
    } catch (err) {
      failure = messageOf(err)
    }
  }

  // 3. Read everything again — also after a write threw. What it returned is
  // what is recorded; an item it did not get to read is owed, never present.
  const observed: SplitObserved = { children: [], subIssues: [], blockedBy: [] }
  try {
    await readBack(observed)
    // A duplicate still open is a split that is not whole, whatever else was seen.
    const open = (await findChildren()).duplicates
    if (open.length > 0)
      failure = `${failure === null ? '' : `${failure}; `}duplicate children still open: ${open.map((d) => `#${d.number}`).join(', ')}`
    const stray = await strayLinks()
    if (stray.subs.length + stray.edges.length > 0)
      failure = `${failure === null ? '' : `${failure}; `}duplicate children still linked: ${stray.subs.length} sub-issue(s), ${stray.edges.length} blocked-by edge(s)`
  } catch (err) {
    failure = `${failure === null ? '' : `${failure}; `}read-back failed: ${messageOf(err)}`
  }

  // 4. Record it.
  const event: ToAppend<PayloadOf<'SplitReconciled'>> = {
    type: 'SplitReconciled',
    actor: options.by,
    data: { waitId, observed, failure },
  }
  const version = (await options.store.read(options.ticketId)).length
  await options.store.append(options.ticketId, version, [event])

  return { observed, owed: splitOwed(plan, observed), failure }
}
