import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { explainQueueEffect, type WhyFacts, type WhyReads } from '../src/why-nothing-runs.ts'

const facts = (over: Partial<WhyFacts> = {}): WhyFacts => ({
  now: new Date(2026, 10, 16, 20, 0),
  beacon: { up: true },
  draining: false,
  locks: [],
  base: null,
  offered: [1],
  runnable: [],
  skipped: [],
  rows: [],
  repository: null,
  canListBlockers: true,
  ...over,
})

/** Reads that count themselves, so a test can say which were never asked. */
function reads(over: Partial<{ beacon: { up: boolean } }> = {}) {
  const asked: string[] = []
  const r: WhyReads<never> = {
    beacon: Effect.sync(() => (asked.push('beacon'), over.beacon ?? { up: true })),
    conductorHeld: Effect.sync(() => (asked.push('conductor'), false)),
    blockers: Effect.sync(() => (asked.push('blockers'), null)),
  }
  return { asked, r }
}

describe('explainQueueEffect (#1216)', () => {
  it('reads nothing when no unheld work is queued', async () => {
    const { asked, r } = reads()
    expect(await Effect.runPromise(explainQueueEffect(facts({ offered: [] }), r))).toBeNull()
    expect(asked).toEqual([])
  })

  it('reads no blockers when an installation-wide root answers', async () => {
    const { asked, r } = reads({ beacon: { up: false } })
    const why = await Effect.runPromise(explainQueueEffect(facts(), r))
    expect(why?.roots[0]?.root).toBe('no-daemon')
    expect(asked).toEqual(['beacon', 'conductor'])
  })

  it('reads the blockers last, and only once nothing wider answered', async () => {
    const { asked, r } = reads()
    await Effect.runPromise(explainQueueEffect(facts(), r))
    expect(asked).toEqual(['beacon', 'conductor', 'blockers'])
  })
})
