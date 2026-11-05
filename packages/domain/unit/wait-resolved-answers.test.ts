import { describe, expect, it } from 'vitest'

import { parsePayload } from '../src/index.ts'

const base = { waitId: 'w1', by: 'human:x', resolution: { _tag: 'Close' }, note: '' }

describe('WaitResolved.answers (#924)', () => {
  it('parses with and without answers', () => {
    expect(parsePayload('WaitResolved', base)).not.toHaveProperty('answers')
    const answers = { picks: [{ index: 0, answerId: 'a' }], section: 's' }
    expect(parsePayload('WaitResolved', { ...base, answers })).toMatchObject({ answers })
  })
  it('refuses a negative index', () => {
    expect(() =>
      parsePayload('WaitResolved', { ...base, answers: { picks: [{ index: -1, answerId: 'a' }], section: 's' } }),
    ).toThrow()
  })
})
