/** The sandbox's four states and the worst of them (#1163). */
import { SANDBOX_REQUIRED_REFUSAL } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { sandboxState, worstOf, type SandboxFacts, type SandboxState } from '../src/lib/sandbox-state.ts'

const on: SandboxFacts['block'] = { enabled: true }
const facts = (over: Partial<SandboxFacts>): SandboxFacts => ({ refused: null, block: on, boundary: null, ...over })
const refusal = `recipe is invalid:\n  - ${SANDBOX_REQUIRED_REFUSAL} (srt missing) — install it`

describe('sandboxState', () => {
  it('is stopped while the sandbox refusal stands', () => {
    expect(sandboxState(facts({ refused: refusal })).state).toBe('stopped')
    expect(sandboxState(facts({ refused: refusal, boundary: { kind: 'sandboxed' } })).state).toBe('stopped')
  })

  it('is not stopped by a refusal that is not the sandbox host (a path or another problem)', () => {
    const s = sandboxState(facts({ refused: 'sandbox.write: x', boundary: { kind: 'sandboxed' } }))
    expect(s.state).toBe('sandboxed')
  })

  it('is no longer stopped once the refusal is cleared, whatever an old refused record says', () => {
    expect(sandboxState(facts({ refused: null, boundary: { kind: 'refused' } })).state).toBe('unknown')
  })

  it('is off by choice with no block or enabled: false, and that beats an older degraded record', () => {
    expect(sandboxState(facts({ block: undefined })).state).toBe('off')
    expect(
      sandboxState(facts({ block: { enabled: false }, boundary: { kind: 'unsandboxed', reason: 'degraded' } })).state,
    ).toBe('off')
  })

  it('is degraded on a degraded boundary, sandboxed on a sandboxed one', () => {
    expect(sandboxState(facts({ boundary: { kind: 'unsandboxed', reason: 'degraded' } })).state).toBe('degraded')
    expect(sandboxState(facts({ boundary: { kind: 'sandboxed' } })).state).toBe('sandboxed')
  })

  it('is unknown, never sandboxed, with no recipe or no boundary recorded yet', () => {
    expect(sandboxState(facts({ block: null })).state).toBe('unknown')
    expect(sandboxState(facts({})).state).toBe('unknown')
  })
})

describe('worstOf', () => {
  const st = (state: SandboxState['state']): SandboxState => ({ state, sentence: state })

  it('names the one project in the worst state', () => {
    const m = worstOf(
      new Map([
        ['a', st('sandboxed')],
        ['b', st('stopped')],
        ['c', st('off')],
      ]),
    )!
    expect(m.state).toBe('stopped')
    expect(m.projects.map((p) => p.project)).toEqual(['b'])
  })

  it('lists every project that ties for worst, ordered by name', () => {
    const m = worstOf(
      new Map([
        ['z', st('degraded')],
        ['a', st('degraded')],
        ['m', st('sandboxed')],
      ]),
    )!
    expect(m.state).toBe('degraded')
    expect(m.projects.map((p) => p.project)).toEqual(['a', 'z'])
  })

  it('ranks off above sandboxed, so all never claims sandboxed beside an off one', () => {
    expect(
      worstOf(
        new Map([
          ['a', st('sandboxed')],
          ['b', st('off')],
        ]),
      )!.state,
    ).toBe('off')
  })

  it('is undefined with no projects', () => {
    expect(worstOf(new Map())).toBeUndefined()
  })
})
