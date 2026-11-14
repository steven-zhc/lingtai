import { currentRecipe } from '@lingtai/conductor/projects'
import { readStatus } from '@lingtai/daemon/control'
import { aWaitId } from '@lingtai/domain/test/events'
import { readProject } from '@lingtai/project'
import { readTasks, type TaskCard } from '@lingtai/projector/task-view'
import { beforeEach, expect, it, vi } from 'vitest'

import { loadCurrentTriageStatus, type StandingView } from '../src/lib/task.ts'

vi.mock('@lingtai/conductor/projects', async (original) => ({
  ...(await original<typeof import('@lingtai/conductor/projects')>()),
  currentRecipe: vi.fn(),
}))
vi.mock('@lingtai/project', async (original) => ({
  ...(await original<typeof import('@lingtai/project')>()),
  readProject: vi.fn(),
}))
vi.mock('@lingtai/projector/task-view', async (original) => ({
  ...(await original<typeof import('@lingtai/projector/task-view')>()),
  readTasks: vi.fn(),
}))
vi.mock('@lingtai/daemon/control', async (original) => ({
  ...(await original<typeof import('@lingtai/daemon/control')>()),
  readStatus: vi.fn(),
}))

const standing = {
  state: 'blocked',
  waitId: aWaitId(),
  reason: { _tag: 'MergeConflict' },
} as unknown as StandingView

beforeEach(() => {
  vi.mocked(readStatus).mockResolvedValue(null)
  vi.mocked(readTasks).mockResolvedValue([])
  vi.mocked(readProject).mockResolvedValue(null)
})

it('reports a failed task projection read', async () => {
  vi.mocked(readTasks).mockRejectedValue(new Error('task projection unavailable'))
  await expect(loadCurrentTriageStatus('ticket-lingtai-112', 'lingtai', standing)).rejects.toThrow(
    'task projection unavailable',
  )
})

it('reports failed recipe resolution before triage starts', async () => {
  vi.mocked(readProject).mockResolvedValue({} as Awaited<ReturnType<typeof readProject>>)
  vi.mocked(currentRecipe).mockRejectedValue(new Error('recipe unavailable'))
  await expect(loadCurrentTriageStatus('ticket-lingtai-112', 'lingtai', standing)).rejects.toThrow('recipe unavailable')
})

it('reports a failed daemon-status read for an unfinished triage attempt', async () => {
  const startedAt = new Date('2026-10-20T12:00:00.000Z')
  const current = { ...standing, reason: { _tag: 'AgentCrashed' } } as StandingView
  vi.mocked(readTasks).mockResolvedValue([
    {
      taskId: 'ticket-lingtai-112',
      wait: { waitId: current.waitId, reason: current.reason },
      triage: { started: { attempt: 1, at: startedAt }, result: null },
    } as TaskCard,
  ])
  vi.mocked(readProject).mockResolvedValue({} as Awaited<ReturnType<typeof readProject>>)
  vi.mocked(currentRecipe).mockResolvedValue({ recipe: { triage: [] } } as unknown as Awaited<
    ReturnType<typeof currentRecipe>
  >)
  vi.mocked(readStatus).mockResolvedValue({ startedAt: new Date('2026-10-21T12:00:00.000Z') } as Awaited<
    ReturnType<typeof readStatus>
  >)
  await expect(loadCurrentTriageStatus('ticket-lingtai-112', 'lingtai', current)).resolves.toEqual({
    status: { _tag: 'Interrupted' },
    headSha: null,
  })

  vi.mocked(readStatus).mockRejectedValue(new Error('daemon status unavailable'))
  await expect(loadCurrentTriageStatus('ticket-lingtai-112', 'lingtai', current)).rejects.toThrow(
    'daemon status unavailable',
  )
})
