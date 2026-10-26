/** The lane on its own (#639): ordering, one wait announced, release on every outcome. */
import { describe, expect, it } from 'vitest'

import { createLandingLane } from '../src/landing-lane.ts'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('the landing lane', () => {
  it('starts the second landing only after the first has settled, and says so once', async () => {
    const lane = createLandingLane()
    const log: string[] = []
    const latch = deferred()
    const waits: string[] = []
    const first = lane.through(
      'p:main',
      { runId: 'a', issue: 1 },
      { onWait: async () => void waits.push('first'), onEnter: async () => void waits.push('first-in') },
      async () => {
        log.push('a:start')
        await latch.promise
        log.push('a:end')
        return 'A'
      },
    )
    const second = lane.through(
      'p:main',
      { runId: 'b', issue: 2 },
      {
        onWait: async (behind) => void waits.push(`behind ${behind.runId}`),
        onEnter: async () => void waits.push('b-in'),
      },
      async () => {
        log.push('b:start')
        return 'B'
      },
    )
    await tick()
    expect(log).toEqual(['a:start'])
    latch.resolve()
    expect(await Promise.all([first, second])).toEqual(['A', 'B'])
    expect(log).toEqual(['a:start', 'a:end', 'b:start'])
    expect(waits).toEqual(['behind a', 'b-in'])
  })

  it('does not make a different key wait', async () => {
    const lane = createLandingLane()
    const latch = deferred()
    const held = lane.through(
      'x',
      { runId: 'a', issue: 1 },
      { onWait: async () => {}, onEnter: async () => {} },
      () => latch.promise,
    )
    let waited = false
    await lane.through(
      'y',
      { runId: 'b', issue: 2 },
      {
        onWait: async () => void (waited = true),
        onEnter: async () => {},
      },
      async () => 'ok',
    )
    expect(waited).toBe(false)
    latch.resolve()
    await held
  })

  it('releases when the holder rejects, and the rejection stays its own', async () => {
    const lane = createLandingLane()
    const latch = deferred()
    const first = lane.through(
      'k',
      { runId: 'a', issue: 1 },
      { onWait: async () => {}, onEnter: async () => {} },
      async () => {
        await latch.promise
        throw new Error('git died')
      },
    )
    const second = lane.through(
      'k',
      { runId: 'b', issue: 2 },
      { onWait: async () => {}, onEnter: async () => {} },
      async () => 'B',
    )
    latch.resolve()
    await expect(first).rejects.toThrow('git died')
    expect(await second).toBe('B')
    // Drained: the next caller finds the lane free.
    let waited = false
    await lane.through(
      'k',
      { runId: 'c', issue: 3 },
      { onWait: async () => void (waited = true), onEnter: async () => {} },
      async () => 'C',
    )
    expect(waited).toBe(false)
  })

  it('does not strand the queue when the wait announcement is refused', async () => {
    const lane = createLandingLane()
    const latch = deferred()
    const first = lane.through(
      'k',
      { runId: 'a', issue: 1 },
      { onWait: async () => {}, onEnter: async () => {} },
      () => latch.promise,
    )
    const second = lane.through(
      'k',
      { runId: 'b', issue: 2 },
      {
        onWait: async () => {
          throw new Error('store refused')
        },
        onEnter: async () => {},
      },
      async () => 'B',
    )
    const third = lane.through(
      'k',
      { runId: 'c', issue: 3 },
      { onWait: async () => {}, onEnter: async () => {} },
      async () => 'C',
    )
    latch.resolve()
    await first
    await expect(second).rejects.toThrow('store refused')
    expect(await third).toBe('C')
  })
})
