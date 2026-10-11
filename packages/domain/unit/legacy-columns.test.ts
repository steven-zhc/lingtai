/**
 * `legacyColumns` against one example of each of `Hold`'s nine variants —
 * the Done-when #445 is held to: *the values the fold wrote before.*
 */
import { describe, expect, it } from 'vitest'

import type { Hold } from '../src/hold.ts'
import { legacyColumns } from '../src/legacy-columns.ts'

describe('legacyColumns', () => {
  it('reads a Question bare — no run, no step to prefix with', () => {
    const hold: Hold = { _tag: 'Question', question: 'which design?', by: 'human:steven' }
    expect(legacyColumns(hold)).toEqual({
      question: 'which design?',
      runId: null,
      asked: true,
      needs: 'judgement',
      needsFrom: 'human',
      diagnosis: null,
    })
  })

  it('composes the step prefix for Asked, from the run it belongs to', () => {
    const hold: Hold = { _tag: 'Asked', run: { runId: 'run-1' }, step: 'design', question: 'which base?' }
    const cols = legacyColumns(hold)
    expect(cols.question).toBe('the `design` step asked: which base?')
    expect(cols.runId).toBe('run-1')
    expect(cols.needs).toBe('judgement')
    expect(cols.diagnosis).toEqual({
      what: 'the `design` step asked: which base?',
      done: null,
      raw: 'which base?',
      recommendation: null,
    })
  })

  it('composes the step prefix for Human, and recommends approve only at merge', () => {
    const declared: Hold = {
      _tag: 'Human',
      run: { runId: 'run-1' },
      step: 'proposed',
      source: 'declared',
      question: 'go ahead?',
    }
    expect(legacyColumns(declared).question).toBe('the `proposed` step held: go ahead?')
    expect(legacyColumns(declared).diagnosis?.recommendation).toBeNull()

    const injected: Hold = {
      _tag: 'Human',
      run: { runId: 'run-1' },
      step: 'merge',
      source: 'injected',
      question: '--no-merge',
    }
    expect(legacyColumns(injected).diagnosis?.recommendation).toEqual({
      action: 'approve',
      why: 'every step passed on this diff; approving merges what this run produced',
    })
  })

  it('vetoes the merge recommendation on a Human carrying a live finding', () => {
    const finding = { severity: 'major' as const, file: 'x.ts', line: 4, claim: 'claim', failureScenario: 'scenario' }
    const hold: Hold = {
      _tag: 'Human',
      run: { runId: 'run-1' },
      step: 'merge',
      source: 'injected',
      question: '--no-merge',
      findings: [finding],
    }
    expect(legacyColumns(hold).diagnosis?.recommendation).toBeNull()
  })

  it('keeps Routed.why as the composed line, since branch/base are not on a Hold', () => {
    const hold: Hold = {
      _tag: 'Routed',
      run: { runId: 'run-1' },
      when: 'findings',
      why: 'agent/1 into main is waiting on you. a blocker was found',
      raw: 'a blocker was found',
      findings: [{ severity: 'blocker', file: 'x.ts', line: 1, claim: 'c', failureScenario: 's' }],
      paths: null,
      baseSha: null,
      headSha: null,
    }
    const cols = legacyColumns(hold)
    expect(cols.question).toBe('agent/1 into main is waiting on you. a blocker was found')
    expect(cols.needs).toBe('judgement')
    // A live finding vetoes the good-hold recommendation.
    expect(cols.diagnosis?.recommendation).toBeNull()
  })

  it('recommends approve on a Routed carrying no findings', () => {
    const hold: Hold = {
      _tag: 'Routed',
      run: { runId: 'run-1' },
      when: 'findings',
      why: 'agent/1 into main is waiting on you.',
      raw: null,
      findings: [],
      paths: null,
      baseSha: null,
      headSha: null,
    }
    expect(legacyColumns(hold).diagnosis?.recommendation).toEqual({
      action: 'approve',
      why: 'every step passed on this diff; approving merges what this run produced',
    })
  })

  it('composes the step prefix for CheckRed, with needs acknowledgement', () => {
    const hold: Hold = {
      _tag: 'CheckRed',
      run: { runId: 'run-1' },
      step: 'build',
      why: 'pnpm test exited 2',
      raw: null,
    }
    const cols = legacyColumns(hold)
    expect(cols.question).toBe('the `build` step refused: pnpm test exited 2')
    expect(cols.needs).toBe('acknowledgement')
    expect(cols.diagnosis?.recommendation).toBeNull()
  })

  it('composes the step prefix for DidNotFinish, with its own word', () => {
    const hold: Hold = {
      _tag: 'DidNotFinish',
      run: { runId: 'run-1' },
      step: 'implement',
      why: 'the agent crashed',
      raw: 'Error: boom',
    }
    expect(legacyColumns(hold).question).toBe('the `implement` step did-not-finish: the agent crashed')
  })

  it('composes the step prefix for SetupRefused', () => {
    const hold: Hold = {
      _tag: 'SetupRefused',
      run: { runId: 'run-1' },
      step: 'prepared',
      lifts: 'person',
      why: 'the cold reviewer had no settings file',
      raw: 'ENOSPC',
    }
    const cols = legacyColumns(hold)
    expect(cols.question).toBe('the `prepared` step refused: the cold reviewer had no settings file')
    expect(cols.diagnosis?.raw).toBe('ENOSPC')
  })

  it("keeps MergeRefused's own `reason: raw` line, unprefixed by a step", () => {
    const hold: Hold = {
      _tag: 'MergeRefused',
      run: { runId: 'run-1' },
      reason: 'conflict',
      why: 'the branch does not merge into main',
      raw: 'CONFLICT (content): Merge conflict in a.ts',
      paths: ['a.ts'],
      baseSha: 'a'.repeat(40),
      headSha: 'b'.repeat(40),
    }
    const cols = legacyColumns(hold)
    expect(cols.question).toBe('conflict: CONFLICT (content): Merge conflict in a.ts')
    expect(cols.needs).toBe('acknowledgement')
    expect(cols.diagnosis?.raw).toBe('CONFLICT (content): Merge conflict in a.ts')
  })

  it("keeps Ceiling's own `kind: detail` line, and recommends requeue", () => {
    const hold: Hold = {
      _tag: 'Ceiling',
      run: { runId: 'run-1' },
      kind: 'out-of-turns',
      detail: '151 turns, and the recipe allows 151',
      turns: 151,
      costUsd: 20.81,
    }
    const cols = legacyColumns(hold)
    expect(cols.question).toBe('out-of-turns: 151 turns, and the recipe allows 151')
    expect(cols.diagnosis?.what).toContain('scope alarm')
    expect(cols.diagnosis?.recommendation).toEqual({
      action: 'requeue',
      why: 'narrow or split the ticket first; requeued as written, it buys another run to the same limit',
    })
  })

  it('appends the unpushed parenthetical to diagnosis.what, never to question', () => {
    const hold: Hold = {
      _tag: 'CheckRed',
      run: { runId: 'run-1', unpushed: { branch: 'agent/1', said: 'stale info' } },
      step: 'build',
      why: 'pnpm test exited 2',
      raw: null,
    }
    const cols = legacyColumns(hold)
    expect(cols.question).toBe('the `build` step refused: pnpm test exited 2')
    expect(cols.diagnosis?.what).toBe(
      'the `build` step refused: pnpm test exited 2 (and agent/1 was not pushed: stale info)',
    )
  })

  it('names the refusal repairOf answered, not the run id that answered it', () => {
    const hold: Hold = {
      _tag: 'CheckRed',
      run: { runId: 'run-1', repairOf: { after: 'run-1978cb64-abcd', reason: 'red' } },
      step: 'build',
      why: 'pnpm test exited 2',
      raw: null,
    }
    expect(legacyColumns(hold).diagnosis?.done).toBe('a repair for red produced this diff')
  })
})
