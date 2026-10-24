/**
 * `ContinueConflict` (#557, 0118 §1 and §8): who is offered it, what a stored
 * command must say, and the pure check that refuses a stale or incomplete one.
 */
import { describe, expect, it } from 'vitest'

import { MERGE_HUNKS_ONE_BY_ONE } from '../src/triage.ts'
import {
  allowedResolutions,
  continueConflictRefusal,
  Resolution as ResolutionSchema,
  TriageResult as TriageResultSchema,
  type Resolution,
  type WaitReason,
} from '../src/wait.ts'
import { WaitReason as WaitReasonSchema } from '../src/wait.ts'

const run = { runId: 'pass-1' }
const unpushedRun = { runId: 'pass-1', unpushed: { branch: 'agent/run-1', said: 'nothing to push' } }

const conflict = (extra: Record<string, unknown> = {}, runRef: object = run): WaitReason =>
  WaitReasonSchema.parse({
    _tag: 'ProposedEscalated',
    run: runRef,
    proposal: {
      _tag: 'MergeConflict',
      output: 'conflict',
      paths: ['a.ts'],
      baseSha: 'base',
      headSha: 'head',
      ...extra,
    },
    because: { _tag: 'NotAsked' },
  })

type Continue = Extract<Resolution, { _tag: 'ContinueConflict' }>
const hunk = (line: number) => ({ path: 'a.ts', line })
const command = (lines: number[], extra: Partial<Continue> = {}): Continue =>
  ResolutionSchema.parse({
    _tag: 'ContinueConflict',
    baseSha: 'base',
    headSha: 'head',
    ref: 'agent/557',
    grantExtraRound: false,
    hunks: lines.map((line) => ({
      _tag: 'Divergent',
      ...hunk(line),
      behavior: 'keep the new base behavior',
      adopted: null,
    })),
    ...extra,
  }) as Continue

describe('allowedResolutions offers ContinueConflict', () => {
  it('for a ProposedEscalated MergeConflict with both shas', () => {
    expect(allowedResolutions(conflict())).toContain('ContinueConflict')
  })

  it.each([
    ['a null base', { baseSha: null }],
    ['a null head', { headSha: null }],
  ])('not with %s', (_, extra) => {
    expect(allowedResolutions(conflict(extra))).not.toContain('ContinueConflict')
  })

  it('not when the run is unpushed', () => {
    expect(allowedResolutions(conflict({}, unpushedRun))).not.toContain('ContinueConflict')
  })

  it('not for a direct MergeRefused, even carrying both shas', () => {
    const reason = WaitReasonSchema.parse({
      _tag: 'MergeRefused',
      run,
      reason: 'dirty-base',
      raw: 'x',
      baseSha: 'base',
      headSha: 'head',
    })
    expect(allowedResolutions(reason)).not.toContain('ContinueConflict')
  })

  it('not for ProposedEscalated{MergeRefused}', () => {
    const reason = WaitReasonSchema.parse({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'MergeRefused', reason: 'dirty-base', output: 'x' },
      because: { _tag: 'NotAsked' },
    })
    expect(allowedResolutions(reason)).not.toContain('ContinueConflict')
  })

  it('not for any other proposal', () => {
    const reason = WaitReasonSchema.parse({
      _tag: 'ProposedEscalated',
      run,
      proposal: { _tag: 'BuildRed', output: 'tsc failed' },
      because: { _tag: 'NotAsked' },
    })
    expect(allowedResolutions(reason)).not.toContain('ContinueConflict')
  })
})

describe('the ContinueConflict command', () => {
  it('accepts a command written entirely by the person', () => {
    expect(() => command([1, 2])).not.toThrow()
  })

  it('refuses a Divergent hunk with a blank behavior', () => {
    expect(() => command([1], { hunks: [{ _tag: 'Divergent', ...hunk(1), behavior: '   ', adopted: null }] })).toThrow()
  })

  it('refuses an empty hunk list', () => {
    expect(() => command([])).toThrow()
  })

  it('refuses more hunks than MERGE_HUNKS_ONE_BY_ONE', () => {
    expect(() => command(Array.from({ length: MERGE_HUNKS_ONE_BY_ONE + 1 }, (_, i) => i))).toThrow()
  })
})

describe('continueConflictRefusal', () => {
  const counted = [hunk(1), hunk(2)]

  it('accepts a command matching the wait and the count', () => {
    expect(continueConflictRefusal(conflict(), command([2, 1]), counted)).toBeNull()
  })

  it('NotOffered where allowedResolutions does not offer it', () => {
    expect(continueConflictRefusal(conflict({ headSha: null }), command([1, 2]), counted)).toBe('NotOffered')
  })

  it('Stale when either sha differs', () => {
    expect(continueConflictRefusal(conflict(), command([1, 2], { headSha: 'moved' }), counted)).toBe('Stale')
    expect(continueConflictRefusal(conflict(), command([1, 2], { baseSha: 'moved' }), counted)).toBe('Stale')
  })

  it('TooManyHunks past the bound, whatever the command lists', () => {
    const many = Array.from({ length: MERGE_HUNKS_ONE_BY_ONE + 1 }, (_, i) => hunk(i))
    expect(continueConflictRefusal(conflict(), command([1]), many)).toBe('TooManyHunks')
  })

  it('HunksMismatch when a hunk is missing, extra or duplicated', () => {
    expect(continueConflictRefusal(conflict(), command([1]), counted)).toBe('HunksMismatch')
    expect(continueConflictRefusal(conflict(), command([1, 2, 3]), counted)).toBe('HunksMismatch')
    expect(continueConflictRefusal(conflict(), command([1, 1]), counted)).toBe('HunksMismatch')
  })

  it('accepts a Mechanical entry as well as a Divergent one', () => {
    const mixed = command([1], {
      hunks: [
        { _tag: 'Mechanical', ...hunk(1) },
        { _tag: 'Divergent', ...hunk(2), behavior: 'keep both', adopted: { questionId: 'q', answerId: 'a' } },
      ],
    })
    expect(continueConflictRefusal(conflict(), mixed, counted)).toBeNull()
  })
})

describe('triage may advise ContinueConflict only with a concrete proposal', () => {
  const advised = (cause: unknown) =>
    TriageResultSchema.safeParse({
      _tag: 'TriageAdvised',
      cause,
      resolution: 'ContinueConflict',
      summary: 's',
      want: null,
    }).success

  it('not with FixableLines', () => {
    expect(advised({ _tag: 'FixableLines', fixes: [] })).toBe(false)
  })

  it('not with ConflictingHunks past the bound (no hunks listed)', () => {
    expect(advised({ _tag: 'ConflictingHunks', hunks: [], total: MERGE_HUNKS_ONE_BY_ONE + 5 })).toBe(false)
  })

  it('with a concrete list of hunks', () => {
    expect(
      advised({ _tag: 'ConflictingHunks', hunks: [{ _tag: 'Mechanical', path: 'a.ts', line: 1 }], total: 1 }),
    ).toBe(true)
  })
})
