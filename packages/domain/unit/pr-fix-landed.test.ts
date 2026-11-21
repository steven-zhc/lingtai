/** A pr-fix landing on a PR's branch (#1341): owed In progress again, once, and only while the PR is open. */
import { describe, expect, it } from 'vitest'

import type { Envelope } from '../src/envelope.ts'
import { emptyPr, fixLandedTransition, fixRestartTransition, reducePrEvent, type PrState } from '../src/pr.ts'

const head = 'a'.repeat(40)
const fixHead = 'b'.repeat(40)

const inReview: PrState = {
  ...emptyPr,
  status: 'in-review',
  n: 1,
  branch: 'feature',
  main: 'main',
  prBranch: 'feature-pr-1',
  frozenSha: head,
  target: head,
  lastPushed: head,
  tickets: [{ ticket: '10', mergeCommit: head, title: 'ten' }],
}

const event = (type: string, data: unknown): Envelope =>
  ({ type, data, streamId: 'pr-p-1', version: 5, seq: 9n, at: new Date(0) }) as unknown as Envelope

describe('PrFixLanded', () => {
  it('is appended for an open PR, and a ticket the PR already holds appends nothing', () => {
    const landed = { ticket: '11', mergeCommit: fixHead }
    expect(fixLandedTransition(inReview, landed)).toMatchObject({ type: 'PrFixLanded', data: landed })
    expect(fixLandedTransition(inReview, { ticket: '10', mergeCommit: fixHead })).toBeNull()
  })

  it('is refused on a PR that has ended, and on one that was never frozen', () => {
    const landed = { ticket: '11', mergeCommit: fixHead }
    for (const status of ['merged', 'closed', 'refused', 'requested'] as const) {
      expect(fixLandedTransition({ ...inReview, status }, landed)).toBeNull()
    }
  })

  it('makes the fix the PR branch head and the target, adds the ticket, and owes In progress', () => {
    const after = reducePrEvent(inReview, event('PrFixLanded', { ticket: '11', mergeCommit: fixHead, title: 'fix' }))
    expect(after).toMatchObject({ lastPushed: fixHead, target: fixHead, fixOwed: true })
    expect(after.tickets.map((t) => t.ticket)).toEqual(['10', '11'])
  })

  it('is answered by In progress because pr-fix, frozen on the fix head, which clears the debt', () => {
    const owed = reducePrEvent(inReview, event('PrFixLanded', { ticket: '11', mergeCommit: fixHead }))
    const restart = fixRestartTransition(owed)
    expect(restart).toMatchObject({ type: 'PrInProgress', data: { because: 'pr-fix', frozenSha: fixHead } })
    const again = reducePrEvent(owed, event('PrInProgress', restart!.data))
    expect(again).toMatchObject({ status: 'in-progress', fixOwed: false, target: fixHead, steps: [] })
    expect(fixRestartTransition(again)).toBeNull()
  })

  it('answers nothing for a PR that is not owed one', () => {
    expect(fixRestartTransition(inReview)).toBeNull()
  })
})

describe('what an ending and a merge back cover is per ticket (#1341)', () => {
  const frozen = { ...inReview, covers: { [head]: 1 } }
  const landed = reducePrEvent(frozen, event('PrFixLanded', { ticket: '11', mergeCommit: fixHead }))

  it('a PR merged at the old head holds only the tickets that head held', () => {
    const merged = reducePrEvent(landed, event('PrMerged', { how: 'host', headSha: head, mergeSha: null }))
    expect(merged.mergedTickets).toEqual(['10'])
  })

  it('a PR merged at the fix head holds both', () => {
    const merged = reducePrEvent(landed, event('PrMerged', { how: 'git', headSha: fixHead, mergeSha: null }))
    expect(merged.mergedTickets).toEqual(['10', '11'])
  })

  it('a merge back carries the tickets of its head, and a later fix does not take that away', () => {
    const back = reducePrEvent(
      landed,
      event('PrMergedBack', { prHead: fixHead, mergeCommit: 'c'.repeat(40), how: 'clean' }),
    )
    const later = reducePrEvent(back, event('PrFixLanded', { ticket: '12', mergeCommit: 'e'.repeat(40) }))
    expect(later.mergedBackTickets).toEqual(['10', '11'])
  })
})
