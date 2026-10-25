/**
 * Reconciling an approved split against GitHub (#561, 0118 §12).
 *
 * **A child's identity is the one the log recorded; the body marker is a hint.**
 * A retry starts from the `{number, id}` pairs earlier `SplitReconciled`s hold
 * (`splitIdentitiesOf`): a recorded key is read back by number, checked by id,
 * and never searched for by marker and never created again — a person may have
 * edited the marker away. Only a key the log has nothing for is looked for by
 * marker, which is what finds a create that timed out but landed. What an
 * attempt appends is the union of those identities plus what its last read
 * returned — never what a write said. A write that threw (a timeout, a 5xx, or
 * a 422 because the link was already there) is unknown, not failed and not
 * done, so it is not inferred either way.
 *
 * What remains: a process that dies after a 201 and before the append, *and* a
 * person who removes the marker before the next attempt, leaves a child the
 * log never heard of, and the retry makes a second. One event per create would
 * close that window; one event per attempt is the identity the operator ruled.
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
import { type SplitIdentity, type SplitObserved, type SplitOwed, type SplitPlan, splitOwed } from '@lingtai/domain/wait'
import { type EventStore } from '@lingtai/event-store'
import type { GitHubClient, IssueId } from '@lingtai/github'

/** The held label every child is created with, until #562 lifts it. */
export const SPLIT_HOLD_LABEL = 'agent:hold'

/** The GitHub verbs a split uses: tickets with their internal ids, and the four links. */
export type SplitPort = Pick<
  GitHubClient,
  | 'listIssuesSince'
  | 'getIssue'
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
  /** What earlier attempts of this split recorded (`splitIdentitiesOf`). */
  identities: readonly SplitIdentity[]
}

