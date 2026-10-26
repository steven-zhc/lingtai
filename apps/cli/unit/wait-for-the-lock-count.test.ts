/** #640: the repeated line of a drain says how many passes remain. */
import { describe, expect, it } from 'vitest'

import { waitForTheLock } from '../src/restart.ts'

describe('waitForTheLock names every pass still in flight', () => {
  it('says 2 passes, and then one', async () => {
    const lines: string[] = []
    let asks = 0
    let reads = 0
    const waited = await waitForTheLock('draining', null, (l) => lines.push(l), {
      ask: async () => (++asks < 5 ? 'daemon' : null),
      held: async () => (++reads === 1 ? ['lingtai#1', 'lingtai#2'] : ['lingtai#2']),
      pollMs: 1,
      sayEveryMs: 0,
    })
    expect(waited).toBe('free')
    expect(lines[0]).toContain('finishing 2 passes: lingtai#1, lingtai#2')
    expect(lines[1]).toContain('finishing lingtai#2')
    expect(lines[1]).not.toContain('passes')
  })
})
