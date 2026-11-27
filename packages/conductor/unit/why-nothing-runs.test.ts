import { describe, expect, it } from 'vitest'

import type { BlockedSkip } from '../src/blockers.ts'
import {
  CHAIN_HOPS_MOST,
  rootBeforeChains,
  whyNothingRuns,
  type WhyFacts,
  type WhyRow,
} from '../src/why-nothing-runs.ts'

const now = new Date(2026, 10, 18, 12, 0, 0)
const REPO = 'o/r'
const facts = (over: Partial<WhyFacts> = {}): WhyFacts => ({
  now,
  beacon: { up: true },
  draining: false,
  locks: [],
  base: null,
  offered: [],
  runnable: [],
  skipped: [],
  rows: [],
  repository: REPO,
  canListBlockers: true,
  ...over,
})
const blocked = (ref: number, ...open: number[]): BlockedSkip => ({
  project: 'p',
  ref,
  title: `t${ref}`,
  kind: 'bug',
  blockedBy: open.length,
  blockers: { ok: true, issues: open.map((n) => ({ repository: REPO, number: n, title: '', state: 'open' as const })) },
  unread: false,
})
const skipBlocked = (...refs: number[]) => refs.map((ref) => ({ ref, reason: 'blocked-by' }))
const row = (over: Partial<WhyRow> & { ref: number }): WhyRow => ({
  state: 'queued',
  updatedAt: null,
  heldUntil: null,
  waiting: false,
  ...over,
})
const says = (f: WhyFacts, b: BlockedSkip[] | null = null) => whyNothingRuns(f, b)?.roots.map((r) => r.sentence)

describe('a recorded refusal (#1477)', () => {
  const detail = 'no lingtai-hook binary at /x/lingtai-hook'
  const refused = { detail, at: new Date(2026, 10, 18, 9, 5, 0) }

  it('is one refused root carrying the detail, never unknown', () => {
    const r = whyNothingRuns(facts({ offered: [1], runnable: [1], rows: [row({ ref: 1 })], refused }), null)
    expect(r?.roots).toHaveLength(1)
    expect(r?.roots[0]).toMatchObject({ root: 'refused' })
    expect(r?.roots[0]?.sentence).toContain(detail)
    expect(r?.roots[0]?.sentence).toContain('09:05')
    expect(r?.roots.some((x) => x.root === 'unknown')).toBe(false)
  })

  it('carries the date of a refusal recorded on an earlier day, and only the time for today', () => {
    const f = (at: Date) => facts({ offered: [1], runnable: [1], rows: [row({ ref: 1 })], refused: { detail, at } })
    const today = whyNothingRuns(f(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 5)), null)
    const yesterday = whyNothingRuns(f(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 5)), null)
    expect(today?.roots[0]?.sentence).toContain('since 00:05 ')
    expect(yesterday?.roots[0]?.sentence).toMatch(/since \d{4}-\d{2}-\d{2} 09:05 /)
    expect(yesterday?.roots[0]?.sentence).not.toBe(today?.roots[0]?.sentence)
  })

  it('is said over a queue that could not be listed, though no row is queued', () => {
    const r = rootBeforeChains(facts({ queueUnseen: true, refused }))
    expect(r?.roots[0]).toMatchObject({ root: 'refused', tickets: [] })
    expect(r?.roots[0]?.sentence).toContain(detail)
    expect(rootBeforeChains(facts({ refused }))).toBeNull()
  })

  it('stands behind a lock', () => {
    const paused = { kind: 'paused' as const, by: 'sam', since: now }
    const r = whyNothingRuns(facts({ offered: [1], runnable: [1], locks: [paused], refused }), null)
    expect(r?.roots[0]?.root).toBe('lock')
  })
})

