/**
 * **A waiting comment is rewritten into its outcome when the wait ends** (#750).
 *
 * Memory event store and memory `Tickets`: no network, no Postgres. The
 * properties held here are the ticket's — one comment per wait, edited at most
 * once, never answered with a second comment, and only by the caller that asks.
 */
import { type ToAppend, parsePayload } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { describe, expect, it } from 'vitest'

import { type RefChannel, tellGitHubAbout } from '../src/tell.ts'
import { passClientOf } from '../src/ticket-store.ts'
import { memoryTickets } from '../test/memory-tickets.ts'

const ticketId = 'ticket-p-1'
const QUESTION = "the  proposed  step held: Land this? The setup was answered 'hold'."
const refs: RefChannel = { matchingRefs: async () => [], deleteRef: async () => {} }

async function world() {
  const store = createMemoryEventStore()
  const tickets = memoryTickets()
  await tickets.createIssue({ title: 't', body: 'b', labels: [] })
  const github = { ...tickets, getIssue: async () => ({ labels: [], body: 'b' }), ...refs }
  const add = async (events: ToAppend[]) => {
    await store.append(ticketId, (await store.read(ticketId)).length, events)
  }
  const wait = (waitId: string): ToAppend => ({
    type: 'WaitStarted',
    actor: 'conductor',
    data: parsePayload('WaitStarted', {
      waitId,
      reason: { _tag: 'OwnQuestion', question: 'q', by: 'steven' },
    }),
  })
  const resolve = (waitId: string, resolution: unknown, by = 'human:steven'): ToAppend => ({
    type: 'WaitResolved',
    actor: by,
    data: { waitId, by, resolution, note: '' } as never,
  })
  const hold = (waitId: string, question = QUESTION) =>
    tellGitHubAbout({ store, github, ticketId, question, waitId, editEnded: true })
  const events = async (type: string) => (await store.read(ticketId)).filter((e) => e.type === type)
  return { store, tickets, github, add, wait, resolve, hold, events }
}

