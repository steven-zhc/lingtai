import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Both `paused` callbacks live inline in the daemon's closure, where no port can
// be handed in, so the claim that each asks the daily ceiling is held on the
// source: the ceiling's own unit tests cannot catch a ceiling that is never asked (#637).
const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8')

describe('the daemon asks the daily ceiling', () => {
  it('in both paused callbacks, before the control stream is read', () => {
    const callbacks = source.split(/\bpaused: async \(\) => \{/).slice(1)
    expect(callbacks).toHaveLength(2)
    for (const body of callbacks) {
      const asked = body.indexOf('dayCeilingStop(')
      const read = body.indexOf('readControl(')
      expect(asked).toBeGreaterThan(-1)
      expect(asked).toBeLessThan(read)
    }
  })
})
