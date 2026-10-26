import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { pausedSentence } from '../src/day-ceiling.ts'

// Both `paused` callbacks live inline in the daemon's closure, where no port can
// be handed in, so the claim that each asks the daily ceiling is held on the
// source: both go through `pausedSentence`, which asks the ceiling first (#637).
const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8')

describe('the daemon asks the daily ceiling', () => {
  it('in both paused callbacks, through the one shared function', () => {
    expect(source.match(/\bpaused: \(\) => pausedSentence\(/g)).toHaveLength(2)
  })

  it('and surfaces the ceiling sentence rather than a bare true', async () => {
    const sentence = 'could not check the daily ceiling: the spend projection is 3 behind — taking no work'
    expect(await pausedSentence({ ceiling: async () => sentence, control: async () => ({ paused: false }) })).toBe(
      sentence,
    )
  })

  it('names the control pause ahead of the ceiling, and refuses where it cannot read', async () => {
    expect(
      await pausedSentence({
        ceiling: async () => null,
        control: async () => ({ paused: true, by: 'sam', reason: 'lunch' }),
      }),
    ).toBe('paused by sam — lunch')
    expect(
      await pausedSentence({
        ceiling: async () => null,
        control: async () => {
          throw new Error('down')
        },
      }),
    ).toMatch(/could not read whether the conductor is paused: down/)
  })
})
