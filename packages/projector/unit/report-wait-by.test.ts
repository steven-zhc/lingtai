import { describe, expect, it } from 'vitest'

import { reportWaitOf } from '../src/ticket-report.ts'

const wait = (resolution: unknown) =>
  ({
    waitId: 'w1',
    at: new Date('2026-11-17T00:00:00Z'),
    reason: { _tag: 'ReviewFailed' },
    triage: { started: null, result: null },
    resolution,
  }) as never

describe('reportWaitOf carries who decided and on which sha', () => {
  it('GrantFixRound keeps by and onSha', () => {
    const w = reportWaitOf(wait({ resolution: { _tag: 'GrantFixRound', onSha: '2f5bea9', ref: 'r' }, by: 'alice' }))
    expect(w.by).toBe('alice')
    expect(w.onSha).toBe('2f5bea9')
  })
  it('Requeue has no sha', () => {
    const w = reportWaitOf(wait({ resolution: { _tag: 'Requeue' }, by: 'alice' }))
    expect(w).toMatchObject({ resolution: 'Requeue', by: 'alice', onSha: null })
  })
  it('an open wait has neither', () => {
    expect(reportWaitOf(wait(null))).toMatchObject({ by: null, onSha: null })
  })
})
