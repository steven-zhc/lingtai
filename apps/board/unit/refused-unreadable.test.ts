import type { ProjectState } from '@lingtai/domain'
import { describe, expect, it, vi } from 'vitest'

/**
 * #1477: a project the conductor refused is explained on the Queued column even where its own setup failed
 * (no GitHub credentials, a recipe that would not resolve). `queueFilters` drops such a project from
 * `askable`, so `askQueue` is what carries it to the reader of its recorded refusal.
 */
const detail = 'no lingtai-hook binary at /x/lingtai-hook'
const refusal = { ref: null, detail, codeSha: null, at: new Date() }

const mocks = vi.hoisted(() => ({ refused: true }))

const registered = (): ProjectState[] =>
  [
    { project: 'lingtai', owner: 'steven-zhc', base: 'main', refused: mocks.refused ? refusal : null },
  ] as unknown as ProjectState[]

vi.mock('@lingtai/projector/task-view', async (orig) => ({
  ...(await orig<object>()),
  readTasks: vi.fn(async () => []),
  readTaskProjects: vi.fn(async () => []),
}))
vi.mock('@lingtai/projector', async (orig) => {
  const { Effect } = await import('effect')
  return {
    ...(await orig<object>()),
    readTasksEffect: () =>
      Effect.succeed([{ taskId: 'ticket-lingtai-1', issue: '1', state: 'queued', updatedAt: null, kind: 'bug' }]),
  }
})
vi.mock('@lingtai/project', async (orig) => ({
  ...(await orig<object>()),
  loadAllProjects: vi.fn(async () => registered()),
}))
vi.mock('@lingtai/conductor/filter', async (orig) => ({
  ...(await orig<object>()),
  projectFilter: vi.fn(async (p: ProjectState) => ({
    project: p.project,
    ok: false,
    problem: 'no GitHub App configured',
  })),
}))
vi.mock('@lingtai/daemon', async (orig) => ({
  ...(await orig<object>()),
  conductorLockHolder: vi.fn(async () => null),
  lastBeat: vi.fn(() => ({ up: true })),
}))
vi.mock('@lingtai/daemon/control', async (orig) => {
  const { Effect } = await import('effect')
  return { ...(await orig<object>()), readStatusEffect: () => Effect.succeed({}), readStatus: vi.fn(async () => ({})) }
})
vi.mock('../src/lib/locks.ts', () => ({
  readRegistered: vi.fn(async () => registered()),
  readProjectLocks: vi.fn(async () => ({ ok: true, held: [] })),
  readControlOnce: vi.fn(async () => ({ shutdown: null })),
}))
vi.mock('../src/lib/snapshot-writer.ts', () => ({ boardWriterOrNone: vi.fn(async () => undefined) }))
vi.mock('../src/lib/spend.ts', async (orig) => ({
  ...(await orig<object>()),
  currentSpend: vi.fn(async () => ({ rows: [], currency: { lag: 0 } })),
}))

import { askQueue, startBoard } from '../src/lib/board.ts'

describe('askQueue', () => {
  it('says the recorded refusal of a project whose filter did not resolve, and nothing once it is gone', async () => {
    mocks.refused = true
    const ask = await startBoard().queueAsk
    expect(ask.askable).toEqual([])
    expect(ask.unreadable).toEqual(['lingtai'])

    const queue = await askQueue(ask)
    expect(queue.why?.map((w) => w.project)).toEqual(['lingtai'])
    expect(queue.why?.[0]?.why.roots[0]?.root).toBe('refused')
    expect(queue.why?.[0]?.why.roots[0]?.sentence).toContain(detail)

    // Recovered: the reducer nulled `refused`, and a project the setup already explains says nothing more.
    mocks.refused = false
    expect((await askQueue(ask)).why ?? []).toEqual([])
  })
})
