import { localDay, lockSentence, type Lock } from '@lingtai/domain'
import { Effect } from 'effect'

import type { BaseRedLook } from './base-red.ts'
import type { BlockedSkip } from './blockers.ts'
import { heldUntil } from './queue.ts'

/**
 * Why a project with work queued has nothing running (0122 §8, #1215): one
 * sentence per root, traced from a ticket to the thing that holds it. Pure over
 * the facts it is handed — no agent, no event, no read of its own — so
 * `lingtai status` and the board (#1216) say the same thing.
 *
 * The roots are tried installation-wide first (`rootBeforeChains`), and only
 * when none of those holds does a caller need to read the blockers a chain is
 * followed through (`whyNothingRuns`).
 */

/** What the daemon's beacon said. `never` is a daemon that has never run; `unread` is not *not running*. */
export type Beacon = { up: boolean } | { never: true } | { unread: string }

/** One task row, reduced to what the reasons read. */
export interface WhyRow {
  ref: number
  state: string
  updatedAt: Date | null
  /** When the retry window ends, while it holds the row; else null. */
  heldUntil: Date | null
  waiting: boolean
}

export interface WhyFacts {
  now: Date
  beacon: Beacon
  /** Whether some conductor holds the lock — a daemon or a live `lingtai run`, which writes no beacon. Unknown counts as held. */
  conductorHeld?: boolean
  /** The conductor's recorded refusal of this project (`ProjectState.refused`), null when it has none. */
  refused?: { detail: string; at: Date } | null
  /** A drain stands (`control.shutdown !== null`). */
  draining: boolean
  locks: readonly Lock[] | { unread: string }
  base: BaseRedLook | null
  /** What the ticket source offered as runnable, before the base and the retry window. */
  offered: readonly number[]
  /** What `selectRunnable` left, in order. */
  runnable: readonly number[]
  skipped: readonly { ref: number; reason: string }[]
  rows: readonly WhyRow[]
  /** The repository a blocker's `repository` must equal to be a ticket here; null where unknown. */
  repository: string | null
  /** Whether the project has a way to list blockers at all. */
  canListBlockers: boolean
}

export type RootKind =
  | 'no-daemon'
  | 'beacon-unread'
  | 'drain'
  | 'lock'
  | 'refused'
  | 'locks-unread'
  | 'base-red'
  | 'base-unreadable'
  | 'chain'
  | 'chain-cycle'
  | 'chain-long'
  | 'blockers-unread'
  | 'blockers-unlistable'
  | 'blockers-closed'
  | 'backoff'
  | 'publishing'
  | 'unknown'

export interface Root {
  root: RootKind
  sentence: string
  /** The queued tickets this root holds. */
  tickets: number[]
  /** For `lock`, the lock, so a reader can draw it its own way. */
  lock?: Lock
  /** For a `chain` root: the ticket at its end, and whether it waits on a person — so a reader can link it (#1216). */
  on?: { ref: number; waits: boolean }
}

export interface WhyNothingRuns {
  /** Most tickets first. */
  roots: Root[]
}

/** How far a chain is followed. */
export const CHAIN_HOPS_MOST = 10
/** *One look*: a row left `running` this recently means something is in flight. */
export const IN_FLIGHT_WITHIN_MS = 5 * 60_000

const HELD_REASONS = new Set(['blocked-by', 'publishing', 'base-red'])

/** Offered tickets `selectRunnable` can still take or is holding for a retry: a waiting or finished row is not queued. */
function queuedOffered(facts: Pick<WhyFacts, 'offered' | 'rows'>): number[] {
  return facts.offered.filter((ref) => {
    const row = facts.rows.find((r) => r.ref === ref)
    return row === undefined || row.state === 'queued'
  })
}

