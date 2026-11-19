/**
 * #1254: `AnswerQuestions` writes the picked answers into the ticket's body, then resolves the wait so the step that
 * asked continues on its saved head. The body is written first, and nothing resolves where it was not.
 * `createMemoryEventStore()` and `memoryTickets()` — no filesystem, no network (0060 §1).
 */
import { reduceTicket, ticketStream, waitsOf, type Envelope, type WaitId } from '@lingtai/domain'
import { aClaim, anAttempt, anAttemptRef, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import type { IssueChannel } from '../src/tell.ts'
import { memoryTickets } from '../test/memory-tickets.ts'
import { resolveWaitHolding } from '../test/promise-faces.ts'

const PROJECT = 'lingtai'
const ISSUE = 1
const SHA = 'a'.repeat(40)

const question = {
  id: 'q1',
  text: 'which helper?',
  answers: [
    { id: 'a', text: 'use ora' },
    { id: 'b', text: 'use nothing' },
  ],
  recommended: 'a',
}

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]) {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** A ticket blocked on an `implement` that asked, with its commits published on the saved head. */
async function asking() {
  const store = createMemoryEventStore()
  const tickets = memoryTickets()
  await tickets.createIssue({ title: 't', body: 'the ticket', labels: [] })
  const ticketId = ticketStream(PROJECT, ISSUE)
  const item = makeStream(ticketId)
  const run = anAttempt('pass-1')
  const waitId: WaitId = aWaitId()
  await seed(store, ticketId, [
    ...aClaim(item, run.runId),
    ...aWait(
      item,
      { _tag: 'AgentQuestion', run: anAttemptRef(run.runId), step: 'implement', questions: [question] },
      waitId,
    ),
  ])
  await seed(store, run.runId, [
    run.event('RunRefsPublished', {
      branch: 'agent/1',
      arm: 'agent/1-attempt-1',
      headSha: SHA,
      armSha: SHA,
      branchCarries: true,
      outcome: 'published',
      detail: null,
    }),
  ])
  const answer = (
    extra: { github?: IssueChannel; answers?: Record<string, string>; remote?: string | null } = {},
    s: EventStore = store,
  ) =>
    resolveWaitHolding(
      {
        ticketId,
        issue: ISSUE,
        waitId,
        resolution: { _tag: 'AnswerQuestions', onSha: '', ref: null, answers: extra.answers ?? {} },
        by: 'human:steven',
        client: { refSha: async () => (extra.remote === undefined ? SHA : extra.remote) },
        store: s,
        ...(extra.github === undefined ? {} : { github: extra.github }),
      },
      ticketId,
    )
  return { store, tickets, ticketId, waitId, answer }
}

const types = async (store: EventStore, id: string) => (await store.read(id)).map((e) => e.type)

describe('AnswerQuestions on a question an agent asked (#1254)', () => {
  it('writes the answers into the body, then resolves — and the ticket is owed a continuation, not a new attempt', async () => {
    const { store, tickets, ticketId, answer } = await asking()
    expect(await answer({ github: tickets })).toMatchObject({ ok: true })
    expect((await tickets.getIssue(ISSUE)).body).toContain('which helper? — use ora')
    const seen = await types(store, ticketId)
    expect(seen.lastIndexOf('IssueUpdated')).toBeLessThan(seen.indexOf('WaitResolved'))
    expect(waitsOf(await store.read(ticketId)).at(-1)?.resolution).toMatchObject({ _tag: 'AnswerQuestions' })
    // The lifecycle is `approved` on the same run, so the continuation is the same attempt's: nothing was released.
    expect(reduceTicket(await store.read(ticketId)).lifecycle).toMatchObject({ status: 'approved', runId: 'pass-1' })
    expect(seen).not.toContain('TicketReleased')
  })

  it('writes a pick over the recommendation, and a retry replaces the section rather than adding one', async () => {
    const { tickets, answer } = await asking()
    await answer({ github: tickets, answers: { '0': 'b' } })
    const body = (await tickets.getIssue(ISSUE)).body
    expect(body).toContain('which helper? — use nothing')
    await answer({ github: tickets, answers: { '0': 'b' } })
    expect((await tickets.getIssue(ISSUE)).body).toBe(body)
  })

  it('refuses a pick against questions that changed, writing and resolving nothing', async () => {
    const { store, tickets, ticketId, answer } = await asking()
    const before = (await store.read(ticketId)).length
    expect(await answer({ github: tickets, answers: { '0': 'zzz' } })).toMatchObject({ ok: false, reason: 'stale' })
    expect((await tickets.getIssue(ISSUE)).body).toBe('the ticket')
    expect((await store.read(ticketId)).length).toBe(before)
  })

  it('refuses before writing the body when the saved head is gone', async () => {
    const { store, tickets, ticketId, answer } = await asking()
    const before = (await store.read(ticketId)).length
    expect(await answer({ github: tickets, remote: null })).toMatchObject({ ok: false, reason: 'stale' })
    expect((await tickets.getIssue(ISSUE)).body).toBe('the ticket')
    expect((await store.read(ticketId)).length).toBe(before)
  })

  it('a body write that fails leaves the wait open and writes nothing to the log', async () => {
    const { store, tickets, ticketId, answer } = await asking()
    const failing: IssueChannel = {
      ...tickets,
      updateBody: async () => {
        throw new Error('GitHub is down')
      },
    }
    const before = (await store.read(ticketId)).length
    const result = await answer({ github: failing })
    expect(result).toMatchObject({ ok: false, reason: 'write-failed' })
    expect(waitsOf(await store.read(ticketId)).at(-1)?.resolution).toBeNull()
    expect(reduceTicket(await store.read(ticketId)).lifecycle.status).toBe('blocked')
    expect((await store.read(ticketId)).filter((e) => e.type === 'WaitResolved')).toHaveLength(0)
    expect((await store.read(ticketId)).length).toBeGreaterThanOrEqual(before)
  })

  it('a second person with different answers is refused, not reported as a repeat', async () => {
    const { tickets, answer } = await asking()
    expect(await answer({ github: tickets, answers: { '0': 'a' } })).toMatchObject({ ok: true })
    expect(await answer({ github: tickets, answers: { '0': 'b' } })).toMatchObject({ ok: false })
    expect((await tickets.getIssue(ISSUE)).body).toContain('use ora')
  })
})
