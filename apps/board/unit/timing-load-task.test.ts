import { githubClientFor, projectFilter } from '@lingtai/conductor/filter'
import { currentRecipe, loadProject } from '@lingtai/conductor/projects'
import { readProjectTicket } from '@lingtai/conductor/read-ticket'
import { readControl, readStatus } from '@lingtai/daemon/control'
import { aClaim, aLanding } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { eventStore } from '@lingtai/event-store'
import { GitHubError } from '@lingtai/github'
import { readTasks } from '@lingtai/projector/task-view'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { outgoingFor } from '../src/lib/prompt.ts'
import { queuedFor } from '../src/lib/queued.ts'
import { recipeOfAttempt } from '../src/lib/recipe.ts'
import { currentSpend } from '../src/lib/spend.ts'
import { knowable, loadAttemptTab, loadTask, loadTaskAnswer, loadTicketTab } from '../src/lib/task.ts'
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
  expect(got).toEqual(['events.task', 'events.task', 'events.control', 'tasks.read', 'events.run', 'spend.read'])
})

it('reads nothing of GitHub’s for a queued ticket: that is the answer’s, not the task’s', async () => {
  // No events at all: the board's *queued* standing, from the log alone.
  const { names: got } = await names([])
  expect(got).toEqual(['events.task', 'events.task', 'events.control', 'tasks.read', 'spend.read'])
})

/**
 * 0118 §2: the page is sent before GitHub has answered. The test that stands in
 * for the trace — an issue reader that never resolves, and a `loadTask` that
 * still does, with the recipe's plan read beside it.
 */
describe('loadTask does not wait for GitHub', () => {
  it('resolves with an issue reader that never answers, and never calls it', async () => {
    const item = makeStream(taskId)
    const own = aClaim(item, 'run-1')
    vi.mocked(eventStore.read).mockImplementation(async (stream: string) => (stream === taskId ? own : []))
    vi.mocked(readProjectTicket).mockReturnValue(new Promise(() => {}))
    vi.mocked(projectFilter).mockClear()

    const task = await loadTask(taskId)

    expect(task).not.toBeNull()
    expect(task?.ticket).toMatchObject({ project: 'lingtai', ref: '774' })
    expect(task?.standing.state).toBe('running')
    expect(task?.runs).toHaveLength(1)
    // `next.plan` is read for a running ticket without waiting on the issue.
    expect(projectFilter).toHaveBeenCalled()
    expect(readProjectTicket).not.toHaveBeenCalled()
    expect(outgoingFor).not.toHaveBeenCalled()
    expect(queuedFor).not.toHaveBeenCalled()
  })

  it('is null for an id a 404 may rest on, with no GitHub asked', async () => {
    vi.mocked(eventStore.read).mockResolvedValue([])
    expect(await loadTask('nodash')).toBeNull()
    vi.mocked(loadProject).mockResolvedValue(null)
    expect(await loadTask(taskId)).toBeNull()
    expect(await knowable(taskId)).toBe(false)
    expect(await knowable('nodash')).toBe(false)
    expect(readProjectTicket).not.toHaveBeenCalled()
  })

  it('is not null for a registered project’s untouched ticket', async () => {
    vi.mocked(eventStore.read).mockResolvedValue([])
    expect(await knowable(taskId)).toBe(true)
    expect(await loadTask(taskId)).not.toBeNull()
  })
})

describe('a project read that fails is not a project that is absent', () => {
  it('knowable and loadTask reject rather than answer null (a 404)', async () => {
    vi.mocked(eventStore.read).mockResolvedValue([])
    vi.mocked(loadProject).mockRejectedValue(new Error('stream read failed'))
    await expect(knowable(taskId)).rejects.toThrow('stream read failed')
    await expect(loadTask(taskId)).rejects.toThrow('stream read failed')
  })

  it('loadTaskAnswer says found: null with the problem, never found: false', async () => {
    vi.mocked(eventStore.read).mockResolvedValue([])
    vi.mocked(loadProject).mockRejectedValue(new Error('stream read failed'))
    const answer = await loadTaskAnswer(taskId)
    expect(answer.ticket).toMatchObject({ found: null, problem: 'stream read failed' })
    expect(readProjectTicket).not.toHaveBeenCalled()
  })
})

