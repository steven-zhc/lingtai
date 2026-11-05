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
  loadProject: vi.fn(async () => ({ name: 'p', owner: null })),
  currentRecipe: vi.fn(async () => ({ recipe: {} })),
  loadAllProjects: vi.fn(),
}))
vi.mock('@lingtai/conductor/ownerless', () => ({ ownerlessClient: vi.fn(async () => ({ client: {} })) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { continueFixingCard, requeueCard } from '../src/app/actions.ts'

beforeEach(() => {
  conductor.requeue.mockClear()
  conductor.resolveWait.mockClear()
})

it('passes the picks of requeueCard to the conductor unchanged', async () => {
  const waitId = aWaitId()
  await requeueCard({ project: 'p', issue: 1, note: '', waitId, picks: { 0: 'b', 2: 'a' } })
  expect(conductor.requeue).toHaveBeenCalledWith(expect.objectContaining({ picks: { 0: 'b', 2: 'a' } }))
})

it('passes the picks of continueFixingCard to the conductor unchanged', async () => {
  const waitId = aWaitId()
  await continueFixingCard({ project: 'p', issue: 1, waitId, onSha: 'abc', picks: { 1: 'b' } })
  expect(conductor.resolveWait).toHaveBeenCalledWith(expect.objectContaining({ picks: { 1: 'b' } }))
})
