import { Effect } from 'effect'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  BLOCKERS_FRESH_MS,
  BLOCKERS_READ_MOST,
  cachedBlockers,
  forgetBlockers,
  readBlockersEffect,
} from '../src/blockers.ts'

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

  it('a discovery read through cachedBlockers is the one request: the explaining read finds it', async () => {
    const { calls, links } = stub()
    const read = cachedBlockers('p', links, () => 0)!
    await read.listBlockedBy(7, 1)
    const out = await Effect.runPromise(readBlockersEffect({ project: 'p', links }, [skip(7)] as never, () => 0))
    expect(calls).toEqual([7])
    expect(out[0]?.blockers).toMatchObject({ ok: true })
    // A failed read is cached as a failure and still rejects.
    await expect(read.listBlockedBy(2, 1)).rejects.toThrow('boom')
    await expect(read.listBlockedBy(2, 1)).rejects.toThrow('boom')
    expect(calls).toEqual([7, 2])
  })

  it('what discovery read rides on the skip: the explanation reads nothing, however late or often it is asked', async () => {
    const { calls, links } = stub()
    const read = { ok: true as const, issues: [] }
    const rode = { ...skip(7), blockersRead: read }
    const full = { ...skip(8), blockersRead: { ok: false as const, problem: 'it has 100 blockers or more' } }
    for (const clock of [0, BLOCKERS_FRESH_MS + 1, 10_000_000]) {
      const out = await Effect.runPromise(
        readBlockersEffect({ project: 'p', links }, [rode, full] as never, () => clock),
      )
      expect(out.map((o) => o.blockers)).toEqual([read, full.blockersRead])
    }
    expect(calls).toEqual([])
  })

  it("carries the queue's own reason on the skip it explains", async () => {
    const { links } = stub()
    const held = { ...skip(7), held: "could not read the project's PRs: x" }
    const out = await Effect.runPromise(readBlockersEffect({ project: 'p', links }, [held] as never, () => 0))
    expect(out[0]?.held).toBe(held.held)
  })
})
