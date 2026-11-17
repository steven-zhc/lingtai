import { describe, expect, it } from 'vitest'

import { emptyAccount, githubLimitUntil, reduceAccountEvent, type Envelope } from '../src/index.ts'

const now = new Date('2026-11-16T12:00:00Z')
const base: { detail: string; retryAfter: number | null; ratelimitReset: number | null } = {
  detail: 'API rate limit exceeded',
  retryAfter: null,
  ratelimitReset: null,
}
const until = (failed: Partial<typeof base>, doublings = 0) =>
  githubLimitUntil({ failed: { ...base, ...failed }, now, account: { doublings } })
const min = (n: number) => new Date(now.getTime() + n * 60_000)

describe('githubLimitUntil', () => {
  it('retry-after is seconds from now, but at least a minute', () => {
    expect(until({ retryAfter: 120 })).toMatchObject({ until: min(2), untilFrom: 'retry-after' })
    expect(until({ retryAfter: 30 }).until).toEqual(min(1))
  })
  it('x-ratelimit-reset is epoch seconds', () => {
    const r = until({ ratelimitReset: Math.floor(now.getTime() / 1000) + 3600 })
    expect(r).toMatchObject({ until: min(60), untilFrom: 'ratelimit-reset' })
  })
  it('retry-after wins over a reset', () => {
    expect(until({ retryAfter: 300, ratelimitReset: Math.floor(now.getTime() / 1000) + 3600 }).untilFrom).toBe(
      'retry-after',
    )
  })
  it('a reset in the past is clamped to a minute', () => {
    expect(until({ ratelimitReset: 1 }).until).toEqual(min(1))
  })
  it('an unparsable header is absent', () => {
    expect(until({ retryAfter: Number.NaN, ratelimitReset: -4 })).toMatchObject({
      untilFrom: 'doubling',
      until: min(1),
    })
  })
  it('doubles and caps at an hour', () => {
    expect(until({}, 1).until).toEqual(min(2))
    expect(until({}, 3).until).toEqual(min(8))
    expect(until({}, 7).until).toEqual(min(60))
  })
  it("says GitHub's words, collapsed and cut", () => {
    expect(until({ detail: `  a\n  b ${'x'.repeat(300)}` }).said).toHaveLength(200)
  })
})

let seq = 0n
const ev = (type: string, data: object): Envelope =>
  ({ type, data, seq: ++seq, version: Number(seq), at: now, actor: 'x' }) as unknown as Envelope
const reached = (untilFrom: string) =>
  ev('AccountLimitReached', { account: 'github', until: min(1).toISOString(), untilFrom, said: '' })
const guardLift = () => ev('AccountLimitLifted', { account: 'github' })
const reduce = (...e: Envelope[]) => e.reduce(reduceAccountEvent, emptyAccount).doublings

describe('doublings', () => {
  it("counts doubling locks across the guard's lifts", () => {
    expect(reduce(reached('doubling'), guardLift(), reached('doubling'), guardLift())).toBe(2)
  })
  it("a person's lift resets it", () => {
    expect(reduce(reached('doubling'), ev('AccountLimitLifted', { account: 'github', by: 'me' }))).toBe(0)
  })
  it('a header lock resets it', () => {
    expect(reduce(reached('doubling'), guardLift(), reached('ratelimit-reset'))).toBe(0)
  })
  it('is zero with no events', () => {
    expect(reduce()).toBe(0)
  })
})
