/**
 * A split parent at claim (#604): the children come from the `TicketSplit`
 * event and from nowhere else, and nothing is appended either way.
 */
import { ticketStream } from '@lingtai/domain'
import { aSplit, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it, vi } from 'vitest'

import { claimTicket } from '../src/claim.ts'
import { closeHolding } from '../src/close.ts'
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
  it('answers split-done, naming how each child closed, when every recorded child is closed', async () => {
    const { store, tickets, ticketId, waitId, a, b } = await splitParent()
    await tickets.closeIssue(a.number, 'completed')
    await tickets.closeIssue(b.number, 'not_planned')
    const before = (await store.read(ticketId)).length

    const result = await claimTicket(ticketId, { runId: 'r1', store, children: tickets })

    expect(result).toEqual({
      ok: false,
      refusal: {
        reason: 'split-done',
        version: before,
        waitId,
        children: [
          { number: a.number, stateReason: 'completed' },
          { number: b.number, stateReason: 'not_planned' },
        ],
      },
    })
    expect(await store.read(ticketId)).toHaveLength(before)
  })

  it('answers split-open, appending nothing, while a recorded child is open', async () => {
    const { store, tickets, ticketId, a, b } = await splitParent()
    await tickets.closeIssue(a.number)
    const before = (await store.read(ticketId)).length

    const result = await claimTicket(ticketId, { runId: 'r1', store, children: tickets })

    expect(result).toEqual({ ok: false, refusal: { reason: 'split-open', open: [b.number] } })
    expect(await store.read(ticketId)).toHaveLength(before)
  })

  it('asks about exactly the recorded numbers, so a hand-attached open issue changes nothing', async () => {
    const { store, tickets, ticketId, a, b, handAttached } = await splitParent()
    await tickets.closeIssue(a.number)
    await tickets.closeIssue(b.number)
    const getIssue = vi.fn(tickets.getIssue)

    const result = await claimTicket(ticketId, { runId: 'r1', store, children: { getIssue } })

    expect(result.ok === false && result.refusal.reason).toBe('split-done')
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
    await expect(claimTicket(ticketId, { runId: 'r1', store, children })).rejects.toThrow('GitHub is down')
  })

  it('claims exactly as before when no children source is given', async () => {
    const { store, ticketId } = await splitParent()
    const result = await claimTicket(ticketId, { runId: 'r1', store })
    expect(result.ok).toBe(true)
  })

  it('is not closed over a stream that moved after the check', async () => {
    const { store, tickets, ticketId, a, b } = await splitParent()
    await tickets.closeIssue(a.number)
    await tickets.closeIssue(b.number)
    const result = await claimTicket(ticketId, { runId: 'r1', store, children: tickets })
    const checked = result.ok === false && result.refusal.reason === 'split-done' ? result.refusal.version : -1
    // Something else lands on the stream while the child reads were awaited.
    const now = await store.read(ticketId)
    await store.append(ticketId, now.length, aSplit(makeStream(ticketId), aWaitId(), [a.number]))

    const closed = await closeHolding(
      {
        project: 'lingtai',
        issue: Number(ticketId.split('-').pop()),
        by: 'conductor',
        reason: 'r',
        ifVersion: checked,
      },
      store,
      ticketId,
    )

    expect(closed.ok).toBe(false)
    expect((await store.read(ticketId)).map((e) => e.type)).not.toContain('TicketClosed')
  })
})
