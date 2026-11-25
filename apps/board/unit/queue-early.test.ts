import type { ProjectState } from '@lingtai/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * #1430: the Queued column's GitHub ask starts from `queueAsk`, which settles
 * once the recipes and the task rows are read, not after `board.progress`.
 * `laneProgress`'s first await is the snapshot writer, so a writer that never
 * answers stands in for a progress read that never finishes.
 */
const mocks = vi.hoisted(() => ({ stall: true, readTasks: vi.fn() }))

vi.mock('@lingtai/projector/task-view', async (orig) => ({
  ...(await orig<object>()),
  readTasks: mocks.readTasks,
  readTaskProjects: vi.fn(async () => []),
}))
vi.mock('@lingtai/project', async (orig) => ({
  ...(await orig<object>()),
  loadAllProjects: vi.fn(
    async () => [{ project: 'lingtai', owner: 'steven-zhc', base: 'main' }] as unknown as ProjectState[],
  ),
}))
vi.mock('@lingtai/conductor/filter', async (orig) => ({
  ...(await orig<object>()),
  projectFilter: vi.fn(async (p: ProjectState) => ({
    project: p.project,
    ok: true,
    kinds: ['bug'],
    backoffMs: 0,
    limits: { rounds: 2, newAttempts: 0, turns: 150, wall: '1h', wallMs: 3_600_000 },
    plan: new Map(),
    recipe: { source: {} },
  })),
}))
vi.mock('@lingtai/daemon/control', async (orig) => ({
  ...(await orig<object>()),
  readStatus: vi.fn(async () => null),
}))
vi.mock('../src/lib/spend.ts', async (orig) => ({
  ...(await orig<object>()),
  currentSpend: vi.fn(async () => ({ rows: [], currency: { lag: 0 } })),
}))
vi.mock('../src/lib/snapshot-writer.ts', () => ({
  boardWriterOrNone: vi.fn(() => (mocks.stall ? new Promise<never>(() => {}) : Promise.resolve(undefined))),
}))

import { githubQueue, startBoard, type AskableFilter, type ProjectQueue } from '../src/lib/board.ts'

const row = {
  taskId: 'ticket-lingtai-1',
  project: 'lingtai',
  issue: '1',
  title: 't',
  kind: 'bug',
  state: 'queued',
  runId: null,
  turns: null,
  passed: 0,
  failed: 0,
  waived: 0,
  approved: 0,
  baseSha: null,
  headSha: null,
  files: null,
  insertions: null,
  deletions: null,
  note: null,
  updatedAt: new Date('2026-10-20T00:00:00Z'),
  closedAt: null,
  attempts: 0,
  newAttempts: 0,
  newAttemptsOf: 0,
  lastAttemptAt: null,
  awaitingSha: null,
  awaitingApproval: false,
  wait: null,
  answer: null,
  split: null,
  triage: { started: null, result: null },
  triageHeadSha: null,
  repairPending: false,
}

afterEach(() => vi.clearAllMocks())

describe('the queue ask', () => {
  it('is made while board.progress has not answered', async () => {
    mocks.stall = true
    mocks.readTasks.mockResolvedValue([row])
    const { queueAsk, board } = startBoard()
    const settled = Symbol('board still pending')
    const ask = await queueAsk
    expect(await Promise.race([board, Promise.resolve(settled)])).toBe(settled)

    expect(ask.askable.map((f) => f.project)).toEqual(['lingtai'])
    expect([...ask.known]).toEqual(['ticket-lingtai-1'])

    const asked: string[] = []
    const counting = vi.fn(async (f: AskableFilter): Promise<ProjectQueue> => {
      asked.push(f.project)
      return {
        state: 'listed',
        filter: f,
        offered: { runnable: [], skipped: [], kindColors: {}, dependenciesUnread: null },
        runnable: [],
        blocked: [],
      } as unknown as ProjectQueue
    })
    await githubQueue(ask.askable, ask.known, counting)
    expect(counting).toHaveBeenCalledTimes(ask.askable.length)
    expect(asked).toEqual(['lingtai'])
  })

  it('hands the board the same set it draws', async () => {
    mocks.stall = false
    mocks.readTasks.mockResolvedValue([row])
    const { queueAsk, board } = startBoard()
    expect((await board).known).toBe((await queueAsk).known)
  })
})
