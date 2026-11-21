import { describe, expect, it } from 'vitest'

import { type CiCheck, ciVerdict } from '../src/pr-checks.ts'

const pushedAt = new Date('2026-11-21T10:00:00Z')
const at = (minutes: number) => new Date(pushedAt.getTime() + minutes * 60_000)
const check = (name: string, state: CiCheck['state'], startedAt?: Date): CiCheck => ({
  name,
  state,
  url: `https://ci/${name}`,
  startedAt,
})
const verdict = (checks: CiCheck[], now: Date, required: readonly string[] | 'all' = 'all', timeoutMs = 3_600_000) =>
  ciVerdict({ checks, required, pushedAt, now, timeoutMs })

describe('ciVerdict', () => {
  it('all success, neutral and skipped is green', () => {
    expect(verdict([check('a', 'success'), check('b', 'neutral'), check('c', 'skipped')], at(5))).toEqual({
      kind: 'green',
    })
  })
  it('one failure is red naming it', () => {
    expect(verdict([check('a', 'success'), check('e2e', 'failure')], at(5))).toEqual({
      kind: 'red',
      failing: [{ name: 'e2e', state: 'failure', url: 'https://ci/e2e' }],
    })
  })
  it('unknown is failing', () => {
    expect(verdict([check('a', 'unknown')], at(5)).kind).toBe('red')
  })
  it('a queued check is running', () => {
    expect(verdict([check('a', 'success'), check('b', 'queued')], at(5)).kind).toBe('running')
  })
  it('no checks: running under 30 minutes, none-started after', () => {
    expect(verdict([], at(29)).kind).toBe('running')
    expect(verdict([], at(30)).kind).toBe('none-started')
  })
  it('a check running past the timeout is timed-out', () => {
    expect(verdict([check('a', 'running', at(1))], at(90), 'all', 60 * 60_000).kind).toBe('timed-out')
    expect(verdict([check('a', 'running', at(1))], at(30), 'all', 60 * 60_000).kind).toBe('running')
  })
  it('only the required names count: a failing preview beside a green test is green', () => {
    expect(verdict([check('test', 'success'), check('preview', 'failure')], at(5), ['test'])).toEqual({ kind: 'green' })
  })
  it('a required name absent from the head is running, and ends in timed-out', () => {
    expect(verdict([check('preview', 'success')], at(5), ['test']).kind).toBe('running')
    expect(verdict([check('preview', 'success')], at(90), ['test'], 60 * 60_000).kind).toBe('timed-out')
  })
})
