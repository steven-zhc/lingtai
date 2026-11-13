/** #640: the repeated line of a drain says how many passes remain. */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { waitForTheLock } from '../src/restart.ts'

describe('waitForTheLock names every pass still in flight', () => {
  it('says 2 attempts, and then one', async () => {
    const lines: string[] = []
    let asks = 0
    let reads = 0
    const waited = await Effect.runPromise(
      waitForTheLock('draining', null, (l) => lines.push(l), {
        ask: Effect.sync(() => (++asks < 5 ? 'daemon' : null)),
        held: Effect.sync(() => (++reads === 1 ? ['lingtai#1', 'lingtai#2'] : ['lingtai#2'])),
        pollMs: 1,
        sayEveryMs: 0,
      }),
    )
    expect(waited).toBe('free')
    expect(lines[0]).toContain('finishing 2 attempts: lingtai#1, lingtai#2')
    expect(lines[1]).toContain('finishing lingtai#2')
    expect(lines[1]).not.toContain('passes')
  })

  it('says a failed ask once, keeps waiting, and is free on the later answer', async () => {
    const lines: string[] = []
    let asks = 0
    const waited = await Effect.runPromise(
      waitForTheLock('draining', null, (l) => lines.push(l), {
        ask: Effect.suspend(() => (++asks === 1 ? Effect.fail(new Error('EACCES')) : Effect.succeed(null))),
        pollMs: 1,
      }),
    )
    expect(waited).toBe('free')
    expect(asks).toBe(2)
    expect(lines.join('\n')).toContain('could not ask who holds the lock — EACCES. Still draining; it is asked again.')
  })
})
