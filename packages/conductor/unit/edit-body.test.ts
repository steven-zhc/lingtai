import { parsePayload, reduceTicket, ticketStream, type Envelope, type WaitId } from '@lingtai/domain'
/**
 * `writeSection` and `editBodyAndRequeue` (#422, 0118 §6): a wait's answer
 * goes into the ticket's body before the wait is resolved. Checked against
 * `createMemoryEventStore()` and `memoryTickets()` — no filesystem, no
 * network (0060 §1).
 */
import { aClaim, aRunRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { answerOpenMarker } from '../src/body-section.ts'
import { editBodyAndRequeueHolding, writeSection } from '../src/edit-body.ts'
import type { IssueChannel } from '../src/tell.ts'
import { memoryTickets, type MemoryTickets } from '../test/memory-tickets.ts'

const PROJECT = 'lingtai'
/** `memoryTickets()` numbers its first created issue `1`, and every test below creates exactly one. */
const ISSUE = 1

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]): Promise<void> {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** A ticket `blocked` on a fresh `waitId` — an `AgentQuestion`, which offers `EditBodyAndRequeue`. */
async function aBlockedTicket(store: EventStore): Promise<{ ticketId: string; waitId: WaitId }> {
  const ticketId = ticketStream(PROJECT, ISSUE)
  const item = makeStream(ticketId)
  const waitId = aWaitId()
  await seed(store, ticketId, [
    ...aClaim(item, 'pass-1'),
    ...aWait(
      item,
      { _tag: 'AgentQuestion', run: aRunRef('pass-1'), step: 'implement', question: 'which helper?' },
      waitId,
    ),
  ])
  return { ticketId, waitId }
}

/** Never reaches GitHub: `updateBody` throws before `memoryTickets` sees the call. */
function alwaysFails(tickets: MemoryTickets, message: string): IssueChannel {
  return {
    ...tickets,
    updateBody: async () => {
      throw new Error(message)
    },
  }
}

/** The write lands, but the call that made it throws anyway — a dropped response after the PATCH committed. */
function landsButThrows(tickets: MemoryTickets, message: string): IssueChannel {
  return {
    ...tickets,
    updateBody: async (number, body, opts) => {
      await tickets.updateBody(number, body, opts)
      throw new Error(message)
    },
  }
}

/** Somebody else's edit lands between this caller's read and its first write — `ifUnchanged` refuses it with `BodyChanged`. */
function conflictOnFirstWrite(tickets: MemoryTickets, conflict: (body: string) => string): IssueChannel {
  let first = true
  return {
    ...tickets,
    updateBody: async (number, body, opts) => {
      if (first) {
        first = false
        const current = await tickets.getIssue(number)
        await tickets.updateBody(number, conflict(current.body))
      }
      await tickets.updateBody(number, body, opts)
    },
  }
}

/** `getIssue` succeeds on the initial read and throws on the read-back right after — the write itself still lands. */
function readBackThrowsAfterLanding(tickets: MemoryTickets, message: string): IssueChannel {
  let calls = 0
  return {
    ...tickets,
    async getIssue(number) {
      calls++
      if (calls === 2) throw new Error(message)
      return tickets.getIssue(number)
    },
  }
}

/** A second decision — a `Requeue` on the same wait — lands while this caller is still writing the section. */
function requeuedDuringTheWrite(
  tickets: MemoryTickets,
  store: EventStore,
  ticketId: string,
  waitId: WaitId,
): IssueChannel {
  let injected = false
  return {
    ...tickets,
    async getIssue(number) {
      const issue = await tickets.getIssue(number)
      if (!injected) {
        injected = true
        await store.append(ticketId, (await store.read(ticketId)).length, [
          {
            type: 'WaitResolved',
            actor: 'human:other',
            data: parsePayload('WaitResolved', {
              waitId,
              by: 'human:other',
              resolution: { _tag: 'Requeue' },
              note: '',
            }),
          },
        ])
      }
      return issue
    },
  }
}

describe('editBodyAndRequeueHolding', () => {
  it('writes the section, resolves the wait, and the ticket is backlog', async () => {
    const store = createMemoryEventStore()
    const { ticketId, waitId } = await aBlockedTicket(store)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })

    const result = await editBodyAndRequeueHolding(
      {
        project: PROJECT,
        issue: ISSUE,
        waitId,
        text: 'use the helper in foo.ts',
        by: 'human:steven',
        github: tickets,
        store,
      },
      store,
      ticketId,
    )

    expect(result).toMatchObject({ ok: true, written: true })
    const events = await store.read(ticketId)
    expect(events.some((e) => e.type === 'WaitResolved')).toBe(true)
    expect(reduceTicket(events).lifecycle.status).toBe('backlog')

    const issue = await tickets.getIssue(ISSUE)
    expect(issue.body).toContain('the ticket.')
    expect(issue.body).toContain('use the helper in foo.ts')
  })

  it('running it twice for one wait leaves one section', async () => {
    const store = createMemoryEventStore()
    const { ticketId, waitId } = await aBlockedTicket(store)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })
    const options = {
      project: PROJECT,
      issue: ISSUE,
      waitId,
      text: 'use the helper in foo.ts',
      by: 'human:steven',
      github: tickets,
      store,
    }

    const first = await editBodyAndRequeueHolding(options, store, ticketId)
    expect(first.ok).toBe(true)
    const second = await editBodyAndRequeueHolding(options, store, ticketId)
    expect(second.ok).toBe(false) // the ticket is backlog now; the wait is no longer current

    const issue = await tickets.getIssue(ISSUE)
    const marker = answerOpenMarker(`${ticketId}/${waitId}`)
    expect(issue.body.split(marker).length - 1).toBe(1)
  })

  it('a write that landed but whose call threw is found by the read-back, and no second section is written', async () => {
    const store = createMemoryEventStore()
    const { ticketId, waitId } = await aBlockedTicket(store)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })
    const github = landsButThrows(tickets, 'socket hang up')

    const result = await editBodyAndRequeueHolding(
      { project: PROJECT, issue: ISSUE, waitId, text: 'the answer', by: 'human:steven', github, store },
      store,
      ticketId,
    )

    expect(result).toMatchObject({ ok: true, written: true })
    const events = await store.read(ticketId)
    const changeTypes = events.map((e) => e.type)
    const failedIdx = changeTypes.indexOf('IssueUpdateFailed')
    const updatedIdx = changeTypes.lastIndexOf('IssueUpdated')
    expect(failedIdx).toBeGreaterThanOrEqual(0)
    expect(updatedIdx).toBeGreaterThan(failedIdx)
    expect(events.filter((e) => e.type === 'IssueUpdated').length).toBe(1)

    const issue = await tickets.getIssue(ISSUE)
    const marker = answerOpenMarker(`${ticketId}/${waitId}`)
    expect(issue.body.split(marker).length - 1).toBe(1)
  })

  it('a write that fails appends IssueUpdateFailed and resolves nothing', async () => {
    const store = createMemoryEventStore()
    const { ticketId, waitId } = await aBlockedTicket(store)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })
    const github = alwaysFails(tickets, 'connection refused')

    const result = await editBodyAndRequeueHolding(
      { project: PROJECT, issue: ISSUE, waitId, text: 'the answer', by: 'human:steven', github, store },
      store,
      ticketId,
    )

    expect(result).toMatchObject({ ok: false, written: false })
    const events = await store.read(ticketId)
    expect(events.some((e) => e.type === 'IssueUpdateFailed')).toBe(true)
    expect(events.some((e) => e.type === 'WaitResolved')).toBe(false)
    expect(reduceTicket(events).lifecycle.status).toBe('blocked')
  })

  it('a BodyChanged on the first write is retried against the new body, and the other edit survives', async () => {
    const store = createMemoryEventStore()
    const { ticketId, waitId } = await aBlockedTicket(store)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })
    const github = conflictOnFirstWrite(tickets, (body) => `${body}\n\n## Someone else's edit\n`)

    const result = await editBodyAndRequeueHolding(
      { project: PROJECT, issue: ISSUE, waitId, text: 'the answer', by: 'human:steven', github, store },
      store,
      ticketId,
    )

    expect(result).toMatchObject({ ok: true, written: true })
    const issue = await tickets.getIssue(ISSUE)
    expect(issue.body).toContain("Someone else's edit")
    expect(issue.body).toContain('the answer')

    const failures = (await store.read(ticketId)).filter((e) => e.type === 'IssueUpdateFailed')
    expect(failures.length).toBe(1)
  })

  it('a wait that does not offer EditBodyAndRequeue is refused with the body untouched', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, ISSUE)
    const item = makeStream(ticketId)
    const waitId = aWaitId()
    await seed(store, ticketId, [
      ...aClaim(item, 'pass-1'),
      ...aWait(
        item,
        {
          _tag: 'MergeRefused',
          run: aRunRef('pass-1'),
          reason: 'dirty-base',
          raw: 'the base moved',
        },
        waitId,
      ),
    ])
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })

    const result = await editBodyAndRequeueHolding(
      { project: PROJECT, issue: ISSUE, waitId, text: 'the answer', by: 'human:steven', github: tickets, store },
      store,
      ticketId,
    )

    expect(result).toMatchObject({ ok: false, written: false, detail: expect.stringContaining('not offered') })
    const issue = await tickets.getIssue(ISSUE)
    expect(issue.body).toBe('the ticket.')
    expect((await store.read(ticketId)).some((e) => e.type === 'IssueUpdated' || e.type === 'IssueUpdateFailed')).toBe(
      false,
    )
  })

  it('a resolution refused after a good write returns written: true and the ticket’s current state', async () => {
    const store = createMemoryEventStore()
    const { ticketId, waitId } = await aBlockedTicket(store)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })
    const github = requeuedDuringTheWrite(tickets, store, ticketId, waitId)

    const result = await editBodyAndRequeueHolding(
      { project: PROJECT, issue: ISSUE, waitId, text: 'the answer', by: 'human:steven', github, store },
      store,
      ticketId,
    )

    expect(result.ok).toBe(false)
    expect(result.written).toBe(true)
    expect(result.detail).toContain('backlog')

    const issue = await tickets.getIssue(ISSUE)
    expect(issue.body).toContain('the answer')
  })
})

