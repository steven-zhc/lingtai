/**
 * #921: `GrantFixRound` and `Requeue` write the wait's triage answers into the
 * ticket's body before they resolve it. `createMemoryEventStore()` and
 * `memoryTickets()` — no filesystem, no network (0060 §1).
 */
import { reduceTicket, ticketStream, waitsOf, type Envelope, type WaitId } from '@lingtai/domain'
import { aClaim, anAttempt, anAttemptRef, aTriaged, aTriageStart, aWait, aWaitId } from '@lingtai/domain/test/events'
import { makeStream } from '@lingtai/domain/test/support'
import type { EventStore } from '@lingtai/event-store'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { requeueHolding } from '../src/approve.ts'
import { editBodyAndRequeueHolding } from '../src/edit-body.ts'
import { resolveWaitHolding } from '../src/resolve-wait.ts'
import type { IssueChannel } from '../src/tell.ts'
import { memoryTickets } from '../test/memory-tickets.ts'

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
const undecided = { _tag: 'UndecidedQuestion', questions: [question] }

async function seed(store: EventStore, streamId: string, events: readonly Envelope[]) {
  await store.append(streamId, (await store.read(streamId)).length, events)
}

/** A ticket blocked on a proposed-escalated wait (offers GrantFixRound, Requeue, EditBodyAndRequeue) with a published head. */
async function blocked(cause: object | null) {
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
      {
        _tag: 'ProposedEscalated',
        run: anAttemptRef(run.runId),
        proposal: { _tag: 'BuildRed', output: 'red' },
        because: { _tag: 'NotAsked' },
      },
      waitId,
    ),
    ...(cause === null
      ? []
      : [
          ...aTriageStart(item, waitId, 1),
          ...aTriaged(item, waitId, 1, {
            _tag: 'TriageAdvised',
            cause,
            resolution: 'GrantFixRound',
            summary: 's',
            want: null,
          } as never),
        ]),
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
  const grant = (extra: { github?: IssueChannel; picks?: Record<number, string> } = {}, s: EventStore = store) =>
    resolveWaitHolding(
      {
        ticketId,
        issue: ISSUE,
        waitId,
        resolution: { _tag: 'GrantFixRound', onSha: '', ref: '' },
        by: 'human:steven',
        client: { refSha: async () => SHA },
        store: s,
        ...extra,
      },
      ticketId,
    )
  return { store, tickets, ticketId, waitId, grant }
}

const types = async (store: EventStore, id: string) => (await store.read(id)).map((e) => e.type)

