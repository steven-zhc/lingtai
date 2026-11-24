import { describe, expect, it } from 'vitest'

import { emptyPr, reducePrEvent } from '../src/pr.ts'

const at = (iso: string) => new Date(iso)
const ev = (seq: number, type: string, data: object, iso: string) =>
  ({ seq, type, data, at: at(iso), streamId: 'pr-p-1', actor: 'human:x' }) as never
const started = (seq: number, iso: string) =>
  ev(seq, 'PrInProgress', { branch: 'b', main: 'm', prBranch: 'pb', frozenSha: 'abc', tickets: [] }, iso)

describe('the PR fold keeps the submit and the first start', () => {
  it('takes requestedAt from every request, and startedAt from the first start only', () => {
    expect(emptyPr.requestedAt).toBeNull()
    expect(emptyPr.startedAt).toBeNull()
    const requested = reducePrEvent(emptyPr, ev(1, 'PrSubmitRequested', { by: 'human:x' }, '2026-11-24T19:55:00Z'))
    expect(requested.requestedAt).toEqual(at('2026-11-24T19:55:00Z'))
    expect(requested.startedAt).toBeNull()
    const again = reducePrEvent(requested, ev(2, 'PrSubmitRequested', { by: 'human:x' }, '2026-11-24T20:00:00Z'))
    expect(again.requestedAt).toEqual(at('2026-11-24T20:00:00Z'))
    const first = reducePrEvent(again, started(3, '2026-11-24T20:02:00Z'))
    const restart = reducePrEvent(first, started(4, '2026-11-24T21:00:00Z'))
    expect(restart.startedAt).toEqual(at('2026-11-24T20:02:00Z'))
  })
})