/** The queued tickets nobody has put on hold: offered and still queued, or skipped for something that will clear on its own. */
export function unheldQueued(facts: Pick<WhyFacts, 'offered' | 'skipped' | 'rows'>): number[] {
  return [
    ...new Set([...queuedOffered(facts), ...facts.skipped.filter((s) => HELD_REASONS.has(s.reason)).map((s) => s.ref)]),
  ]
}

const flying = (r: WhyRow): boolean => r.state === 'running' || r.state === 'verifying'
/** A flying row touched within the last five minutes (or of unknown age) is a pass in flight whatever the beacon says. */
const freshlyFlying = (r: WhyRow, now: Date): boolean =>
  flying(r) && (r.updatedAt === null || now.getTime() - r.updatedAt.getTime() < IN_FLIGHT_WITHIN_MS)

/**
 * Whether the sentence can still show before the beacon is read: unheld work queued and no row touched
 * within five minutes that is `running` or `verifying`.
 */
export function mayApply(facts: WhyFacts): boolean {
  return unheldQueued(facts).length > 0 && !facts.rows.some((r) => freshlyFlying(r, facts.now))
}

/**
 * The same question, once the beacon is known. A row left `running` longer ago than that is a pass in
 * flight while a conductor lives — a daemon, or a `lingtai run` holding the lock, which writes no beacon;
 * with neither, nothing is carrying it and it is an orphan, which must not silence the explanation.
 */
