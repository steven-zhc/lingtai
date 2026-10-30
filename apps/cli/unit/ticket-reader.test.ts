import type { ReadProjectTicket } from '@lingtai/conductor/read-ticket'
/**
 * The discussion's and triage's ticket reads go through the one reader (#731).
 * `ticketEvidence` is what `gatherEvidence` does with the ticket, pulled out so
 * it needs no event store or mirror; `triageIssue` is triage's `issue` port.
 */
import type { ProjectState } from '@lingtai/domain'
import { ticketStream } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { ticketEvidence } from '../src/discuss.ts'
import { triageIssue } from '../src/triage.ts'

const state = { project: 'garden', owner: null, base: 'main' } as ProjectState
const found: ReadProjectTicket = async () => ({
  ok: true,
  from: 'db',
  ticket: { number: 2, title: 'water', body: 'the body', labels: [], url: null, state: 'open' } as never,
})
const missing: ReadProjectTicket = async () => ({
  ok: false,
  from: 'db',
  error: new Error('no ticket #2 for project garden'),
})

describe('ticketEvidence (what gatherEvidence reads the ticket with)', () => {
  it('carries a db ticket read by the reader', async () => {
    expect(await ticketEvidence(state, 'garden', 2, found)).toEqual({
      ticket: { ref: '2', title: 'water', body: 'the body' },
      ticketProblem: null,
    })
  })
  it('says why when the reader rejects', async () => {
    expect(await ticketEvidence(state, 'garden', 2, missing)).toEqual({
      ticket: null,
      ticketProblem: 'no ticket #2 for project garden',
    })
  })
  it('says the project is not registered when there is no state', async () => {
    expect((await ticketEvidence(null, 'garden', 2, found)).ticketProblem).toBe('garden is not a registered project')
  })
})

describe('triageIssue', () => {
  const load = async () => state
  it('answers the ticket the reader found', async () => {
    expect(await triageIssue(found, load)(ticketStream('garden', 2))).toEqual({
      ref: '2',
      title: 'water',
      body: 'the body',
    })
  })
  it('throws the reader’s error unchanged', async () => {
    await expect(triageIssue(missing, load)(ticketStream('garden', 2))).rejects.toThrow(
      'no ticket #2 for project garden',
    )
  })
})
