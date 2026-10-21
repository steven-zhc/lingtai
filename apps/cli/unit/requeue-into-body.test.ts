import { reduceTicket, ticketStream, type Envelope, type ProjectState } from '@lingtai/domain'
import { aClaim, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { requeueHolding } from '../../../packages/conductor/src/approve.ts'
import { editBodyAndRequeueHolding } from '../../../packages/conductor/src/edit-body.ts'
import { memoryTickets } from '../../../packages/conductor/test/memory-tickets.ts'
import { requeueCommand } from '../src/requeue.ts'

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]) {
  await store.append(streamId, 0, events)
}

async function blocked(store: EventStore, issue: number) {
  const ticketId = ticketStream('lingtai', issue)
  const stream = makeStream(ticketId)
  const waitId = aWaitId()
  await seed(store, ticketId, [
    ...aClaim(stream, 'pass-1'),
    ...aWait(stream, { _tag: 'AgentQuestion', run: aRunRef('pass-1'), step: 'implement', question: 'which?' }, waitId),
  ])
  return { ticketId, waitId }
}

const loadProject = async () => ({ owner: 'steven' }) as ProjectState
const withProjector = async <T>(_log: (line: string) => void, work: () => Promise<T>) => work()

describe('requeue command', () => {
  it('--into-body writes the section and resolves EditBodyAndRequeue', async () => {
    const store = createMemoryEventStore()
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 'question', body: 'original', labels: [] })
    const { ticketId, waitId } = await blocked(store, 1)
    const lines: string[] = []
    const code = await requeueCommand(
      { project: 'lingtai', issue: 1, note: '', intoBody: 'Use the small helper', by: 'human:test' },
      (line) => lines.push(line),
      {
        store,
        client: tickets,
        loadProject,
        withProjector,
        editBodyAndRequeue: (options) => editBodyAndRequeueHolding(options, store, ticketId),
      },
    )
    expect(code).toBe(0)
    expect(lines).toContain('back in the queue, and the answer is in the body')
    expect((await tickets.getIssue(1)).body).toContain('Use the small helper')
    expect((await store.read(ticketId)).find((e) => e.type === 'WaitResolved')?.data).toMatchObject({
      waitId,
      resolution: { _tag: 'EditBodyAndRequeue' },
    })
  })

  it('without --into-body keeps the plain requeue path', async () => {
    const store = createMemoryEventStore()
    const { ticketId, waitId } = await blocked(store, 2)
    const lines: string[] = []
    const code = await requeueCommand(
      { project: 'lingtai', issue: 2, note: 'try again', by: 'human:test' },
      (line) => lines.push(line),
      { store, loadProject, withProjector, requeue: (options) => requeueHolding(options, store, ticketId) },
    )
    expect(code).toBe(0)
    expect(reduceTicket(await store.read(ticketId)).lifecycle.status).toBe('backlog')
    expect((await store.read(ticketId)).find((e) => e.type === 'WaitResolved')?.data).toMatchObject({
      waitId,
      resolution: { _tag: 'Requeue' },
    })
  })
})
