import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// Both `paused` callbacks live inline in the daemon's closure, where no port can
// be handed in, so the claims are held on the source (#637, #1004).
const source = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8')

describe('the daemon and the daily ceiling', () => {
  it('has the one composed hook in both paused callbacks, which reads the control stream alone', () => {
    expect(source.match(/\bpaused: claiming,/g)).toHaveLength(2)
    expect(source.match(/\bpausedSentence\(/g)).toHaveLength(2) // the call and the definition
  })

  it('asks the ceiling through its one guard, built with a ceiling port', () => {
    expect(source).toMatch(/makeGuard\(\{ store: eventStore, ceiling: ceilingPort\(undefined, \{\}\) \}\)/)
    expect(source.match(/\bmakeGuard\(/g)).toHaveLength(1)
  })
})