export function applies(facts: WhyFacts): boolean {
  if (!mayApply(facts)) return false
  const b = facts.beacon
  const daemonUp = 'up' in b && b.up
  const conductorLive = daemonUp || facts.conductorHeld === true
  return !(conductorLive && facts.rows.some(flying))
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** `HH:MM` for today, and the date before it for any other day, so an old refusal does not read as a fresh one. */
const stamp = (at: Date, now: Date): string => {
  const day = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return day(at) === day(now) ? clock(at) : `${day(at)} ${clock(at)}`
}

/** Stops that hold everything this project has queued: a daemon that is not up, a drain, a lock, a refusal. Null when none holds. */
export function rootBeforeChains(facts: WhyFacts): WhyNothingRuns | null {
  if (!applies(facts)) return null
  const tickets = unheldQueued(facts)
  const only = (root: Root): WhyNothingRuns => ({ roots: [root] })
  const b = facts.beacon
  if ('unread' in b)
    return only({
      root: 'beacon-unread',
      sentence: `could not read whether the daemon is running — ${b.unread}`,
      tickets,
    })
  if ('never' in b || !b.up)
    return only({
      root: 'no-daemon',
      sentence: 'the daemon is not running — lingtai daemon or lingtai service start',
      tickets,
    })
  if (facts.draining) return only({ root: 'drain', sentence: 'the daemon is draining and takes nothing new', tickets })
  if ('unread' in facts.locks)
    return only({ root: 'locks-unread', sentence: 'what holds it could not be read — see above', tickets })
  const locks = facts.locks.filter((l) => l.kind !== 'ceiling' || l.day === localDay(facts.now))
  const lock = locks[0]
  if (lock !== undefined) {
    return only({
      root: 'lock',
      sentence: `${lockSentence('', [lock], facts.now) ?? lock.kind} — see above`,
      tickets,
      lock,
    })
  }
  if (facts.refused)
    return only({
      root: 'refused',
      sentence: `the conductor refused this project since ${stamp(facts.refused.at, facts.now)} — ${facts.refused.detail}`,
      tickets,
    })
  return null
}

/** A red or unreadable base, which holds only the tickets skipped for it, so other roots may stand beside it. */
export function baseRoot(facts: WhyFacts, reaching: readonly number[] = []): Root | null {
  const only = (root: Root): Root => root
  const own = facts.skipped.filter((s) => s.reason === 'base-red').map((s) => s.ref)
  const baseRed = [...new Set([...own, ...reaching])]
  if (own.length > 0) {
    const look = facts.base
    const n = baseRed.length
    if (look !== null && 'held' in look)
      return only({
        root: 'base-red',
        sentence: `${look.held.base} is red at ${look.held.baseSha.slice(0, 7)} (\`${look.held.command}\`); ${plural(n, 'ticket waits', 'tickets wait')} for it`,
        tickets: baseRed,
      })
    if (look !== null && 'unreadable' in look)
      return only({
        root: 'base-unreadable',
        sentence: `the base could not be read — ${look.unreadable}; ${plural(n, 'ticket waits', 'tickets wait')} for it`,
        tickets: baseRed,
      })
    return only({
      root: 'base-red',
      sentence: `${plural(n, 'ticket waits', 'tickets wait')} for a red base`,
      tickets: baseRed,
    })
  }
  return null
}

/** Distinct tickets held by the roots after the first and not by the first. */
export function omittedTickets(why: WhyNothingRuns): number {
  const [first, ...rest] = why.roots
  const shown = new Set(first?.tickets ?? [])
  return new Set(rest.flatMap((r) => r.tickets).filter((t) => !shown.has(t))).size
}

/** What the root ticket itself is doing, as the words after *which*. */
function stateOf(ref: number, facts: WhyFacts): string {
  const row = facts.rows.find((r) => r.ref === ref)
  const skip = facts.skipped.find((s) => s.ref === ref)
  if (row?.waiting) return 'waits on you'
  if (row?.heldUntil) return `retries at ${clock(row.heldUntil)}`
  if (skip !== undefined && !HELD_REASONS.has(skip.reason)) return 'is on hold'
  if (row !== undefined && row.state !== 'queued') return `is ${row.state}`
  if (row !== undefined || facts.offered.includes(ref)) return 'is queued'
  return 'is open and not queued here'
}

type Held = {
  key: string
  kind: RootKind
  describe: (n: number) => string
  tickets: number[]
  on?: { ref: number; waits: boolean }
}

/** Every queued ticket's reason, grouped, most held first. Reads no blockers when `blockers` is null. */
export function whyNothingRuns(facts: WhyFacts, blockers: readonly BlockedSkip[] | null): WhyNothingRuns | null {
  if (!applies(facts)) return null
  const before = rootBeforeChains(facts)
  if (before !== null) return before

  const groups = new Map<string, Held>()
  const add = (
    key: string,
    kind: RootKind,
    describe: (n: number) => string,
    ticket: number,
    on?: { ref: number; waits: boolean },
  ): void => {
    const g = groups.get(key)
    if (g) g.tickets.push(ticket)
    else groups.set(key, { key, kind, describe, tickets: [ticket], ...(on === undefined ? {} : { on }) })
  }

  // A chain, followed over what the one read returned: no hop makes a read of its own.
  const blocked = facts.skipped.filter((s) => s.reason === 'blocked-by').map((s) => s.ref)
  const byRef = new Map((blockers ?? []).map((s) => [s.ref, s]))
  type Verdict = { key: string; kind: RootKind; describe: (n: number) => string; on?: { ref: number; waits: boolean } }
  const longThrough = (seen: number[]): Verdict => {
    const through = seen.map((r) => `#${r}`).join(', ')
    return {
      key: `long:${through}`,
      kind: 'chain-long',
      describe: (n) =>
        `${plural(n, 'ticket waits', 'tickets wait')} on a chain longer than this reads, through ${through}`,
    }
  }
  // Every root a ticket reaches, through every open blocker; `seen` is the path so far.
  const visit = (at: BlockedSkip, seen: number[]): Verdict[] => {
    const path = [...seen, at.ref]
    const start = seen.length === 0
    if (at.unread)
      return [
        start
          ? {
              key: 'past-cap',
              kind: 'blockers-unread',
              describe: (n) =>
                `${plural(n, 'ticket waits', 'tickets wait')} on a blocker past the cap of what this reads`,
            }
          : longThrough(path),
      ]
    // The queue's own reason, when it could not release this ticket by what landed on `branch.personal` (#1423): the
    // blockers it re-read are not what held it, so they are not what is said.
    if (start && at.held !== undefined) {
      const held = at.held
      return [
        {
          key: `held:${held}`,
          kind: 'blockers-unread',
          describe: (n) => `${plural(n, 'ticket is', 'tickets are')} held: ${held}`,
        },
      ]
    }
    const read = at.blockers
    if (read === null)
      return [
        {
          key: 'unlistable',
          kind: 'blockers-unlistable',
          describe: (n) => `${plural(n, 'ticket waits', 'tickets wait')} on blockers this project cannot list`,
        },
      ]
    if (!read.ok) {
      const problem = read.problem
      return [
        {
          key: `unread:${problem}`,
          kind: 'blockers-unread',
          describe: (n) =>
            `${plural(n, 'ticket waits', 'tickets wait')} on a blocker that could not be read — ${problem}`,
        },
      ]
    }
    const open = read.issues.filter((i) => i.state === 'open')
    if (open.length === 0)
      return [
        start
          ? {
              key: 'closed',
              kind: 'blockers-closed',
              describe: (n) => `${plural(n, 'ticket was', 'tickets were')} held by blockers that have since closed`,
            }
          : rootVerdict(at.ref, facts),
      ]
    // The edge to the next ticket is hop number `path.length`; past the cap it is not taken, root or not.
    if (path.length > CHAIN_HOPS_MOST) return [longThrough(path)]
    const out: Verdict[] = []
    for (const next of open) {
      if (facts.repository !== null && next.repository !== facts.repository) {
        out.push({
          key: `foreign:${next.repository}#${next.number}`,
          kind: 'chain',
          describe: (n) =>
            `${plural(n, 'ticket waits', 'tickets wait')} on ${next.repository}#${next.number}, a blocker that is not a ticket here`,
        })
        continue
      }
      const hop = byRef.get(next.number)
      if (hop === undefined) {
        out.push(rootVerdict(next.number, facts))
        continue
      }
      if (path.includes(hop.ref)) {
        const cycle = path.slice(path.indexOf(hop.ref))
        const loop = [...cycle, hop.ref].map((r) => `#${r}`).join(' → ')
        out.push({
          key: `cycle:${[...cycle].sort((a, b) => a - b).join(',')}`,
          kind: 'chain-cycle',
          describe: (n) => `${plural(n, 'ticket waits', 'tickets wait')} on a cycle: ${loop}`,
        })
        continue
      }
      out.push(...visit(hop, path))
    }
    return out
  }
  for (const ref of blocked) {
    const start = byRef.get(ref)
    if (!facts.canListBlockers || start === undefined) {
      add(
        'unlistable',
        'blockers-unlistable',
        (n) => `${plural(n, 'ticket waits', 'tickets wait')} on blockers this project cannot list`,
        ref,
      )
      continue
    }
    const seenKeys = new Set<string>()
    for (const v of visit(start, [])) {
      if (seenKeys.has(v.key)) continue
      seenKeys.add(v.key)
      add(v.key, v.kind, v.describe, ref, v.on)
    }
  }

  // A split's children are passed over until the split is read back; it comes back on its own.
  for (const s of facts.skipped.filter((s) => s.reason === 'publishing'))
    add(
      'publishing',
      'publishing',
      (n) =>
        `${plural(n, 'ticket is', 'tickets are')} a split's ${n === 1 ? 'child' : 'children'} still being published`,
      s.ref,
    )

  // Everything runnable waiting out its retry.
  const wasRunnable = queuedOffered(facts)
  if (wasRunnable.length > 0 && facts.runnable.length === 0) {
    const held = wasRunnable.map((r) => facts.rows.find((row) => row.ref === r)?.heldUntil ?? null)
    if (held.every((h) => h !== null)) {
      const first = held.reduce((a, b) => (a!.getTime() <= b!.getTime() ? a : b))!
      for (const r of wasRunnable)
        add('backoff', 'backoff', () => `every queued ticket waits out its retry; the first at ${clock(first)}`, r)
    }
  }

  // Whatever is unheld and unexplained is said as such, never hidden.
  const explained = new Set([...[...groups.values()].flatMap((g) => g.tickets), ...(baseRoot(facts)?.tickets ?? [])])
  for (const ref of unheldQueued(facts))
    if (!explained.has(ref))
      add(
        'unknown',
        'unknown',
        (n) => `nothing runs, and no reason was found (${plural(n, 'ticket', 'tickets')} queued)`,
        ref,
      )

  const reaching = groups.get('base')?.tickets ?? []
  groups.delete('base')
  const base = baseRoot(facts, reaching)
  const roots = [
    ...(base === null ? [] : [base]),
    ...[...groups.values()].map((g): Root => ({
      root: g.kind,
      sentence: g.describe(g.tickets.length),
      tickets: g.tickets,
      ...(g.on === undefined ? {} : { on: g.on }),
    })),
  ].sort((a, b) => b.tickets.length - a.tickets.length)
  return roots.length === 0 ? null : { roots }
}

function rootVerdict(root: number, facts: WhyFacts) {
  // A root held by the red base is not a ticket's own state: the chain goes on to the base itself.
  if (facts.skipped.some((s) => s.ref === root && s.reason === 'base-red'))
    return { key: 'base', kind: 'base-red' as RootKind, describe: (_n: number) => '' }
  const state = stateOf(root, facts)
  return {
    key: `root:${root}`,
    kind: 'chain' as RootKind,
    describe: (n: number) => `${plural(n, 'ticket waits', 'tickets wait')} on #${root}, which ${state}`,
    on: { ref: root, waits: facts.rows.find((r) => r.ref === root)?.waiting === true },
  }
}

/** What `explainQueueEffect` reads, each only when the sentence can still show. */
export interface WhyReads<E> {
  beacon: Effect.Effect<Beacon, E>
  /** Whether some conductor holds the lock; a failed read is the caller's to turn into `true`. */
  conductorHeld: Effect.Effect<boolean>
  /** The blockers a chain is followed through; null where none are needed or listable. */
  blockers: Effect.Effect<readonly BlockedSkip[] | null, E>
}

/**
 * The order the sentence is gathered in, written once for `lingtai status` and the board (#1216): it
 * can show at all (`mayApply`), then the beacon and the conductor lock, then the roots that need no
 * blockers (`rootBeforeChains`), and only then the blockers. A live conductor that suppresses the
 * sentence reads no blockers for it.
 */
export const explainQueueEffect = <E>(facts: WhyFacts, reads: WhyReads<E>): Effect.Effect<WhyNothingRuns | null, E> =>
  Effect.gen(function* () {
    if (!mayApply(facts)) return null
    const beacon = yield* reads.beacon
    const conductorHeld = yield* reads.conductorHeld
    const withBeacon: WhyFacts = { ...facts, beacon, conductorHeld }
    const before = rootBeforeChains(withBeacon)
    if (before !== null || !applies(withBeacon)) return before
    return whyNothingRuns(withBeacon, yield* reads.blockers)
  })

/** One task row, as the reasons read it: the one place `task_view`'s rows are reduced for them. */
export function whyRows(
  tasks: readonly {
    issue: string
    state: string
    updatedAt?: Date | null
    lastAttemptAt?: Date | null
    repairPending?: boolean
    wait?: unknown
  }[],
  backoffMs: number,
  now: number,
): WhyRow[] {
  return tasks.map((t) => ({
    ref: Number(t.issue),
    state: t.state,
    updatedAt: t.updatedAt ?? null,
    heldUntil:
      t.state === 'queued'
        ? heldUntil({ lastAttemptAt: t.lastAttemptAt ?? null, repairPending: t.repairPending === true }, backoffMs, now)
        : null,
    waiting: t.wait != null,
  }))
}
