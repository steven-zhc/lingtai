import { githubClientFor, projectFilter } from '@lingtai/conductor/filter'
import { currentRecipe, loadProject } from '@lingtai/conductor/projects'
import { readProjectTicket } from '@lingtai/conductor/read-ticket'
import { readControl, readStatus } from '@lingtai/daemon/control'
import { aClaim, aLanding } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { eventStore } from '@lingtai/event-store'
import { readTasks } from '@lingtai/projector/task-view'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { outgoingFor } from '../src/lib/prompt.ts'
import { queuedFor } from '../src/lib/queued.ts'
import { recipeOfAttempt } from '../src/lib/recipe.ts'
import { currentSpend } from '../src/lib/spend.ts'
import { loadAttemptTab, loadTask, loadTicketTab } from '../src/lib/task.ts'
import { measure } from '../src/lib/timing.ts'

vi.mock('@lingtai/event-store', async (original) => ({
  ...(await original<typeof import('@lingtai/event-store')>()),
  eventStore: { read: vi.fn() },
}))
vi.mock('@lingtai/conductor/projects', async (original) => ({
  ...(await original<typeof import('@lingtai/conductor/projects')>()),
  loadProject: vi.fn(),
  currentRecipe: vi.fn(),
}))
vi.mock('@lingtai/conductor/read-ticket', () => ({ readProjectTicket: vi.fn() }))
vi.mock('@lingtai/conductor/filter', async (original) => ({
  ...(await original<typeof import('@lingtai/conductor/filter')>()),
  githubClientFor: vi.fn(),
  projectFilter: vi.fn(),
}))
vi.mock('@lingtai/projector/task-view', async (original) => ({
  ...(await original<typeof import('@lingtai/projector/task-view')>()),
  readTasks: vi.fn(),
}))
vi.mock('@lingtai/daemon/control', async (original) => {
  const actual = await original<typeof import('@lingtai/daemon/control')>()
  return { ...actual, readStatus: vi.fn(), readControl: vi.fn(actual.readControl) }
})
vi.mock('@lingtai/repo', async (original) => ({
  ...(await original<typeof import('@lingtai/repo')>()),
  refSha: vi.fn(),
  mirrorBranchSha: vi.fn(),
  mirrorPathFor: vi.fn(),
}))
vi.mock('../src/lib/spend.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/spend.ts')>()),
  currentSpend: vi.fn(),
}))
vi.mock('../src/lib/recipe.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/recipe.ts')>()),
  recipeOfAttempt: vi.fn(),
}))
vi.mock('../src/lib/prompt.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/prompt.ts')>()),
  outgoingFor: vi.fn(),
}))
vi.mock('../src/lib/queued.ts', async (original) => ({
  ...(await original<typeof import('../src/lib/queued.ts')>()),
  queuedFor: vi.fn(),
}))

const taskId = 'ticket-lingtai-774'

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(loadProject).mockResolvedValue({ owner: 'o', base: 'main' } as Awaited<ReturnType<typeof loadProject>>)
  vi.mocked(currentRecipe).mockResolvedValue({ recipe: {} } as Awaited<ReturnType<typeof currentRecipe>>)
  vi.mocked(readProjectTicket).mockResolvedValue({
    ok: true,
    from: 'github',
    ticket: { title: 't', labels: [], kind: null, body: '' },
  } as unknown as Awaited<ReturnType<typeof readProjectTicket>>)
  vi.mocked(githubClientFor).mockResolvedValue({} as Awaited<ReturnType<typeof githubClientFor>>)
  vi.mocked(projectFilter).mockResolvedValue({ ok: false, error: 'not read in a test' } as unknown as Awaited<
    ReturnType<typeof projectFilter>
  >)
  vi.mocked(readTasks).mockResolvedValue([])
  vi.mocked(readStatus).mockResolvedValue(null)
  vi.mocked(currentSpend).mockResolvedValue({ rows: [], currency: { lag: 0 } } as unknown as Awaited<
    ReturnType<typeof currentSpend>
  >)
  vi.mocked(recipeOfAttempt).mockResolvedValue({ of: 'none', why: 'test' })
  vi.mocked(queuedFor).mockResolvedValue(null as unknown as Awaited<ReturnType<typeof queuedFor>>)
})

