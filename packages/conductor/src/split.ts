/**
 * Reconciling an approved split against GitHub (#561, 0118 §12).
 *
 * **Lingtai never closes, unlinks or withdraws an issue here.** A duplicate is
 * made structurally unlikely, and when one appears anyway it is a `stray`: named
 * on the event, blocking completion, and closed by a person.
 *
 * **A child's identity is the one the log recorded; the body marker is a hint.**
 * A recorded key is read back by number and checked by id — never searched for
 * by marker, never adopted, never created. Only a key the log has nothing for is
 * looked for by marker, which is what finds a create that timed out but landed.
 *
 * **The first write that throws stops all writing for the attempt.** A timeout,
 * a 5xx and a 422 alike: the outcome is unknown, neither done nor failed, and
 * the next attempt's read decides it. So a key is only created when the log has
 * no identity for it *and* a listing in the same attempt found no marker for it,
 * and two creates for one key are separated by a listing that saw nothing.
 *
 * Only links to recorded identities are written, so a stray never carries one.
 * What is appended is what this attempt's GETs returned, never what a write was
 * told; an item the read-back did not reach is owed, never present.
 *
 * The residue, not engineered against: the process dies between a 201 and the
 * append, *and* a person deletes that child's marker before the next attempt.
 * The retry then makes a second child.
 *
 * Children are created with `agent:hold`: a dependent child the queue could
 * claim before its edge exists would be taken ahead of its blocker (#131).
 * Lifting the hold, the parent's exclusion and `WaitResolved{Split}` are #562's.
 */
import { createHash } from 'node:crypto'

import { type PayloadOf, type ToAppend, type WaitId } from '@lingtai/domain'
import {
  type SplitIdentity,
  type SplitObserved,
  type SplitOwed,
  type SplitPlan,
  type SplitStray,
  splitOwed,
} from '@lingtai/domain/wait'
import { ConcurrencyError, type EventStore } from '@lingtai/event-store'
import type { GitHubClient, IssueId } from '@lingtai/github'

/** The held label every child is created with, until #562 lifts it. */
export const SPLIT_HOLD_LABEL = 'agent:hold'

/** The GitHub verbs a split uses: issues with their internal ids, and the two links. */
export type SplitPort = Pick<
  GitHubClient,
  'getIssue' | 'listIssuesSince' | 'createIssue' | 'subIssues' | 'addSubIssue' | 'blockedBy' | 'addBlockedBy'
>