describe('whyNothingRuns', () => {
  it('names a daemon that is not up, never ran, or could not be read', () => {
    const base = { offered: [1], runnable: [1] }
    expect(says(facts({ ...base, beacon: { up: false } }))?.[0]).toMatch(/daemon is not running/)
    expect(says(facts({ ...base, beacon: { never: true } }))?.[0]).toMatch(/daemon is not running/)
    expect(says(facts({ ...base, beacon: { unread: 'boom' } }))?.[0]).toMatch(/could not read.*boom/)
  })

  it('names a drain, then a lock', () => {
    expect(says(facts({ offered: [1], runnable: [1], draining: true }))?.[0]).toMatch(/draining/)
    const paused = { kind: 'paused' as const, by: 'sam', since: now }
    const r = whyNothingRuns(facts({ offered: [1], runnable: [1], locks: [paused] }), null)
    expect(r?.roots[0]).toMatchObject({ root: 'lock', lock: paused })
    expect(r?.roots[0]?.sentence).toMatch(/see above$/)
    expect(says(facts({ offered: [1], locks: { unread: 'x' } }))?.[0]).toMatch(/could not be read/)
  })

  it('ignores yesterday’s ceiling', () => {
    const ceiling = {
      kind: 'ceiling' as const,
      since: new Date(2026, 10, 17, 9),
      day: '2026-11-17',
      reportedUsd: 1,
      estimatedUsd: 0,
      ceilingUsd: 1,
      until: new Date(2026, 10, 18),
    }
    expect(rootBeforeChains(facts({ offered: [1], runnable: [1], locks: [ceiling] }))).toBeNull()
  })

  it('names a red base and the tickets that wait for it', () => {
    const base = { held: { command: 'pnpm test', baseSha: 'a7148c1ffff', base: 'main', fix: null } }
    const r = says(facts({ base, skipped: [3, 4, 5].map((ref) => ({ ref, reason: 'base-red' })) }))
    expect(r).toEqual(['main is red at a7148c1 (`pnpm test`); 3 tickets wait for it'])
    expect(says(facts({ base: { unreadable: 'no mirror' }, skipped: [{ ref: 3, reason: 'base-red' }] }))).toEqual([
      'the base could not be read — no mirror; 1 ticket waits for it',
    ])
  })

  it('traces a chain to a root that waits on a person', () => {
    const f = facts({
      skipped: skipBlocked(2, 3, 4),
      rows: [row({ ref: 1111, waiting: true })],
    })
    expect(says(f, [blocked(2, 1111), blocked(3, 2), blocked(4, 3)])).toEqual([
      '3 tickets wait on #1111, which waits on you',
    ])
  })

  it('says when a root retries, is on hold, or is not queued here', () => {
    const at = new Date(2026, 10, 18, 14, 20)
    const f = (r: WhyFacts['rows'], skipped: WhyFacts['skipped'] = skipBlocked(2)) => facts({ skipped, rows: r })
    expect(says(f([row({ ref: 9, heldUntil: at })]), [blocked(2, 9)])).toEqual([
      '1 ticket waits on #9, which retries at 14:20',
    ])
    expect(says(f([], [...skipBlocked(2), { ref: 9, reason: 'excluded-label' }]), [blocked(2, 9)])).toEqual([
      '1 ticket waits on #9, which is on hold',
    ])
    expect(says(f([]), [blocked(2, 9)])).toEqual(['1 ticket waits on #9, which is open and not queued here'])
  })

  it('says when every queued ticket waits out its retry', () => {
    const at = new Date(2026, 10, 18, 14, 20)
    const f = facts({ offered: [1, 2], rows: [row({ ref: 1, heldUntil: at }), row({ ref: 2, heldUntil: at })] })
    expect(says(f)).toEqual(['every queued ticket waits out its retry; the first at 14:20'])
  })

  it('groups roots, most held first', () => {
    const f = facts({
      skipped: skipBlocked(2, 3, 4),
      rows: [row({ ref: 8, waiting: true }), row({ ref: 9, waiting: true })],
    })
    const r = whyNothingRuns(f, [blocked(2, 8), blocked(3, 9), blocked(4, 9)])
    expect(r?.roots.map((x) => x.tickets)).toEqual([[3, 4], [2]])
  })

  it('says a failed read, a list it cannot make, a cap and a closed blocker', () => {
    const failed: BlockedSkip = { ...blocked(2), blockers: { ok: false, problem: 'HTTP 502' } }
    expect(says(facts({ skipped: skipBlocked(2) }), [failed])).toEqual([
      '1 ticket waits on a blocker that could not be read — HTTP 502',
    ])
    expect(says(facts({ skipped: skipBlocked(2), canListBlockers: false }), null)).toEqual([
      '1 ticket waits on blockers this project cannot list',
    ])
    expect(says(facts({ skipped: skipBlocked(2) }), [{ ...blocked(2), blockers: null, unread: true }])?.[0]).toMatch(
      /past the cap/,
    )
    const closed: BlockedSkip = {
      ...blocked(2),
      blockers: { ok: true, issues: [{ repository: REPO, number: 9, title: '', state: 'closed' }] },
    }
    expect(says(facts({ skipped: skipBlocked(2) }), [closed])?.[0]).toMatch(/since closed/)
  })

  it('names a cycle', () => {
    const r = says(facts({ skipped: skipBlocked(2, 3) }), [blocked(2, 3), blocked(3, 2)])
    expect(r).toEqual(['2 tickets wait on a cycle: #2 → #3 → #2'])
  })

  it('stops a chain whose root is 11 hops away at the cap and names the tickets it read', () => {
    const refs = Array.from({ length: CHAIN_HOPS_MOST + 1 }, (_, i) => i + 1)
    const chain = refs.map((r) => blocked(r, r + 1))
    const out = whyNothingRuns(facts({ skipped: skipBlocked(...refs) }), chain)
    const long = out?.roots.find((r) => r.root === 'chain-long' && r.tickets.includes(1))
    expect(long?.sentence).toBe(
      `1 ticket waits on a chain longer than this reads, through ${refs.map((r) => `#${r}`).join(', ')}`,
    )
    expect(out?.roots.find((r) => r.root === 'chain')?.tickets).toContain(2)
  })

  it('follows every open blocker, so a shared second blocker is a root of its own', () => {
    const f = facts({ skipped: skipBlocked(2, 3, 4), rows: [row({ ref: 1111, waiting: true })] })
    const r = whyNothingRuns(f, [blocked(2, 21, 1111), blocked(3, 22, 1111), blocked(4, 23, 1111)])
    expect(r?.roots[0]).toMatchObject({ tickets: [2, 3, 4], sentence: '3 tickets wait on #1111, which waits on you' })
  })

  it('puts a red base before chains, and does not count waiting rows as queued', () => {
    const base = { held: { command: 'pnpm test', baseSha: 'a7148c1ffff', base: 'main', fix: null } }
    const skipped = [{ ref: 9, reason: 'base-red' }, ...skipBlocked(2, 3, 4)]
    expect(rootBeforeChains(facts({ base, skipped }))).toBeNull()
    const r = whyNothingRuns(facts({ base, skipped, rows: [row({ ref: 1111, waiting: true })] }), [
      blocked(2, 1111),
      blocked(3, 1111),
      blocked(4, 1111),
    ])
    expect(r?.roots.map((x) => x.root)).toEqual(['chain', 'base-red'])
    const waiting = facts({ offered: [9], rows: [row({ ref: 9, state: 'waiting' })] })
    expect(says(waiting)).toBeUndefined()
  })

  it('says nothing for held tickets only, or while something is in flight', () => {
    expect(says(facts({ skipped: [{ ref: 1, reason: 'excluded-label' }] }))).toBeUndefined()
    const run = (ago: number) =>
      facts({
        offered: [1],
        runnable: [1],
        beacon: { up: false },
        rows: [row({ ref: 2, state: 'running', updatedAt: new Date(now.getTime() - ago * 60_000) })],
      })
    expect(says(run(2))).toBeUndefined()
    expect(says({ ...run(10), beacon: { up: true } })).toBeUndefined()
    // nothing carries an old running row: it is an orphan, and the outage is said
    expect(says(run(10))?.[0]).toMatch(/daemon is not running/)
    // a live `lingtai run` holds the lock and writes no beacon: its old running row is a pass in flight
    expect(says({ ...run(10), conductorHeld: true })).toBeUndefined()
  })

  it('traces a chain through a ticket the red base holds to the base', () => {
    const base = { held: { command: 'pnpm test', baseSha: 'a7148c1ffff', base: 'main', fix: null } }
    const skipped = [{ ref: 9, reason: 'base-red' }, ...skipBlocked(2, 3)]
    const r = whyNothingRuns(facts({ base, skipped }), [blocked(2, 9), blocked(3, 9)])
    expect(r?.roots).toHaveLength(1)
    expect(r?.roots[0]).toMatchObject({
      root: 'base-red',
      sentence: 'main is red at a7148c1 (`pnpm test`); 3 tickets wait for it',
    })
    expect(r?.roots[0]?.tickets.sort()).toEqual([2, 3, 9])
  })

  it('says it found no reason, rather than nothing', () => {
    expect(says(facts({ offered: [1], runnable: [1] }))).toEqual([
      'nothing runs, and no reason was found (1 ticket queued)',
    ])
  })
})