describe('GrantFixRound writes the triage answers first (#921)', () => {
  it('writes the section, then resolves — at the version the write left behind', async () => {
    const { store, tickets, ticketId, waitId, grant } = await blocked(undecided)
    expect(await grant({ github: tickets })).toMatchObject({ ok: true })
    const body = (await tickets.getIssue(ISSUE)).body
    expect(body).toContain('which helper? — use ora')
    const seen = await types(store, ticketId)
    expect(seen.lastIndexOf('IssueUpdated')).toBeLessThan(seen.indexOf('WaitResolved'))
    expect(waitsOf(await store.read(ticketId)).at(-1)?.resolution).toMatchObject({ _tag: 'GrantFixRound' })
    expect(waitId).toBeTruthy()
  })

  it('writes a pick over the recommendation, and refuses a stale one writing nothing', async () => {
    const one = await blocked(undecided)
    await one.grant({ github: one.tickets, picks: { 0: 'b' } })
    expect((await one.tickets.getIssue(ISSUE)).body).toContain('which helper? — use nothing')

    const two = await blocked(undecided)
    expect(await two.grant({ github: two.tickets, picks: { 0: 'zzz' } })).toMatchObject({
      ok: false,
      reason: 'stale',
    })
    expect((await two.tickets.getIssue(ISSUE)).body).toBe('the ticket')
    expect(await types(two.store, two.ticketId)).not.toContain('WaitResolved')
  })

  it('resolves nothing when the write fails', async () => {
    const { store, tickets, ticketId, grant } = await blocked(undecided)
    const down: IssueChannel = {
      ...tickets,
      updateBody: async () => {
        throw new Error('github is down')
      },
    }
    expect(await grant({ github: down })).toMatchObject({ ok: false, reason: 'write-failed' })
    expect(await types(store, ticketId)).not.toContain('WaitResolved')
  })

  it('refuses with no client while there are answers to write, and writes nothing without questions', async () => {
    const withQ = await blocked(undecided)
    expect(await withQ.grant()).toMatchObject({ ok: false, reason: 'no-github' })
    expect(await types(withQ.store, withQ.ticketId)).not.toContain('WaitResolved')

    const without = await blocked({ _tag: 'FixableLines', fixes: [] })
    expect(await without.grant()).toMatchObject({ ok: true })
    const none = await blocked(null)
    expect(await none.grant()).toMatchObject({ ok: true })
  })

  it('names path:line for divergent hunks only', async () => {
    const { tickets, grant } = await blocked({
      _tag: 'ConflictingHunks',
      total: 2,
      hunks: [
        { _tag: 'Mechanical', path: 'm.ts', line: 1 },
        { _tag: 'Divergent', path: 'd.ts', line: 7, question },
      ],
    })
    await grant({ github: tickets })
    const body = (await tickets.getIssue(ISSUE)).body
    expect(body).toContain('`d.ts:7` — which helper? — use ora')
    expect(body).not.toContain('m.ts')
  })

  it('does not write on the reschedule path, so the person’s answers are not overwritten', async () => {
    const { tickets, grant } = await blocked(undecided)
    await grant({ github: tickets })
    const first = (await tickets.getIssue(ISSUE)).body
    await tickets.updateBody(ISSUE, first.replace('use ora', 'edited by the person'))
    expect(await grant({ github: tickets })).toMatchObject({ ok: true })
    expect((await tickets.getIssue(ISSUE)).body).toContain('edited by the person')
  })

  it('does not write for Approve', async () => {
    const { store, tickets, ticketId, waitId } = await blocked(undecided)
    await resolveWaitHolding(
      {
        ticketId,
        waitId,
        resolution: { _tag: 'Close' },
        by: 'human:steven',
        github: tickets,
        store,
      },
      ticketId,
    )
    expect((await tickets.getIssue(ISSUE)).body).toBe('the ticket')
  })
})

describe('Requeue writes the triage answers first (#921)', () => {
  it('through requeue(): section, then WaitResolved; no client is refused', async () => {
    const { store, tickets, ticketId } = await blocked(undecided)
    expect(await requeueHolding({ by: 'human:steven', note: '' }, store, ticketId)).toMatchObject({
      ok: false,
      reason: 'no-github',
    })
    expect(await requeueHolding({ by: 'human:steven', note: '', github: tickets }, store, ticketId)).toMatchObject({
      ok: true,
    })
    expect((await tickets.getIssue(ISSUE)).body).toContain('which helper? — use ora')
    const seen = await types(store, ticketId)
    expect(seen.lastIndexOf('IssueUpdated')).toBeLessThan(seen.indexOf('WaitResolved'))
    expect(reduceTicket(await store.read(ticketId)).lifecycle.status).not.toBe('blocked')
  })

  it('a requeue with no triage needs no client', async () => {
    const { store, ticketId } = await blocked(null)
    expect(await requeueHolding({ by: 'human:steven', note: '' }, store, ticketId)).toMatchObject({ ok: true })
  })
})

describe('EditBodyAndRequeue keeps its own text (#921)', () => {
  it('is not overwritten by the composed answers', async () => {
    const { store, tickets, ticketId, waitId } = await blocked(undecided)
    const result = await editBodyAndRequeueHolding(
      { project: PROJECT, issue: ISSUE, waitId, text: 'my own words', by: 'human:steven', github: tickets },
      store,
      ticketId,
    )
    expect(result.ok).toBe(true)
    const body = (await tickets.getIssue(ISSUE)).body
    expect(body).toContain('my own words')
    expect(body).not.toContain('which helper? — use ora')
  })
})