describe('loadTaskAnswer', () => {
  const issue = (over: object = {}) =>
    vi.mocked(readProjectTicket).mockResolvedValue({
      ok: true,
      from: 'github',
      ticket: { title: 'GitHub title', labels: [{ name: 'bug' }], body: 'the body', url: 'https://x/774' },
      ...over,
    } as unknown as Awaited<ReturnType<typeof readProjectTicket>>)

  it('carries the title, labels, link and body GitHub gave', async () => {
    vi.mocked(eventStore.read).mockResolvedValue([])
    issue()
    const answer = await loadTaskAnswer(taskId)
    expect(answer.ticket).toEqual({
      found: true,
      askedGitHub: true,
      title: 'GitHub title',
      labels: ['bug'],
      url: 'https://x/774',
      body: 'the body',
      problem: null,
    })
  })

  it('answers a 404 as found: false, and asks nothing further of a ticket the log never touched', async () => {
    vi.mocked(eventStore.read).mockResolvedValue([])
    vi.mocked(readProjectTicket).mockResolvedValue({
      ok: false,
      from: 'github',
      error: new GitHubError(404, '/repos/o/lingtai/issues/774', 'Not Found'),
    } as unknown as Awaited<ReturnType<typeof readProjectTicket>>)
    const answer = await loadTaskAnswer(taskId)
    expect(answer.ticket).toMatchObject({ found: false, askedGitHub: true, body: null })
    expect(answer.ticket.problem).toContain('404')
    expect(answer.outgoing).toBeNull()
    expect(answer.queued).toBeNull()
    expect(outgoingFor).not.toHaveBeenCalled()
    expect(queuedFor).not.toHaveBeenCalled()
  })

  it('answers a failure as found: null with the problem, and never rejects', async () => {
    vi.mocked(eventStore.read).mockResolvedValue([])
    vi.mocked(readProjectTicket).mockResolvedValue({
      ok: false,
      from: 'github',
      error: new GitHubError(403, '/repos/o/lingtai/issues/774', 'rate limit exceeded'),
    } as unknown as Awaited<ReturnType<typeof readProjectTicket>>)
    const failed = await loadTaskAnswer(taskId)
    expect(failed.ticket).toMatchObject({ found: null, askedGitHub: true, body: null })
    expect(failed.ticket.problem).toContain('rate limit exceeded')

    vi.mocked(readProjectTicket).mockRejectedValue(new Error('socket hang up'))
    const threw = await loadTaskAnswer(taskId)
    expect(threw.ticket).toMatchObject({ found: null, body: null, problem: 'socket hang up' })
  })

  it('composes the outgoing prompt and the queue only in the states that have them', async () => {
    issue()
    const outgoing = { text: 'prompt' } as unknown as Awaited<ReturnType<typeof outgoingFor>>
    const queued = { position: 1 } as unknown as Awaited<ReturnType<typeof queuedFor>>
    vi.mocked(outgoingFor).mockResolvedValue(outgoing)
    vi.mocked(queuedFor).mockResolvedValue(queued)

    // queued: both, and the body reached `outgoingFor` through the answer.
    vi.mocked(eventStore.read).mockResolvedValue([])
    const waiting = await loadTaskAnswer(taskId)
    expect(waiting.outgoing).toBe(outgoing)
    expect(waiting.queued).toBe(queued)
    expect(vi.mocked(outgoingFor).mock.calls[0]?.[0].ticket?.body).toBe('the body')

    // running: neither.
    vi.mocked(outgoingFor).mockClear()
    vi.mocked(queuedFor).mockClear()
    const item = makeStream(taskId)
    vi.mocked(eventStore.read).mockImplementation(async (stream: string) =>
      stream === taskId ? aClaim(item, 'run-1') : [],
    )
    const running = await loadTaskAnswer(taskId)
    expect(running.outgoing).toBeNull()
    expect(running.queued).toBeNull()
    expect(outgoingFor).not.toHaveBeenCalled()
    expect(queuedFor).not.toHaveBeenCalled()
  })

  it('turns a throw from queuedFor or outgoingFor into that view’s problem, not a rejection', async () => {
    issue()
    vi.mocked(eventStore.read).mockResolvedValue([])
    vi.mocked(outgoingFor).mockRejectedValue(new Error('no template'))
    vi.mocked(queuedFor).mockRejectedValue(new Error('queue exploded'))
    const answer = await loadTaskAnswer(taskId)
    expect(answer.outgoing?.problem).toBe('no template')
    expect(answer.queued?.problem).toBe('queue exploded')
  })
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
  it('reads no GitHub issue and no attempt', async () => {
    const item = makeStream(taskId)
    vi.mocked(eventStore.read).mockImplementation(async (stream: string) =>
      stream === taskId ? aClaim(item, 'run-1') : [],
    )
    vi.mocked(readProjectTicket).mockReturnValue(new Promise(() => {}))
    const tab = await loadTicketTab(taskId)
    expect(tab?.events.length).toBeGreaterThan(0)
    expect(tab?.ticket).toMatchObject({ ref: '774' })
    // The tab's loader never waits on the issue: the body is `loadTicketAnswer`, read where it is drawn.
    expect(readProjectTicket).not.toHaveBeenCalled()
    expect(recipeOfAttempt).not.toHaveBeenCalled()
  })
})
