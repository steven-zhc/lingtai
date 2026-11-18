import { localDay, lockSentence, type Lock } from '@lingtai/domain'

import type { BlockedSkip } from './blockers.ts'
import type { BaseRedLook } from './base-red.ts'

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
  | 'unknown'

export interface Root {
  root: RootKind
  sentence: string
  /** The queued tickets this root holds. */
  tickets: number[]
  /** For `lock`, the lock, so a reader can draw it its own way. */
  lock?: Lock
}

export interface WhyNothingRuns {
  /** Most tickets first. */
  roots: Root[]
}

/** How far a chain is followed. */
export const CHAIN_HOPS_MOST = 10
/** *One look*: a row left `running` this recently means something is in flight. */
export const IN_FLIGHT_WITHIN_MS = 5 * 60_000

const HELD_REASONS = new Set(['blocked-by', 'base-red'])

/** The queued tickets nobody has put on hold: offered, or skipped for something that will clear on its own. */
export function unheldQueued(facts: Pick<WhyFacts, 'offered' | 'skipped'>): number[] {
  return [...new Set([...facts.offered, ...facts.skipped.filter((s) => HELD_REASONS.has(s.reason)).map((s) => s.ref)])]
}

/** Whether the sentence shows at all: unheld work queued, and nothing in flight in the last five minutes. */
export function applies(facts: WhyFacts): boolean {
  if (unheldQueued(facts).length === 0) return false
  const at = facts.now.getTime()
  return !facts.rows.some(
    (r) => (r.state === 'running' || r.state === 'verifying') && (r.updatedAt === null || at - r.updatedAt.getTime() < IN_FLIGHT_WITHIN_MS),
  )
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/** Installation-wide stops, which hold everything: a daemon that is not up, a drain, a lock. Null when none holds. */
export function rootBeforeChains(facts: WhyFacts): WhyNothingRuns | null {
  if (!applies(facts)) return null
  const tickets = unheldQueued(facts)
  const only = (root: Root): WhyNothingRuns => ({ roots: [root] })
  const b = facts.beacon
  if ('unread' in b)
    return only({ root: 'beacon-unread', sentence: `could not read whether the daemon is running — ${b.unread}`, tickets })
  if ('never' in b || !b.up)
    return only({
      root: 'no-daemon',
      sentence: 'the daemon is not running — lingtai daemon or lingtai service start',
      tickets,
    })
  if (facts.draining)
    return only({ root: 'drain', sentence: 'the daemon is draining and takes nothing new', tickets })
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
  return null
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

type Held = { key: string; kind: RootKind; describe: (n: number) => string; tickets: number[] }

/** Every queued ticket's reason, grouped, most held first. Reads no blockers when `blockers` is null. */
export function whyNothingRuns(facts: WhyFacts, blockers: readonly BlockedSkip[] | null): WhyNothingRuns | null {
  if (!applies(facts)) return null
  const before = rootBeforeChains(facts)
  if (before !== null) return before

  const groups = new Map<string, Held>()
  const add = (key: string, kind: RootKind, describe: (n: number) => string, ticket: number): void => {
    const g = groups.get(key)
    if (g) g.tickets.push(ticket)
    else groups.set(key, { key, kind, describe, tickets: [ticket] })
  }

  // A red base, from the look status already makes.
  const baseRed = facts.skipped.filter((s) => s.reason === 'base-red').map((s) => s.ref)
  const look = facts.base
  for (const ref of baseRed) {
    if (look !== null && 'held' in look)
      add(
        'base-red',
        'base-red',
        (n) =>
          `${look.held.base} is red at ${look.held.baseSha.slice(0, 7)} (\`${look.held.command}\`); ${plural(n, 'ticket waits', 'tickets wait')} for it`,
        ref,
      )
    else if (look !== null && 'unreadable' in look)
      add(
        'base-unreadable',
        'base-unreadable',
        (n) => `the base could not be read — ${look.unreadable}; ${plural(n, 'ticket waits', 'tickets wait')} for it`,
        ref,
      )
    else add('base-red', 'base-red', (n) => `${plural(n, 'ticket waits', 'tickets wait')} for a red base`, ref)
  }

  // A chain, followed over what the one read returned: no hop makes a read of its own.
  const blocked = facts.skipped.filter((s) => s.reason === 'blocked-by').map((s) => s.ref)
  const byRef = new Map((blockers ?? []).map((s) => [s.ref, s]))
  const said = (n: number, one: string, many: string) => plural(n, one, many)
  for (const ref of blocked) {
    const start = byRef.get(ref)
    if (!facts.canListBlockers || start === undefined) {
      add('unlistable', 'blockers-unlistable', (n) => `${said(n, 'ticket waits', 'tickets wait')} on blockers this project cannot list`, ref)
      continue
    }
    const seen: number[] = []
    let at: BlockedSkip = start
    let verdict: { key: string; kind: RootKind; describe: (n: number) => string } | null = null
    for (let hops = 0; verdict === null; hops++) {
      seen.push(at.ref)
      if (at.unread) {
        const through = seen.map((r) => `#${r}`).join(', ')
        verdict =
          at === start
            ? {
                key: 'past-cap',
                kind: 'blockers-unread',
                describe: (n) => `${said(n, 'ticket waits', 'tickets wait')} on a blocker past the cap of what this reads`,
              }
            : {
                key: `long:${through}`,
                kind: 'chain-long',
                describe: (n) => `${said(n, 'ticket waits', 'tickets wait')} on a chain longer than this reads, through ${through}`,
              }
        break
      }
      const read = at.blockers
      if (read === null) {
        verdict = {
          key: 'unlistable',
          kind: 'blockers-unlistable',
          describe: (n) => `${said(n, 'ticket waits', 'tickets wait')} on blockers this project cannot list`,
        }
        break
      }
      if (!read.ok) {
        const problem = read.problem
        verdict = {
          key: `unread:${problem}`,
          kind: 'blockers-unread',
          describe: (n) => `${said(n, 'ticket waits', 'tickets wait')} on a blocker that could not be read — ${problem}`,
        }
        break
      }
      const open = read.issues.filter((i) => i.state === 'open')
      const next = open[0]
      if (next === undefined) {
        verdict =
          at === start
            ? {
                key: 'closed',
                kind: 'blockers-closed',
                describe: (n) => `${said(n, 'ticket was', 'tickets were')} held by blockers that have since closed`,
              }
            : rootVerdict(at.ref, facts)
        break
      }
      if (facts.repository !== null && next.repository !== facts.repository) {
        verdict = {
          key: `foreign:${next.repository}#${next.number}`,
          kind: 'chain',
          describe: (n) => `${said(n, 'ticket waits', 'tickets wait')} on ${next.repository}#${next.number}, a blocker that is not a ticket here`,
        }
        break
      }
      const hop = byRef.get(next.number)
      if (hop === undefined) {
        verdict = rootVerdict(next.number, facts)
        break
      }
      if (seen.includes(hop.ref)) {
        const loop = [...seen.slice(seen.indexOf(hop.ref)), hop.ref].map((r) => `#${r}`).join(' → ')
        verdict = {
          key: `cycle:${[...seen.slice(seen.indexOf(hop.ref))].sort((a, b) => a - b).join(',')}`,
          kind: 'chain-cycle',
          describe: (n) => `${said(n, 'ticket waits', 'tickets wait')} on a cycle: ${loop}`,
        }
        break
      }
      if (hops + 1 > CHAIN_HOPS_MOST) {
        const through = seen.map((r) => `#${r}`).join(', ')
        verdict = {
          key: `long:${through}`,
          kind: 'chain-long',
          describe: (n) => `${said(n, 'ticket waits', 'tickets wait')} on a chain longer than this reads, through ${through}`,
        }
        break
      }
      at = hop
    }
    add(verdict.key, verdict.kind, verdict.describe, ref)
  }

  // Everything runnable waiting out its retry.
  const wasRunnable = facts.offered.filter((r) => !baseRed.includes(r))
  if (wasRunnable.length > 0 && facts.runnable.length === 0) {
    const held = wasRunnable.map((r) => facts.rows.find((row) => row.ref === r)?.heldUntil ?? null)
    if (held.every((h) => h !== null)) {
      const first = held.reduce((a, b) => (a!.getTime() <= b!.getTime() ? a : b))!
      for (const r of wasRunnable)
        add('backoff', 'backoff', () => `every queued ticket waits out its retry; the first at ${clock(first)}`, r)
    }
  }

  // Whatever is unheld and unexplained is said as such, never hidden.
  const explained = new Set([...groups.values()].flatMap((g) => g.tickets))
  for (const ref of unheldQueued(facts))
    if (!explained.has(ref))
      add('unknown', 'unknown', (n) => `nothing runs, and no reason was found (${plural(n, 'ticket', 'tickets')} queued)`, ref)

  const roots = [...groups.values()]
    .map((g): Root => ({ root: g.kind, sentence: g.describe(g.tickets.length), tickets: g.tickets }))
    .sort((a, b) => b.tickets.length - a.tickets.length)
  return roots.length === 0 ? null : { roots }
}

function rootVerdict(root: number, facts: WhyFacts) {
  const state = stateOf(root, facts)
  return {
    key: `root:${root}`,
    kind: 'chain' as RootKind,
    describe: (n: number) => `${plural(n, 'ticket waits', 'tickets wait')} on #${root}, which ${state}`,
  }
}