const names = async (own: Awaited<ReturnType<typeof eventStore.read>>) => {
  vi.mocked(eventStore.read).mockImplementation(async (stream: string) => (stream === taskId ? own : []))
  let tick = 0
  const [task, timings] = await measure(() => loadTask(taskId), { now: () => tick++ })
  return { task, names: timings.map((t) => t.name) }
}

it('names the reads of a landed ticket in start order', async () => {
  const item = makeStream(taskId)
  const { task, names: got } = await names([...aClaim(item, 'run-1'), ...aLanding(item, 'abc123')])
  expect(task).not.toBeNull()
  // `events.task` twice: the layout's `readOwn` and `readAttempts`' own. Under
  // the `react-server` condition `cache()` makes them one read; vitest has no
  // such condition and `cache` is a passthrough, so this is not a claim about
  // the number of reads in a render. `recipe.run` is gone: the recipe is the
  // attempt tab's, read by `loadAttemptTab` (#885).
  expect(got).toEqual([
    'events.task',
    'events.task',
    'events.control',
    'tasks.read',
    'events.run',
    'spend.read',
    'github.issue',
  ])
})

it('names the next-attempt reads of a queued ticket', async () => {
  // No events at all, and the issue is open: the board's *queued* standing.
  const { names: got } = await names([])
  expect(got).toEqual([
    'events.task',
    'events.task',
    'events.control',
    'tasks.read',
    'spend.read',
    'github.issue',
    'next.outgoing',
    'next.queued',
  ])
})

/**
 * A tab's loader reads what the tab shows and nothing above the record (#885).
 * Next does not re-render a layout on a navigation, so a child loader that
 * reached for the layout's reads would cost a GitHub issue, a control stream
 * and a queue on every tab switch.
 */
describe('loadAttemptTab', () => {
  it('never reads the layout’s inputs, and reads one attempt’s recipe', async () => {
    const item = makeStream(taskId)
    const own = [...aClaim(item, 'run-1'), ...aClaim(item, 'run-2'), ...aLanding(item, 'abc123')]
    vi.mocked(eventStore.read).mockImplementation(async (stream: string) => (stream === taskId ? own : []))

    const tab = await loadAttemptTab(taskId, 2)

    expect(tab?.run.attempt).toBe(2)
    expect(recipeOfAttempt).toHaveBeenCalledTimes(1)
    expect(readProjectTicket).not.toHaveBeenCalled()
    expect(readControl).not.toHaveBeenCalled()
    expect(outgoingFor).not.toHaveBeenCalled()
    expect(queuedFor).not.toHaveBeenCalled()
    expect(readTasks).not.toHaveBeenCalled()
  })

  it('is null for an attempt this ticket does not have', async () => {
    const item = makeStream(taskId)
    vi.mocked(eventStore.read).mockImplementation(async (stream: string) =>
      stream === taskId ? aClaim(item, 'run-1') : [],
    )
    expect(await loadAttemptTab(taskId, 0)).toBeNull()
    expect(await loadAttemptTab(taskId, 2)).toBeNull()
  })
})

describe('loadTicketTab', () => {
  it('reads the one GitHub issue and no attempt', async () => {
    const item = makeStream(taskId)
    vi.mocked(eventStore.read).mockImplementation(async (stream: string) =>
      stream === taskId ? aClaim(item, 'run-1') : [],
    )
    const tab = await loadTicketTab(taskId)
    expect(tab?.events.length).toBeGreaterThan(0)
    expect(readProjectTicket).toHaveBeenCalledTimes(1)
    expect(recipeOfAttempt).not.toHaveBeenCalled()
  })
})