describe('the waiting comment becomes its outcome', () => {
  it('a landing edits the one comment, and posts no second', async () => {
    const w = await world()
    await w.add([w.wait('w1')])
    await w.hold('w1')
    await w.add([
      w.resolve('w1', { _tag: 'Approve', onSha: 'x' }),
      { type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: 'ab5848a1234', base: 'main' } },
    ])
    await tellGitHubAbout({ store: w.store, github: w.github, ticketId, editEnded: true })
    expect(w.tickets.commentBodies(1)).toEqual([`**Landed on \`main\` in \`ab5848a\`.**\n\n> ${QUESTION}`])
    const edited = (await w.events('IssueUpdated')).filter(
      (e) => (e.data as { change: string }).change === 'comment-edited',
    )
    expect(edited).toHaveLength(1)
    expect((edited[0]!.data as { waitId: string }).waitId).toBe('w1')
  })

  it.each([
    [{ _tag: 'Approve', onSha: 'x' }, '**Approved by steven.**'],
    [{ _tag: 'GrantFixRound', onSha: 'x', ref: 'r' }, '**One more fix round, granted by steven.**'],
    [{ _tag: 'Requeue' }, '**Requeued by steven — a new pass started.**'],
    [{ _tag: 'EditBodyAndRequeue' }, '**Requeued by steven — a new pass started.**'],
    [{ _tag: 'AnswerQuestion', choice: 'main' }, '**Answered by steven: `main`**'],
    [
      {
        _tag: 'Split',
        children: [
          { key: 'a', title: 'A', body: 'do it', kind: 'bug' },
          { key: 'b', title: 'B', body: 'do it', kind: 'bug' },
        ],
        blockedBy: [],
      },
      '**Split by steven.**',
    ],
  ])('%j reads %s', async (resolution, line) => {
    const w = await world()
    await w.add([w.wait('w1')])
    await w.hold('w1')
    await w.add([w.resolve('w1', resolution)])
    await tellGitHubAbout({ store: w.store, github: w.github, ticketId, editEnded: true })
    expect(w.tickets.commentBodies(1)).toEqual([`${line}\n\n> ${QUESTION}`])
  })

  it('an empty sha and an empty actor leave no undefined behind', async () => {
    const w = await world()
    await w.add([w.wait('w1')])
    await w.hold('w1')
    await w.add([{ type: 'TicketLanded', actor: 'conductor', data: { mergeCommit: '', base: 'main' } }])
    await tellGitHubAbout({ store: w.store, github: w.github, ticketId, editEnded: true })
    expect(w.tickets.commentBodies(1)[0]).toMatch(/^\*\*Landed on `main`\.\*\*/)
  })

  it('without editEnded (close.ts, end.ts) nothing is edited or recorded', async () => {
    const w = await world()
    await w.add([w.wait('w1')])
    await w.hold('w1')
    await w.add([w.resolve('w1', { _tag: 'Approve', onSha: 'x' })])
    await tellGitHubAbout({ store: w.store, github: w.github, ticketId })
    expect(w.tickets.commentBodies(1)[0]).toMatch(/^\*\*Lingtai is waiting on you/)
    expect(
      (await w.events('IssueUpdated')).some((e) => (e.data as { change: string }).change === 'comment-edited'),
    ).toBe(false)
  })

  it('a held-again continuation edits the old comment before posting the new one', async () => {
    const w = await world()
    await w.add([w.wait('w1')])
    await w.hold('w1')
    await w.add([w.resolve('w1', { _tag: 'Approve', onSha: 'x' }), w.wait('w2')])
    await w.hold('w2', 'second?')
    const bodies = w.tickets.commentBodies(1)
    expect(bodies).toHaveLength(2)
    expect(bodies[0]).toBe(`**Approved by steven.**\n\n> ${QUESTION}`)
    expect(bodies[1]).toMatch(/waiting on you/)
    await tellGitHubAbout({ store: w.store, github: w.github, ticketId, editEnded: true })
    expect(w.tickets.commentBodies(1)[1]).toMatch(/waiting on you/)
  })

  it('a failed edit is recorded once, posts nothing, and is not tried again', async () => {
    const w = await world()
    await w.add([w.wait('w1')])
    await w.hold('w1')
    await w.add([w.resolve('w1', { _tag: 'Approve', onSha: 'x' })])
    let tries = 0
    const github = {
      ...w.github,
      editComment: async () => {
        tries++
        throw new Error('404')
      },
    }
    await tellGitHubAbout({ store: w.store, github, ticketId, editEnded: true })
    await tellGitHubAbout({ store: w.store, github, ticketId, editEnded: true })
    expect(tries).toBe(1)
    expect(w.tickets.commentBodies(1)).toHaveLength(1)
    const failed = await w.events('IssueUpdateFailed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.data).toMatchObject({ change: 'comment-edited', waitId: 'w1' })
  })

  it('a comment posted without a waitId is never edited', async () => {
    const w = await world()
    await w.add([w.wait('w1')])
    const { id } = await w.tickets.comment(1, '**Lingtai is waiting on you.**')
    await w.add([
      {
        type: 'IssueUpdated',
        actor: 'conductor',
        data: parsePayload('IssueUpdated', { project: 'p', issue: '1', change: 'comment', detail: String(id) }),
      },
      w.resolve('w1', { _tag: 'Approve', onSha: 'x' }),
    ])
    await tellGitHubAbout({ store: w.store, github: w.github, ticketId, editEnded: true })
    expect(w.tickets.commentBodies(1)).toEqual(['**Lingtai is waiting on you.**'])
  })
})

describe('passClientOf', () => {
  it("sends a database project's edit to its Tickets, not GitHub", async () => {
    const tickets = memoryTickets()
    await tickets.createIssue({ title: 't', body: 'b', labels: [] })
    const { id } = await tickets.comment(1, 'old')
    const client = {
      editComment: async () => {
        throw new Error('reached GitHub')
      },
    } as never
    await passClientOf(client, tickets).editComment(1, id, 'new')
    expect(tickets.commentBodies(1)).toEqual(['new'])
  })
})