export interface ReconcileSplitResult {
  identities: SplitIdentity[]
  observed: SplitObserved
  owed: SplitOwed
  failure: string | null
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

type At = { number: number; id: IssueId }

export async function reconcileSplit(options: ReconcileSplitOptions): Promise<ReconcileSplitResult> {
  const { port, plan, parent, waitId } = options
  const since = new Date(options.startedAt.getTime() - SKEW_MS)

  /** Every identity this attempt holds. Recorded ones are never replaced; a new one is added once. */
  const identity = new Map<string, SplitIdentity>()
  for (const i of options.identities) if (!identity.has(i.key)) identity.set(i.key, i)
  const atOf = (key: string): At => {
    const i = identity.get(key)!
    return { number: i.number, id: i.id as IssueId }
  }

  /**
   * Issues carrying a child's marker. For a recorded key the child is the
   * recorded one, and every match with another id is a duplicate — an older
   * one too, since identity beats age. For a key the log has nothing for, the
   * oldest match is the child (`adopt`) and the newer ones are the duplicates.
   */
  async function findChildren(): Promise<{
    adopt: Map<string, At>
    duplicates: { number: number; of: number }[]
    /** Every issue carrying a child's marker that is not the child, open or closed. */
    extras: At[]
  }> {
    const issues = await port.listIssuesSince(since)
    const adopt = new Map<string, At>()
    const duplicates: { number: number; of: number }[] = []
    const extras: At[] = []
    for (const child of plan.children) {
      const marker = splitMarker(parent, waitId, plan, child.key)
      const matches = issues.filter((i) => i.body.includes(marker)).sort((a, b) => a.number - b.number)
      const recorded = identity.get(child.key)
      const kept = recorded === undefined ? matches[0] : undefined
      if (kept !== undefined) adopt.set(child.key, { number: kept.number, id: kept.id })
      const keptNumber = recorded?.number ?? kept?.number
      for (const extra of matches) {
        if (recorded !== undefined ? extra.id === recorded.id : extra === kept) continue
        extras.push({ number: extra.number, id: extra.id })
        if (extra.state === 'open' && keptNumber !== undefined)
          duplicates.push({ number: extra.number, of: keptNumber })
      }
    }
    return { adopt, duplicates, extras }
  }

  /** Takes up the children a marker found for keys the log has nothing for. */
  function adopt(found: Map<string, At>): void {
    for (const [key, at] of found)
      if (!identity.has(key)) identity.set(key, { key, number: at.number, id: at.id, via: 'adopted' })
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
    const { extras } = await findChildren()
    if (extras.length === 0) return { subs: [], edges: [] }
    const ids = new Set(extras.map((e) => e.id as number))
    const subs = (await port.subIssues(parent)).filter((i) => ids.has(i.id)).map((i) => i.id)
    const edges: { issue: number; blocker: IssueId }[] = []
    for (const ticket of new Set(plan.blockedBy.map((d) => d.ticket))) {
      if (!identity.has(ticket)) continue
      const dependent = atOf(ticket)
      for (const b of await port.blockedBy(dependent.number))
        if (ids.has(b.id)) edges.push({ issue: dependent.number, blocker: b.id })
    }
    // A duplicate that was itself made a dependent (replacement b blocked by a)
    // keeps that blocker after it is closed. What blocks it is ours to remove
    // when the blocker is one of this split's issues, kept or withdrawn.
    const ours = new Set([...ids, ...[...identity.values()].map((i) => i.id)])
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

  /**
   * Reads everything, recording each part only once its GET has returned.
   * Returns what was wrong with a recorded child: it is read by number and
   * counts as verified only if the id it returns is the recorded one.
   */
  async function readBack(into: SplitObserved): Promise<string[]> {
    const notes: string[] = []
    into.children = []
    for (const child of plan.children) {
      const recorded = identity.get(child.key)
      if (recorded === undefined) continue
      try {
        const issue = await port.getIssue(recorded.number)
        if (issue.id !== recorded.id) {
          notes.push(
            `recorded child #${recorded.number} for "${child.key}" is not readable: it is now issue id ${issue.id}, not ${recorded.id}`,
          )
          continue
        }
        into.children.push(child.key)
        if (issue.state === 'closed') notes.push(`recorded child #${recorded.number} for "${child.key}" is closed`)
      } catch (err) {
        notes.push(`recorded child #${recorded.number} for "${child.key}" is not readable: ${messageOf(err)}`)
      }
    }

    // By id: an issue number is only unique within its repository, and a
    // sub-issue from another one may carry the same number as a child.
    const attached = new Set((await port.subIssues(parent)).map((i) => i.id as number))
    into.subIssues = into.children.filter((k) => attached.has(identity.get(k)!.id))

    const edges: SplitObserved['blockedBy'] = []
    for (const ticket of new Set(plan.blockedBy.map((d) => d.ticket))) {
      if (!into.children.includes(ticket)) continue
      const blockers = new Set((await port.blockedBy(identity.get(ticket)!.number)).map((i) => i.id as number))
      for (const d of plan.blockedBy)
        if (d.ticket === ticket && identity.has(d.blockedBy) && blockers.has(identity.get(d.blockedBy)!.id))
          edges.push({ ...d })
    }
    into.blockedBy = edges
    return notes
  }

  // 1. Read.
  const before: SplitObserved = { children: [], subIssues: [], blockedBy: [] }
  let failure: string | null = null
  let readable = true
  try {
    adopt((await findChildren()).adopt)
    await readBack(before)
  } catch (err) {
    readable = false
    failure = `read failed before any write: ${messageOf(err)}`
  }

  // 2. Write what is missing; the first throw stops it.
  if (readable) {
    // A child a link can be written to: read back as itself, or made just now.
    const writable = new Set(before.children)
    try {
      // A duplicate left by an earlier attempt — a create that timed out and
      // became visible after a retry made another — is withdrawn first, so a
      // withdrawal that failed is tried again rather than forgotten.
      for (const d of (await findChildren()).duplicates) await withdraw(d.number, d.of)
      const stray = await strayLinks()
      for (const id of stray.subs) await port.removeSubIssue(parent, id)
      for (const e of stray.edges) await port.removeBlockedBy(e.issue, e.blocker)
      for (const child of plan.children) {
        // Recorded, so it is the child: never searched for, never made again.
        if (identity.has(child.key)) continue
        const marker = splitMarker(parent, waitId, plan, child.key)
        const opened = await port.createIssue({
          title: child.title,
          body: `${child.body.trimEnd()}\n\n${marker}\n`,
          labels: [...new Set([child.kind, SPLIT_HOLD_LABEL])],
        })
        // A 2xx carries the number and id: an accepted write, recorded at once
        // so that no later step, however it throws, can lose it.
        const made: SplitIdentity = { key: child.key, number: opened.number, id: opened.id, via: 'created' }
        identity.set(child.key, made)
        writable.add(child.key)
        // Look again: a call that raced this one may have opened its own, and
        // then the older issue is the child. The lookup runs with the key
        // unrecorded, and the created identity stands if it throws.
        let first: At | undefined
        identity.delete(child.key)
        try {
          first = (await findChildren()).adopt.get(child.key)
        } finally {
          identity.set(child.key, made)
        }
        if (first !== undefined && first.number < opened.number) {
          await withdraw(opened.number, first.number)
          identity.set(child.key, { key: child.key, number: first.number, id: first.id, via: 'adopted' })
        }
      }

      const attached = new Set(before.subIssues)
      for (const child of plan.children) {
        if (attached.has(child.key) || !writable.has(child.key)) continue
        await port.addSubIssue(parent, atOf(child.key).id)
      }

      const have = new Set(before.blockedBy.map((d) => JSON.stringify([d.ticket, d.blockedBy])))
      for (const d of plan.blockedBy) {
        if (have.has(JSON.stringify([d.ticket, d.blockedBy]))) continue
        if (!writable.has(d.ticket) || !writable.has(d.blockedBy)) continue
        await port.addBlockedBy(atOf(d.ticket).number, atOf(d.blockedBy).id)
      }
    } catch (err) {
      failure = messageOf(err)
    }
  }

  // 3. Read everything again — also after a write threw. What it returned is
  // what is recorded; an item it did not get to read is owed, never present.
  const observed: SplitObserved = { children: [], subIssues: [], blockedBy: [] }
  const join = (note: string): void => {
    failure = `${failure === null ? '' : `${failure}; `}${note}`
  }
  // A create that timed out but landed shows up here: take it up before the
  // read-back, so the attempt records it rather than discarding what it saw.
  let listing: Awaited<ReturnType<typeof findChildren>> | null = null
  try {
    listing = await findChildren()
    adopt(listing.adopt)
  } catch (err) {
    join(`read-back failed: ${messageOf(err)}`)
  }
  try {
    for (const note of await readBack(observed)) join(note)
    // A duplicate still open is a split that is not whole, whatever else was seen.
    const open = listing?.duplicates ?? []
    if (open.length > 0) join(`duplicate children still open: ${open.map((d) => `#${d.number}`).join(', ')}`)
    const stray = await strayLinks()
    if (stray.subs.length + stray.edges.length > 0)
      join(
        `duplicate children still linked: ${stray.subs.length} sub-issue(s), ${stray.edges.length} blocked-by edge(s)`,
      )
  } catch (err) {
    join(`read-back failed: ${messageOf(err)}`)
  }

  // 4. Record it: every identity known, in plan order.
  const children = plan.children.flatMap((c) => (identity.has(c.key) ? [identity.get(c.key)!] : []))
  const event: ToAppend<PayloadOf<'SplitReconciled'>> = {
    type: 'SplitReconciled',
    actor: options.by,
    data: { waitId, children, observed, failure },
  }
  const version = (await options.store.read(options.ticketId)).length
  await options.store.append(options.ticketId, version, [event])

  return { identities: children, observed, owed: splitOwed(plan, children, observed), failure }
}
