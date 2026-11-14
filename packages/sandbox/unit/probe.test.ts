import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { hostProgramsPresent } from '../src/probe.ts'

describe('hostProgramsPresent', () => {
  it('fails by name, with each missing program, when none is on PATH', async () => {
    const e = await Effect.runPromise(Effect.flip(hostProgramsPresent('linux', '/nonexistent')))
    expect(e.sentences).toEqual(['bwrap not installed', 'socat not installed', 'rg not installed'])
  })
  it('fails for a platform that cannot be sandboxed', async () => {
    const e = await Effect.runPromise(Effect.flip(hostProgramsPresent('win32', '/bin')))
    expect(e.reason).toContain('cannot be sandboxed')
  })
})
