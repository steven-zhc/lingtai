import { describe, expect, it } from 'vitest'

import {
  type Envelope,
  accountCheck,
  emptyAccount,
  liftTransition,
  reachTransition,
  parseStoredPayload,
  reduceAccount,
} from '../src/index.ts'

const reached = (until: string, at: string, seq: bigint, version: number): Envelope => ({
  seq,
  streamId: 'acct-claude-code',
  version,
  type: 'AccountLimitReached',
  schemaVer: 2,
  data: { account: 'claude-code', until, untilFrom: 'message', said: 'limit' },
  actor: 'conductor',
  causation: null,
  at: new Date(at),
})
const lifted = (seq: bigint, version: number): Envelope => ({
  seq,
  streamId: 'acct-claude-code',
  version,
  type: 'AccountLimitLifted',
  schemaVer: 2,
  data: { account: 'claude-code' },
  actor: 'conductor',
  causation: null,
  at: new Date('2026-01-01T03:00:00Z'),
})

const FIELDS = { until: '2026-01-01T05:00:00Z', untilFrom: 'backoff', said: '' } as const

describe('the Account aggregate', () => {
  it('an empty stream is no limit', () => {
    expect(reduceAccount([])).toEqual(emptyAccount)
  })

  it('AccountLimitReached sets the limit from the event and its envelope', () => {
    const s = reduceAccount([reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1)])
    expect(s.limit).toEqual({
      until: new Date('2026-01-01T05:00:00Z'),
      untilFrom: 'message',
      said: 'limit',
      named: null,
      since: new Date('2026-01-01T01:00:00Z'),
      seq: 7n,
    })
    expect(s.version).toBe(1)
  })

  it('a second one keeps the first since and until', () => {
    const s = reduceAccount([
      reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1),
      reached('2026-01-01T09:00:00Z', '2026-01-01T02:00:00Z', 8n, 2),
    ])
    expect(s.limit?.until).toEqual(new Date('2026-01-01T05:00:00Z'))
    expect(s.limit?.since).toEqual(new Date('2026-01-01T01:00:00Z'))
    expect(s.version).toBe(2)
  })

  it('AccountLimitLifted clears it, and a lift with nothing standing changes nothing', () => {
    const s = reduceAccount([reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1), lifted(8n, 2)])
    expect(s.limit).toBeNull()
    expect(reduceAccount([lifted(1n, 1)]).limit).toBeNull()
  })

  it('transitions answer null when there is nothing to do', () => {
    const limited = reduceAccount([reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1)])
    expect(reachTransition(limited, 'claude-code', FIELDS)).toBeNull()
    expect(liftTransition(emptyAccount, 'claude-code', 'human:x')).toBeNull()
    expect(reachTransition(emptyAccount, 'claude-code', FIELDS)?.type).toBe('AccountLimitReached')
    expect(liftTransition(limited, 'claude-code', 'human:x')).toMatchObject({
      type: 'AccountLimitLifted',
      actor: 'human:x',
      data: { account: 'claude-code', by: 'human:x' },
    })
  })

  it('accountCheck lifts at and after until, never before, never when nothing stands', () => {
    const state = reduceAccount([reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1)])
    const check = (now: string) => accountCheck({ state, account: 'claude-code', now: new Date(now) })
    expect(check('2026-01-01T04:59:59Z')).toEqual([])
    expect(check('2026-01-01T05:00:00Z')).toMatchObject([
      { type: 'AccountLimitLifted', data: { account: 'claude-code' } },
    ])
    expect(check('2026-01-02T00:00:00Z')).toHaveLength(1)
    expect(accountCheck({ state: emptyAccount, account: 'claude-code', now: new Date() })).toEqual([])
  })

  it('never lifts a limit whose until does not parse', () => {
    const state = reduceAccount([reached('not a date', '2026-01-01T01:00:00Z', 7n, 1)])
    expect(accountCheck({ state, account: 'claude-code', now: new Date('2030-01-01') })).toEqual([])
  })

  it('reduces a stored schemaVer 1 row, which says runtime, to the state it had before', () => {
    const old = parseStoredPayload('AccountLimitReached', 1, {
      runtime: 'claude-code',
      until: '2026-01-01T05:00:00Z',
      untilFrom: 'message',
      said: 'limit',
    })
    const oldLift = parseStoredPayload('AccountLimitLifted', 1, { runtime: 'claude-code', by: 'human:x' })
    expect(old).toEqual({ account: 'claude-code', until: '2026-01-01T05:00:00Z', untilFrom: 'message', said: 'limit' })
    expect(oldLift).toEqual({ account: 'claude-code', by: 'human:x' })
    expect(parseStoredPayload('AccountLimitLifted', 1, { runtime: 'codex' })).toEqual({ account: 'codex' })
    const a = reduceAccount([{ ...reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1), data: old }])
    const b = reduceAccount([reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1)])
    expect(a).toEqual(b)
    expect(a.account).toBe('claude-code')
  })

  it('names github as an account and refuses another code host', () => {
    expect(
      liftTransition(
        reduceAccount([
          {
            ...reached('2026-01-01T05:00:00Z', '2026-01-01T01:00:00Z', 7n, 1),
            data: { account: 'github', until: '2026-01-01T05:00:00Z', untilFrom: 'message', said: '' },
          },
        ]),
        'github',
        'human:x',
      )?.data,
    ).toEqual({ account: 'github', by: 'human:x' })
    expect(() => parseStoredPayload('AccountLimitLifted', 2, { account: 'gitlab' })).toThrow()
  })
})
