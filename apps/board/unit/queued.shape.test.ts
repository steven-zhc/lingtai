/**
 * The facts the queued panel speaks from (#910): the ticket's kind and the
 * recipe's kind order, what is behind it, what is running and the slots, and
 * the chip and sentence made of them. All pure, or pure over stubbed reads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@lingtai/conductor/projects', () => ({ loadProject: vi.fn(async () => ({ name: 'p' })) }))
vi.mock('@lingtai/conductor/discover', () => ({ runnableNow: vi.fn() }))
vi.mock('@lingtai/conductor/filter', () => ({
  projectFilter: vi.fn(),
  stepPlan: vi.fn(),
}))
vi.mock('@lingtai/conductor/queue', async (orig) => ({
  ...(await orig<typeof import('@lingtai/conductor/queue')>()),
  selectRunnable: vi.fn(),
}))
vi.mock('@lingtai/recipe/settings', () => ({
  ceilingOf: () => ({ turns: 10, wall: '1h', rounds: 1, restarts: 1 }),
  queueOf: () => ({}),
}))

import { runnableNow } from '@lingtai/conductor/discover'
import { projectFilter } from '@lingtai/conductor/filter'
import { selectRunnable } from '@lingtai/conductor/queue'

import {
  inFlightOf,
  kindOrder,
  queuedChip,
  queuedFor,
  queuedSentence,
  type InFlight,
  type QueuedView,
} from '../src/lib/queued.ts'

const VIEW: QueuedView = {
  position: 1,
  inLine: 2,
  notOffered: null,
  runnableAt: null,
  paused: false,
  project: 'lingtai',
  locks: [],
  dependenciesUnread: null,
  plan: null,
  kind: 'bug',
  kinds: ['bug', 'tech-debt', 'feature', 'documentation'],
  behind: null,
  problem: null,
}
const at = (n: number, inLine = 11): QueuedView => ({ ...VIEW, position: n, inLine })
const run = (n: number): InFlight['running'] =>
  Array.from({ length: n }, (_, i) => ({ project: 'p', issue: String(i + 1), since: null }))

describe('queuedChip and queuedSentence', () => {
  it('first with a free slot', () => {
    expect(queuedChip(VIEW, { running: [], slots: 1 })).toBe('1st of 2')
    expect(queuedSentence(VIEW, { running: [], slots: 1 })).toBe("Taken on the conductor's next turn.")
  })
  it('first with slots full, one running and three', () => {
    expect(queuedSentence(VIEW, { running: run(1), slots: 1 })).toBe(
      'Taken next, as soon as the running attempt finishes.',
    )
    expect(queuedSentence(VIEW, { running: run(3), slots: 3 })).toBe(
      'Taken next, as soon as one of the 3 running attempts finishes.',
    )
  })
  it('first with nothing known of the slots', () => {
    expect(queuedSentence(VIEW, null)).toBe('Taken next, when a slot is free.')
  })
  it('4th of 11', () => {
    expect(queuedChip(at(4), null)).toBe('4th of 11')
    expect(queuedSentence(at(4), null)).toBe('3 ahead of it; it is taken after them.')
    expect(queuedSentence(at(2), null)).toBe('1 ahead of it; it is taken after it.')
  })
  it('not offered, paused, backing off', () => {
    const out = { ...VIEW, position: null, notOffered: 'an issue it is blocked by is still open' }
    expect(queuedChip(out, null)).toBe('not offered')
    expect(queuedSentence(out, null)).toContain('GitHub is not offering it')
    const paused = { ...VIEW, position: null, paused: true }
    expect(queuedChip(paused, null)).toBe('paused')
    expect(queuedSentence(paused, null)).toBe('paused until the setup is fixed — nothing will start')
    const off = { ...VIEW, position: null, runnableAt: new Date(Date.now() + 600_000).toISOString() }
    expect(queuedChip(off, null)).toBe('backing off')
    expect(queuedSentence(off, null)).toMatch(/back/i)
  })
  it('a stop outranks the place in line', () => {
    const since = new Date('2026-11-11T10:00:00Z')
    const held = { ...at(1), locks: [{ kind: 'paused', by: 'human:x', since } as const] }
    expect(queuedChip(held, null)).toBe('paused')
    expect(queuedChip({ ...at(1), locks: null }, null)).toBe('unknown')
    expect(queuedChip({ ...at(1), paused: true }, null)).toBe('paused')
    expect(queuedChip(at(1), null)).toBe('1st of 11')
  })
  it('a problem', () => {
    const bad = { ...VIEW, position: null, problem: 'rate limited' }
    expect(queuedChip(bad, null)).toBe('unknown')
    expect(queuedSentence(bad, null)).toBe('Its place in the queue could not be read: rate limited')
  })
})

describe('kindOrder', () => {
  it('states the order and the tiebreak', () => {
    expect(kindOrder(VIEW)).toBe('bug → tech-debt → feature → documentation, then by number')
  })
  it('is null when the order is unknown', () => {
    expect(kindOrder({ ...VIEW, kinds: [] })).toBeNull()
  })
})

describe('queuedFor', () => {
  beforeEach(() => {
    vi.mocked(projectFilter).mockResolvedValue({
      ok: true,
      kinds: ['bug', 'feature'],
      backoffMs: 0,
      plan: new Map(),
      recipe: { runtime: { tier: 'guarded' } },
    } as never)
    vi.mocked(runnableNow).mockResolvedValue({
      runnable: [
        { ref: '5', title: 'five', kind: 'feature' },
        { ref: '7', title: 'seven', kind: 'bug' },
      ],
      skipped: [],
      dependenciesUnread: null,
    } as never)
    vi.mocked(selectRunnable).mockResolvedValue([
      { taskId: 't7', issue: '7', title: 'seven', kind: 'bug' },
      { taskId: 't5', issue: '5', title: 'five', kind: 'feature' },
    ] as never)
  })
  const ask = (issue: string) => queuedFor({ project: 'p', issue, own: [], paused: false, locks: [] })

  it('carries the kind, the order and what is behind it', async () => {
    const view = await ask('7')
    expect(view.kind).toBe('bug')
    expect(view.kinds).toEqual(['bug', 'feature'])
    expect(view.behind).toEqual({ issue: '5', title: 'five', kind: 'feature' })
  })
  it('has nothing behind the last in line', async () => {
    expect((await ask('5')).behind).toBeNull()
  })
  it('falls back to bug as selectRunnable does', async () => {
    vi.mocked(projectFilter).mockResolvedValue({
      ok: true,
      kinds: [],
      backoffMs: 0,
      plan: new Map(),
      recipe: { runtime: { tier: 'guarded' } },
    } as never)
    expect((await ask('7')).kinds).toEqual(['bug'])
  })
  it('is null and empty on a problem', async () => {
    vi.mocked(runnableNow).mockRejectedValue(new Error('rate limited'))
    const view = await ask('7')
    expect(view).toMatchObject({ kind: null, kinds: [], behind: null, problem: 'rate limited' })
  })
})

describe('inFlightOf', () => {
  const rows = [
    { project: 'p', issue: '1', state: 'running' },
    { project: 'p', issue: '2', state: 'verifying' },
    { project: 'p', issue: '3', state: 'approved' },
    { project: 'other', issue: '9', state: 'running' },
  ]
  it('with no ceiling: one slot, every project, approved not counted', () => {
    expect(inFlightOf(rows, 'p', 3, false)).toEqual({
      running: [
        { project: 'p', issue: '1', since: null },
        { project: 'p', issue: '2', since: null },
        { project: 'other', issue: '9', since: null },
      ],
      slots: 1,
    })
  })
  it("with a ceiling: the recipe's concurrency and this project's rows", () => {
    expect(inFlightOf(rows, 'p', 3, true)).toEqual({
      running: [
        { project: 'p', issue: '1', since: null },
        { project: 'p', issue: '2', since: null },
      ],
      slots: 3,
    })
  })
  it("carries each running row's lastAttemptAt as since", () => {
    const at = new Date('2026-11-05T10:00:00Z')
    const got = inFlightOf([{ project: 'p', issue: '1', state: 'running', lastAttemptAt: at }], 'p', 1, false)
    expect(got?.running).toEqual([{ project: 'p', issue: '1', since: at }])
  })
  it('is null under a ceiling when the recipe was not read', () => {
    expect(inFlightOf(rows, 'p', undefined, true)).toBeNull()
  })
  it('needs no recipe without a ceiling', () => {
    expect(inFlightOf(rows, 'p', undefined, false)?.slots).toBe(1)
  })
})
