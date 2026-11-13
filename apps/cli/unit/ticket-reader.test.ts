import type { ReadProjectTicket, readProjectTicketEffect } from '@lingtai/conductor/read-ticket'
/**
 * The discussion's and triage's ticket reads go through the one reader (#731).
 * `ticketEvidence` is what `gatherEvidence` does with the ticket, pulled out so
 * it needs no event store or mirror; `triageIssue` is triage's `issue` port.
 */
import type { ProjectState } from '@lingtai/domain'
import { ticketStream } from '@lingtai/domain'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { ticketEvidence } from '../src/discuss.ts'
import { triageIssue } from '../src/triage.ts'

const state = { project: 'garden', owner: null, base: 'main' } as ProjectState
type Read = typeof readProjectTicketEffect
const record = { number: 2, title: 'water', body: 'the body', labels: [], url: null, state: 'open' } as never
const absent = new Error('no ticket #2 for project garden')
const found: Read = () => Effect.succeed({ ok: true, from: 'db', ticket: record })
const missing: Read = () => Effect.succeed({ ok: false, from: 'db', error: absent })

describe('ticketEvidence (what gatherEvidence reads the ticket with)', () => {
  it('carries a db ticket read by the reader', async () => {
    expect(await Effect.runPromise(ticketEvidence(state, 'garden', 2, found))).toEqual({
      ticket: { ref: '2', title: 'water', body: 'the body' },
      ticketProblem: null,
    })
  })
  it('says why when the reader rejects', async () => {
    expect(await Effect.runPromise(ticketEvidence(state, 'garden', 2, missing))).toEqual({
      ticket: null,
      ticketProblem: 'no ticket #2 for project garden',
    })
  })
  it('says the project is not registered when there is no state', async () => {
    expect((await Effect.runPromise(ticketEvidence(null, 'garden', 2, found))).ticketProblem).toBe(
      'garden is not a registered project',
    )
  })
})

describe('triageIssue', () => {
  const load = () => Effect.succeed(state)
  it('answers the ticket the reader found', async () => {
    expect(await Effect.runPromise(triageIssue(found, load)(ticketStream('garden', 2)))).toEqual({
      ref: '2',
      title: 'water',
      body: 'the body',
    })
  })
  it('throws the reader’s error unchanged', async () => {
    await expect(Effect.runPromise(triageIssue(missing, load)(ticketStream('garden', 2)))).rejects.toThrow(
      'no ticket #2 for project garden',
    )
  })
})
