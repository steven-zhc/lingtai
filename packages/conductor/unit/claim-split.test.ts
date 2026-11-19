/**
 * A split parent at claim (#604, #1263): the children come from the `TicketSplit`
 * event and from nowhere else, and a parent whose children are all closed is claimed, never closed.
 */
import { ticketStream } from '@lingtai/domain'
import { aSplit, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { claimTicketEffect } from '../src/ticket/commands.ts'
import { memoryTickets } from '../test/memory-tickets.ts'

async function splitParent() {
  const store = createMemoryEventStore()
  const tickets = memoryTickets()
  const parent = await tickets.createIssue({ title: 'parent', body: '', labels: [] })
  const a = await tickets.createIssue({ title: 'a', body: '', labels: [] })
  const b = await tickets.createIssue({ title: 'b', body: '', labels: [] })
  const handAttached = await tickets.createIssue({ title: 'hand', body: `see #${a.number}`, labels: [] })
  const ticketId = ticketStream('lingtai', parent.number)
  const waitId = aWaitId()
  await store.append(ticketId, 0, aSplit(makeStream(ticketId), waitId, [a.number, b.number]))
  return { store, tickets, ticketId, waitId, a, b, handAttached }
}

describe('claimTicket on a split parent', () => {
  it('claims when every recorded child is closed, naming how each closed, and appends no close', async () => {
    const { store, tickets, ticketId, a, b } = await splitParent()
    await tickets.closeIssue(a.number, 'completed')
    await tickets.closeIssue(b.number, 'not_planned')

    const result = await Effect.runPromise(claimTicketEffect(ticketId, { runId: 'r1', store, children: tickets }))

    expect(result.ok).toBe(true)
    expect(result.ok && result.claim.splitChildren).toEqual([
      { number: a.number, title: 'a', stateReason: 'completed' },
      { number: b.number, title: 'b', stateReason: 'not_planned' },
    ])
    const types = (await store.read(ticketId)).map((e) => e.type)
    expect(types).toContain('TicketClaimed')
    expect(types).not.toContain('TicketClosed')
  })

  it('answers split-open, appending nothing, while a recorded child is open', async () => {
    const { store, tickets, ticketId, a, b } = await splitParent()
    await tickets.closeIssue(a.number)
    const before = (await store.read(ticketId)).length

    const result = await Effect.runPromise(claimTicketEffect(ticketId, { runId: 'r1', store, children: tickets }))

    expect(result).toEqual({ ok: false, refusal: { reason: 'split-open', open: [b.number] } })
    expect(await store.read(ticketId)).toHaveLength(before)
  })

  it('asks about exactly the recorded numbers, so a hand-attached open issue changes nothing', async () => {
    const { store, tickets, ticketId, a, b, handAttached } = await splitParent()
    await tickets.closeIssue(a.number)
    await tickets.closeIssue(b.number)
    const getIssue = vi.fn(tickets.getIssue)

    const result = await Effect.runPromise(claimTicketEffect(ticketId, { runId: 'r1', store, children: { getIssue } }))

    expect(result.ok).toBe(true)
    expect(getIssue.mock.calls.map((c) => c[0]).sort()).toEqual([a.number, b.number].sort())
    expect(getIssue).not.toHaveBeenCalledWith(handAttached.number)
  })

  it('closes nothing when a child read throws', async () => {
    const { store, ticketId } = await splitParent()
    const children = {
      getIssue: async () => {
        throw new Error('GitHub is down')
      },
    }
    const before = (await store.read(ticketId)).length
    const result = await Effect.runPromise(claimTicketEffect(ticketId, { runId: 'r1', store, children }))
    expect(result).toEqual({ ok: false, refusal: { reason: 'split-unreadable', detail: 'GitHub is down' } })
    expect(await store.read(ticketId)).toHaveLength(before)
  })

  it('claims exactly as before when no children source is given', async () => {
    const { store, ticketId } = await splitParent()
    const result = await Effect.runPromise(claimTicketEffect(ticketId, { runId: 'r1', store }))
    expect(result.ok).toBe(true)
  })
})
