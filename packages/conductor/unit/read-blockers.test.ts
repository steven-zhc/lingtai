import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'

import { BLOCKERS_FRESH_MS, BLOCKERS_READ_MOST, forgetBlockers, readBlockersEffect } from '../src/blockers.ts'

const skip = (ref: number) => ({
  ref,
  reason: 'blocked-by' as const,
  title: `t${ref}`,
  kind: 'bug',
  blockedBy: 1,
  label: null,
  parent: null,
  subIssues: null,
})
const stub = () => {
  const calls: number[] = []
  return {
    calls,
    links: {
      repository: 'o/r',
      listBlockedBy: async (n: number) => {
        calls.push(n)
        if (n === 2) throw new Error('boom')
        return [{ repository: 'o/r', number: 99, title: '', state: 'open' as const }]
      },
    },
  }
}

describe('readBlockersEffect', () => {
  beforeEach(forgetBlockers)

  it('reads at most the cap, caches, and keeps a failure per skip', async () => {
    const { calls, links } = stub()
    const skipped = Array.from({ length: BLOCKERS_READ_MOST + 3 }, (_, i) => skip(i + 1)) as never
    const out = await Effect.runPromise(readBlockersEffect({ project: 'p', links }, skipped, () => 0))
    expect(calls).toHaveLength(BLOCKERS_READ_MOST)
    expect(out[1]?.blockers).toEqual({ ok: false, problem: 'boom' })
    expect(out.filter((s) => s.unread)).toHaveLength(3)
    await Effect.runPromise(readBlockersEffect({ project: 'p', links }, skipped, () => BLOCKERS_FRESH_MS - 1))
    expect(calls).toHaveLength(BLOCKERS_READ_MOST)
    await Effect.runPromise(readBlockersEffect({ project: 'p', links }, skipped, () => BLOCKERS_FRESH_MS))
    expect(calls).toHaveLength(BLOCKERS_READ_MOST * 2)
  })

  it('asks nothing when no link reader exists', async () => {
    const out = await Effect.runPromise(readBlockersEffect({ project: 'p', links: null }, [skip(1)] as never, () => 0))
    expect(out[0]).toMatchObject({ blockers: null, unread: false })
  })
})
