/** #922: the two cards hand the person's picks to the conductor unchanged. */
import { aWaitId } from '@lingtai/domain/test/events'
import { beforeEach, expect, it, vi } from 'vitest'

const conductor = vi.hoisted(() => ({
  requeue: vi.fn(async (_options: unknown) => ({ ok: true, detail: 'requeued' })),
  resolveWait: vi.fn(async (_options: unknown) => ({ ok: true, continuesAt: 'x', unscheduled: null })),
}))

vi.mock('@lingtai/conductor/decide', () => ({ approve: vi.fn(), requeue: conductor.requeue }))
vi.mock('@lingtai/conductor/resolve-wait', () => ({ resolveWait: conductor.resolveWait }))
vi.mock('@lingtai/conductor/projects', () => ({
  currentRecipe: vi.fn(async () => ({ recipe: {} })),
}))
vi.mock('@lingtai/project', async (orig) => ({
  ...(await orig<object>()),
  readProject: vi.fn(async () => ({ name: 'p', owner: null })),
  loadAllProjects: vi.fn(),
}))
vi.mock('@lingtai/conductor/ownerless', () => ({ ownerlessClient: vi.fn(async () => ({ client: {} })) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { fixRefusalCard, startNewAttemptCard, redoStepCard } from '../src/app/actions.ts'

beforeEach(() => {
  conductor.requeue.mockClear()
  conductor.resolveWait.mockClear()
})

it('passes the picks of startNewAttemptCard to the conductor unchanged', async () => {
  const waitId = aWaitId()
  await startNewAttemptCard({ project: 'p', issue: 1, note: '', waitId, picks: { 0: 'b', 2: 'a' } })
  expect(conductor.requeue).toHaveBeenCalledWith(expect.objectContaining({ picks: { 0: 'b', 2: 'a' } }))
})

it('passes the picks of fixRefusalCard to the conductor unchanged', async () => {
  const waitId = aWaitId()
  await fixRefusalCard({ project: 'p', issue: 1, waitId, onSha: 'abc', picks: { 1: 'b' } })
  expect(conductor.resolveWait).toHaveBeenCalledWith(expect.objectContaining({ picks: { 1: 'b' } }))
})

it('sends redoStepCard’s shown head as a RerunStep, and never an empty one', async () => {
  const waitId = aWaitId()
  await redoStepCard({ project: 'p', issue: 1, waitId, onSha: 'abc' })
  expect(conductor.resolveWait).toHaveBeenCalledWith(
    expect.objectContaining({ resolution: { _tag: 'RedoStep', onSha: 'abc', ref: null } }),
  )
  conductor.resolveWait.mockClear()
  expect(await redoStepCard({ project: 'p', issue: 1, waitId, onSha: '' })).toMatchObject({ ok: false })
  expect(conductor.resolveWait).not.toHaveBeenCalled()
})

it('shows the server’s stale refusal as the card’s detail', async () => {
  conductor.resolveWait.mockResolvedValueOnce({ ok: false, reason: 'stale', detail: 'stale: moved' } as never)
  expect(await redoStepCard({ project: 'p', issue: 1, waitId: aWaitId(), onSha: 'abc' })).toEqual({
    ok: false,
    detail: 'stale: moved',
  })
})
