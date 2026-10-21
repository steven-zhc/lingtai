/**
 * `RunSpent` and `SpentFor` — 0110 §1 and §9's shapes, read back as tests —
 * and `TriageBy`, which 0118 §3 points at `RunSpent` for a triage agent's
 * cost rather than carrying one itself.
 */
import { describe, expect, it } from 'vitest'

import { RunSpent, SpentFor, TriageBy } from '../src/events.ts'

const usage = [{ model: 'claude-opus-5', tokens: { fresh: 100, output: 20 } }]

describe('SpentFor', () => {
  it('parses Action, with round non-negative — implement is round 0', () => {
    expect(SpentFor.parse({ _tag: 'Action', step: 'implement', name: 'implement', round: 0 })).toEqual({
      _tag: 'Action',
      step: 'implement',
      name: 'implement',
      round: 0,
    })
  })

  it('parses Judge', () => {
    expect(SpentFor.parse({ _tag: 'Judge', when: 'findings' })).toEqual({ _tag: 'Judge', when: 'findings' })
  })

  it('parses Triage', () => {
    expect(SpentFor.parse({ _tag: 'Triage', waitId: 'wait-1' })).toEqual({ _tag: 'Triage', waitId: 'wait-1' })
  })

  it('parses Discussion, carrying only its tag', () => {
    expect(SpentFor.parse({ _tag: 'Discussion' })).toEqual({ _tag: 'Discussion' })
  })

  it('refuses a Triage with no waitId', () => {
    expect(() => SpentFor.parse({ _tag: 'Triage' })).toThrow()
  })

  it('refuses an Action with no round', () => {
    expect(() => SpentFor.parse({ _tag: 'Action', step: 'implement', name: 'implement' })).toThrow()
  })
})

describe('RunSpent', () => {
  const base = { runtime: 'claude-code', turns: 4, durationMs: 90_000 }

  it('parses each of the four for variants', () => {
    const fors = [
      { _tag: 'Action', step: 'implement', name: 'implement', round: 0 },
      { _tag: 'Judge', when: 'findings' },
      { _tag: 'Triage', waitId: 'wait-1' },
      { _tag: 'Discussion' },
    ]
    for (const spentFor of fors) {
      expect(() => RunSpent.parse({ ...base, for: spentFor, usage, costUsd: 0.42 })).not.toThrow()
    }
  })

  it('parses costUsd: null and usage: [] — the runtime said nothing', () => {
    const parsed = RunSpent.parse({
      ...base,
      for: { _tag: 'Discussion' },
      usage: [],
      costUsd: null,
    })
    expect(parsed.costUsd).toBeNull()
    expect(parsed.usage).toEqual([])
  })

  it('refuses a payload with no for', () => {
    expect(() => RunSpent.parse({ ...base, usage, costUsd: 0.42 })).toThrow()
  })

  it('refuses a payload with no costUsd', () => {
    expect(() => RunSpent.parse({ ...base, for: { _tag: 'Discussion' }, usage })).toThrow()
  })

  it('refuses a payload with no usage', () => {
    expect(() => RunSpent.parse({ ...base, for: { _tag: 'Discussion' }, costUsd: null })).toThrow()
  })
})

describe('TriageBy', () => {
  it('parses an Agent with just runtime and model — its cost is a RunSpent, never its own field (0118 §3)', () => {
    expect(TriageBy.parse({ _tag: 'Agent', runtime: 'claude-code', model: 'claude-opus-5' })).toEqual({
      _tag: 'Agent',
      runtime: 'claude-code',
      model: 'claude-opus-5',
    })
  })

  it('refuses an Agent carrying costUsd', () => {
    expect(() =>
      TriageBy.parse({ _tag: 'Agent', runtime: 'claude-code', model: 'claude-opus-5', costUsd: null }),
    ).toThrow()
  })

  it('refuses an Agent carrying usage', () => {
    expect(() => TriageBy.parse({ _tag: 'Agent', runtime: 'claude-code', model: 'claude-opus-5', usage })).toThrow()
  })
})
