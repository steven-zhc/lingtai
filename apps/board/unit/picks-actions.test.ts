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

import { continueFixingCard, requeueCard, rerunStepCard } from '../src/app/actions.ts'

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

it('sends rerunStepCard’s shown head as a RedoStep, and never an empty one', async () => {
  const waitId = aWaitId()
  await rerunStepCard({ project: 'p', issue: 1, waitId, onSha: 'abc' })
  expect(conductor.resolveWait).toHaveBeenCalledWith(
    expect.objectContaining({ resolution: { _tag: 'RedoStep', onSha: 'abc', ref: null } }),
  )
  conductor.resolveWait.mockClear()
  expect(await rerunStepCard({ project: 'p', issue: 1, waitId, onSha: '' })).toMatchObject({ ok: false })
  expect(conductor.resolveWait).not.toHaveBeenCalled()
})

it('shows the server’s stale refusal as the card’s detail', async () => {
  conductor.resolveWait.mockResolvedValueOnce({
    ok: false,
    reason: 'stale',
    detail: 'stale: moved',
    ticketId: 'ticket-p-1',
  } as never)
  expect(await rerunStepCard({ project: 'p', issue: 1, waitId: aWaitId(), onSha: 'abc' })).toEqual({
    ok: false,
    detail: 'stale: moved',
  })
})

/**
 * #1267: no board action takes a resolution tag from the page — each builds its own on the server from `{waitId,
 * onSha}` — so a page loaded before the rename has no old tag to post. What protects it is the stale check.
 */
it('refuses a continueFixingCard posted without the head the page showed, telling the person to reload', async () => {
  const waitId = aWaitId()
  const result = await continueFixingCard({ project: 'p', issue: 1, waitId, onSha: '' })
  expect(result).toMatchObject({ ok: false, detail: expect.stringContaining('reload this page') })
  expect(conductor.resolveWait).not.toHaveBeenCalled()
})

it('names the move continueFixingCard asks for by its own tag', async () => {
  await continueFixingCard({ project: 'p', issue: 1, waitId: aWaitId(), onSha: 'abc' })
  expect(conductor.resolveWait).toHaveBeenCalledWith(
    expect.objectContaining({ resolution: { _tag: 'FixRefusal', onSha: 'abc', ref: '' } }),
  )
})