describe('writeSection', () => {
  it('is idempotent: writing the same text twice leaves one section', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, ISSUE)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })

    const first = await writeSection({ store, github: tickets, ticketId, key: 'w-1@review', text: 'the answer' })
    const second = await writeSection({ store, github: tickets, ticketId, key: 'w-1@review', text: 'the answer' })

    expect(first).toEqual({ written: true })
    expect(second).toEqual({ written: true })
    const issue = await tickets.getIssue(ISSUE)
    expect(issue.body.split(answerOpenMarker('w-1@review')).length - 1).toBe(1)
  })

  it('refuses without writing when the text itself carries a marker', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, ISSUE)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })

    const result = await writeSection({
      store,
      github: tickets,
      ticketId,
      key: 'w-1@review',
      text: 'lingtai:answer trouble',
    })

    expect(result.written).toBe(false)
    const issue = await tickets.getIssue(ISSUE)
    expect(issue.body).toBe('the ticket.')
    expect((await store.read(ticketId)).length).toBe(0)
  })

  it('trusts a write recorded as IssueUpdated even when the read-back that follows it throws', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, ISSUE)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })
    const github = readBackThrowsAfterLanding(tickets, 'ETIMEDOUT')

    const result = await writeSection({ store, github, ticketId, key: 'w-1@review', text: 'the answer' })

    expect(result).toEqual({ written: true })
    const events = await store.read(ticketId)
    expect(events.map((e) => e.type)).toEqual(['IssueUpdated'])
    const issue = await tickets.getIssue(ISSUE)
    expect(issue.body).toContain('the answer')
  })

  it('matches a CRLF text against its own CRLF-folded reflection on the read-back', async () => {
    const store = createMemoryEventStore()
    const ticketId = ticketStream(PROJECT, ISSUE)
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'the ticket.', labels: [] })

    const result = await writeSection({
      store,
      github: tickets,
      ticketId,
      key: 'w-1@review',
      text: 'line one\r\nline two',
    })

    expect(result).toEqual({ written: true })
    // One write, not a retry that mistook its own text for a miss.
    expect((await store.read(ticketId)).map((e) => e.type)).toEqual(['IssueUpdated'])
  })
})
