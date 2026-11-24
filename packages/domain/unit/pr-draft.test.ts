/** A PR's draft (#1390): a state, and the tickets in it, built from `PrDraftTicketAdded`. */
import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/envelope.ts'
import { addDraftTicket, emptyPr, isOpen, reducePr, requestSubmit, type PrState, type PrStatus } from '../src/pr.ts'

let seq = 0n
const ev = (type: string, data: unknown): Envelope =>
  ({
    type,
    data,
    streamId: 'pr-lingtai-1',
    seq: ++seq,
    version: Number(seq),
    actor: 'conductor',
  }) as unknown as Envelope

const added = (ticket: string, mergeCommit: string, from: number | null = null) =>
  ev('PrDraftTicketAdded', { ticket, mergeCommit, from })
const requested = () => ev('PrSubmitRequested', { by: 'human:a' })
const refused = () => ev('PrSubmitRefused', { reason: 'git', detail: 'no' })

describe('a PR in draft', () => {
  it('one PrDraftTicketAdded is a draft holding the ticket', () => {
    const s = reducePr([added('t1', 'a')])
    expect(s.status).toBe('draft')
    expect(s.project).toBe('lingtai')
    expect(s.n).toBe(1)
    expect(s.draft).toEqual([{ ticket: 't1', mergeCommit: 'a', from: null }])
  })

  it('the same ticket twice is one entry, in its place, with the later merge commit', () => {
    const s = reducePr([added('t1', 'a'), added('t2', 'b'), added('t1', 'c', 4)])
    expect(s.draft).toEqual([
      { ticket: 't1', mergeCommit: 'c', from: 4 },
      { ticket: 't2', mergeCommit: 'b', from: null },
    ])
  })

  it('a submit request keeps the draft; a refusal then returns to draft with the refusal', () => {
    const asked = reducePr([added('t1', 'a'), requested()])
    expect(asked.status).toBe('requested')
    expect(asked.draft).toHaveLength(1)
    const back = reducePr([added('t1', 'a'), requested(), refused()])
    expect(back.status).toBe('draft')
    expect(back.draft).toHaveLength(1)
    expect(back.refusal).toEqual({ reason: 'git', detail: 'no' })
  })

  it('a refusal with no draft ticket is refused, as before', () => {
    expect(reducePr([requested(), refused()]).status).toBe('refused')
  })

  it('PrInProgress empties the draft', () => {
    const s = reducePr([
      added('t1', 'a'),
      requested(),
      ev('PrInProgress', {
        because: 'submit',
        branch: 'b',
        main: 'm',
        frozenSha: 'f',
        prBranch: 'b-pr-1',
        tickets: [{ ticket: 't1', mergeCommit: 'a', title: 'T' }],
      }),
    ])
    expect(s.status).toBe('in-progress')
    expect(s.draft).toEqual([])
  })

  it('is not open', () => {
    expect(isOpen({ ...emptyPr, status: 'draft' })).toBe(false)
  })

  it('addDraftTicket appends from null, draft and requested, and from nothing else', () => {
    const data = { ticket: 't', mergeCommit: 'a', from: null }
    const statuses: (PrStatus | null)[] = [
      null,
      'draft',
      'requested',
      'in-progress',
      'waiting',
      'in-review',
      'refused',
      'merged',
      'closed',
    ]
    for (const status of statuses) {
      const state: PrState = { ...emptyPr, status }
      const got = addDraftTicket(state, data)
      if (status === null || status === 'draft' || status === 'requested') {
        expect(got).toEqual({ type: 'PrDraftTicketAdded', actor: 'conductor', data })
      } else expect(got).toBeNull()
    }
  })

  it('requestSubmit refuses nothing-landed when no draft was found', () => {
    const got = requestSubmit(null, 'team', 'lingtai', 'human:a', false)
    expect(got).toMatchObject({ kind: 'refused', reason: 'nothing-landed' })
  })
})