/** Which plan a marker belongs to: a hash of the keys, titles, bodies, kinds and edges. */
export function splitPlanHash(plan: SplitPlan): string {
  const canonical = JSON.stringify([
    plan.children.map((c) => [c.key, c.title, c.body, c.kind]),
    plan.blockedBy.map((d) => [d.ticket, d.blockedBy]),
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12)
}

/**
 * How a GitHub issue says which child of which plan under which wait it is.
 * Not `lingtai:finding`, whose backlog would treat a child as a finding's
 * duplicate. Invisible when rendered.
 */
export function splitMarker(waitId: string, plan: SplitPlan, key: string): string {
  return `<!-- lingtai:split ${waitId} ${splitPlanHash(plan)} ${key} -->`
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
  strays: SplitStray[]
  owed: SplitOwed
  failure: string | null
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const edgeKey = (ticket: string, blockedBy: string): string => JSON.stringify([ticket, blockedBy])

export async function reconcileSplit(options: ReconcileSplitOptions): Promise<ReconcileSplitResult> {
  const { port, plan, parent, waitId } = options
  const since = new Date(options.startedAt.getTime() - SKEW_MS)

  /** Recorded identities are never replaced; an unrecorded key gains one once. */
  const identity = new Map<string, SplitIdentity>()
  for (const i of options.identities) if (!identity.has(i.key)) identity.set(i.key, i)

  /** A set: step 1 and the read-back can meet the same fault. */
  const failures = new Set<string>()
  const fail = (note: string): void => {
    failures.add(note)
  }

  /**
   * Lists the plan's markers. An unrecorded key adopts its oldest match, open
   * or closed; any open match that is not a key's child is a stray.
   */
  async function scan(): Promise<SplitStray[]> {
    const issues = await port.listIssuesSince(since)
    const strays: SplitStray[] = []
    for (const child of plan.children) {
      const marker = splitMarker(waitId, plan, child.key)
      const matches = issues.filter((i) => i.body.includes(marker)).sort((a, b) => a.number - b.number)
      if (!identity.has(child.key) && matches[0] !== undefined)
        identity.set(child.key, { key: child.key, number: matches[0].number, id: matches[0].id, via: 'adopted' })
      const own = identity.get(child.key)
      for (const m of matches)
        if (m.state === 'open' && m.id !== own?.id) strays.push({ key: child.key, number: m.number })
    }
    return strays
  }

  /** Reads every recorded child by number; one counts only when the id is the recorded one. */
  async function verifyChildren(): Promise<string[]> {
    const ok: string[] = []
    for (const child of plan.children) {
      const at = identity.get(child.key)
      if (at === undefined) continue
      try {
        const read = await port.getIssue(at.number)
        if (read.id === at.id) ok.push(child.key)
        else fail(`#${at.number} (${child.key}) is no longer the recorded issue`)
      } catch (err) {
        fail(`reading #${at.number} (${child.key}): ${messageOf(err)}`)
      }
    }
    return ok
  }

  async function readLinks(): Promise<{ subIssues: string[]; blockedBy: SplitObserved['blockedBy'] }> {
    const subIssues: string[] = []
    const blockedBy: SplitObserved['blockedBy'] = []
    try {
      const attached = new Set((await port.subIssues(parent)).map((i) => i.id as number))
      for (const child of plan.children)
        if (attached.has(identity.get(child.key)?.id as number)) subIssues.push(child.key)
    } catch (err) {
      fail(`reading sub-issues of #${parent}: ${messageOf(err)}`)
    }
    for (const ticket of new Set(plan.blockedBy.map((d) => d.ticket))) {
      const dependent = identity.get(ticket)
      if (dependent === undefined) continue
      try {
        const blockers = new Set((await port.blockedBy(dependent.number)).map((i) => i.id as number))
        for (const d of plan.blockedBy)
          if (d.ticket === ticket && blockers.has(identity.get(d.blockedBy)?.id as number)) blockedBy.push(d)
      } catch (err) {
        fail(`reading blockers of #${dependent.number}: ${messageOf(err)}`)
      }
    }
    return { subIssues, blockedBy }
  }

  let createUnknown = false
  // 1. Read, then write what is missing. Any failure stops the writing.
  try {
    await scan()
    await verifyChildren()
    const before = await readLinks()
    if (failures.size === 0) {
      for (const child of plan.children) {
        if (identity.has(child.key)) continue
        createUnknown = true
        const opened = await port.createIssue({
          title: child.title,
          body: `${child.body.trimEnd()}\n\n${splitMarker(waitId, plan, child.key)}\n`,
          labels: [...new Set([child.kind, SPLIT_HOLD_LABEL])],
        })
        createUnknown = false
        // A 2xx carries the number and id: recorded at once, so a later throw cannot lose it.
        identity.set(child.key, { key: child.key, number: opened.number, id: opened.id, via: 'created' })
      }
      const attached = new Set(before.subIssues)
      for (const child of plan.children)
        if (!attached.has(child.key)) await port.addSubIssue(parent, identity.get(child.key)!.id as IssueId)
      const have = new Set(before.blockedBy.map((d) => edgeKey(d.ticket, d.blockedBy)))
      for (const d of plan.blockedBy)
        if (!have.has(edgeKey(d.ticket, d.blockedBy)))
          await port.addBlockedBy(identity.get(d.ticket)!.number, identity.get(d.blockedBy)!.id as IssueId)
    }
  } catch (err) {
    fail(messageOf(err))
  }

  // 3. Read everything again, also after a throw. Anything unread is owed.
  let strays: SplitStray[] = []
  let listed = false
  try {
    // A create that timed out but landed is taken up here, so it is recorded.
    strays = await scan()
    listed = true
  } catch (err) {
    fail(`listing issues: ${messageOf(err)}`)
  }
  const children = await verifyChildren()
  const links = await readLinks()
  const observed: SplitObserved = { children, subIssues: links.subIssues, blockedBy: links.blockedBy }

  const failure = failures.size === 0 ? null : [...failures].join('; ')
  const identities = plan.children.flatMap((c) => (identity.has(c.key) ? [identity.get(c.key)!] : []))
  const event: ToAppend<PayloadOf<'SplitReconciled'>> = {
    type: 'SplitReconciled',
    actor: options.by,
    data: { waitId, children: identities, observed, strays, failure, listed, createUnknown },
  }
  // 4. Record it. The decide lock is held, but the projector may append beside us.
  for (let tries = 0; ; tries++) {
    try {
      await options.store.append(options.ticketId, (await options.store.read(options.ticketId)).length, [event])
      break
    } catch (err) {
      if (!(err instanceof ConcurrencyError) || tries >= 3) throw err
    }
  }

  const owed = splitOwed(plan, identities, observed, strays)
  return { identities, observed, strays, owed: failure === null ? owed : { ...owed, complete: false }, failure }
}
