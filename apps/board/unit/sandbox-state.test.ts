/** The table of #1163: one test per row, the orderings that cost earlier attempts rounds, and `worstOf`. */
import { SANDBOX_REQUIRED_REFUSAL, declaredSandbox } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { SENTENCES, UNKNOWN_WHILE_REFUSED, sandboxState, worstOf, type SandboxFacts } from '../src/lib/sandbox-state.ts'

const on = declaredSandbox('sandbox:\n  enabled: true\n')
const off = declaredSandbox('sandbox:\n  enabled: false\n')
const none = declaredSandbox('repo: x\n')
const facts = (f: Partial<SandboxFacts>): SandboxFacts => ({ refused: null, declared: on, observed: null, ...f })
const name = (f: Partial<SandboxFacts>) => sandboxState(facts(f)).state
const REFUSAL = `recipe is invalid:\n  ${SANDBOX_REQUIRED_REFUSAL} (no bwrap) — install what is missing`

describe('sandboxState', () => {
  it('stopped: the sandbox’s own refusal, whatever else', () => {
    expect(name({ refused: REFUSAL })).toBe('stopped')
    expect(name({ refused: REFUSAL, declared: off, observed: 'sandboxed' })).toBe('stopped')
    expect(name({ refused: REFUSAL, declared: 'none' })).toBe('stopped')
  })
  it('off by choice: absent block or enabled: false, under any other refusal and any observation', () => {
    expect(name({ declared: none })).toBe('off')
    expect(name({ declared: off, observed: 'degraded' })).toBe('off')
    expect(name({ declared: none, refused: '(root): expected a mapping' })).toBe('off')
  })
  it('degraded, with the fixed sentence and no host reason', () => {
    const s = sandboxState(facts({ observed: 'degraded' }))
    expect(s.state).toBe('degraded')
    expect(s.sentence).toBe('degraded: the last run went without a sandbox because none was available')
  })
  it('sandboxed: observed sandboxed', () => {
    expect(name({ observed: 'sandboxed' })).toBe('sandboxed')
  })
  it('sandboxed: nothing refuses and nothing observed, or a run from before the block was enabled', () => {
    expect(name({})).toBe('sandboxed')
    expect(name({ observed: 'off by choice' })).toBe('sandboxed')
  })
  it('not yet known: another refusal stands and nothing observed', () => {
    expect(name({ refused: 'something else' })).toBe('unknown')
    expect(name({ refused: 'something else', observed: 'off by choice' })).toBe('unknown')
  })
  it('does not say no recipe is recorded when a recipe is, whatever else refuses', () => {
    const s = sandboxState(facts({ refused: 'auth: runtime refused', observed: 'off by choice' }))
    expect(s.sentence).toBe(UNKNOWN_WHILE_REFUSED)
    expect(s.sentence).not.toContain('no recipe')
  })
  it('not yet known: no recipe recorded, never sandboxed', () => {
    expect(name({ declared: 'none' })).toBe('unknown')
    expect(sandboxState(facts({ declared: 'none' })).sentence).toBe(SENTENCES.unknown)
    expect(SENTENCES.unknown).toBe('not yet known: no recipe has been recorded for this project')
  })
  it('unreadable: a source that does not parse, never off', () => {
    expect(name({ declared: { kind: 'unreadable', why: 'x' } })).toBe('unreadable')
  })
  it('a degraded run then turned off reads off; then re-enabled reads degraded', () => {
    expect(name({ declared: off, observed: 'degraded' })).toBe('off')
    expect(name({ declared: on, observed: 'degraded' })).toBe('degraded')
  })
})

describe('worstOf', () => {
  const st = (n: Partial<SandboxFacts>) => sandboxState(facts(n))
  it('is undefined for no projects', () => {
    expect(worstOf(new Map())).toBeUndefined()
  })
  it('one project in the worst state names it alone', () => {
    const m = worstOf(
      new Map([
        ['a', st({})],
        ['b', st({ observed: 'degraded' })],
      ]),
    )!
    expect(m.state).toBe('degraded')
    expect(m.projects.map((p) => p.project)).toEqual(['b'])
  })
  it('several in the worst state list each, ordered by name', () => {
    const m = worstOf(
      new Map([
        ['z', st({ refused: REFUSAL })],
        ['a', st({ refused: REFUSAL })],
        ['m', st({})],
      ]),
    )!
    expect(m.state).toBe('stopped')
    expect(m.projects.map((p) => p.project)).toEqual(['a', 'z'])
    expect(m.sentence).toBe('sandbox stopped: 2 projects')
  })
  it('counts an unreadable project beside the worst', () => {
    const m = worstOf(
      new Map([
        ['a', st({})],
        ['b', st({ declared: { kind: 'unreadable', why: 'x' } })],
      ]),
    )!
    expect(m.state).toBe('sandboxed')
    expect(m.unreadable).toEqual(['b'])
    expect(m.sentence).toContain('1 could not be read')
  })
})
