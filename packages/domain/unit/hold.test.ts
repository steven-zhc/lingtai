/**
 * 0118 §1's model: a hold is exactly one of nine tagged shapes, and the ones
 * 0118 rules out cannot be written at all — the `@ts-expect-error` cases below
 * are checked by `pnpm typecheck`, not by vitest.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import {
  Asked,
  Ceiling,
  CheckRed,
  DidNotFinish,
  Hold,
  Human,
  MergeRefused,
  Question,
  Routed,
  SetupRefused,
  type Hold as HoldType,
  type Question as QuestionType,
} from '../src/hold.ts'
import {
  Advised,
  Cause,
  Decision,
  Failed,
  Hunk,
  Merge,
  MERGE_HUNKS_ONE_BY_ONE,
  Move,
  TriageQuestion,
  TriageResult,
  type MechanicalHunk as MechanicalHunkType,
} from '../src/triage.ts'

const run = { runId: 'run-1' }

describe('Question has no run', () => {
  it('refuses a run on the literal', () => {
    // @ts-expect-error a Question carries no run: it is asked before any run claims the item
    const withRun: QuestionType = { _tag: 'Question', question: 'which design?', by: 'steven', run }
    void withRun
  })

  it('refuses a run on the literal even typed as the wider Hold', () => {
    // @ts-expect-error same literal, now checked against the whole union
    const withRun: HoldType = { _tag: 'Question', question: 'which design?', by: 'steven', run }
    void withRun
  })
})

describe('a mechanical merge hunk carries no question', () => {
  it('refuses a question on the literal', () => {
    const question = { id: 'q1', text: 'keep ours or theirs?', answers: [{ id: 'a', text: 'ours' }], recommended: 'a' }
    // @ts-expect-error a mechanical hunk is the side git merged without trouble — there is nothing to ask
    const withQuestion: MechanicalHunkType = { _tag: 'Mechanical', path: 'a.ts', line: 1, question }
    void withQuestion
  })
})

describe('Hold round-trips every variant', () => {
  it('Question', () => {
    const value = { _tag: 'Question', question: 'which design?', by: 'steven' }
    expect(Hold.parse(value)).toEqual(value)
    expect(Question.parse(value)).toEqual(value)
  })

  it('Judgement.Asked', () => {
    const value = { _tag: 'Asked', run, step: 'implement', question: 'rename to X or Y?' }
    expect(Hold.parse(value)).toEqual(value)
    expect(Asked.parse(value)).toEqual(value)
  })

  it('Judgement.Human', () => {
    const value = { _tag: 'Human', run, step: 'proposed', source: 'declared', question: 'ship it?' }
    expect(Hold.parse(value)).toEqual(value)
    expect(Human.parse(value)).toEqual(value)
  })

  it('Judgement.Routed', () => {
    const value = {
      _tag: 'Routed',
      run,
      when: 'findings',
      why: 'the cold review found something',
      raw: null,
      findings: [],
      paths: null,
      baseSha: null,
      headSha: null,
    }
    expect(Hold.parse(value)).toEqual(value)
    expect(Routed.parse(value)).toEqual(value)
  })

  it('Failure.CheckRed', () => {
    const value = { _tag: 'CheckRed', run, step: 'build', why: 'pnpm test failed', raw: 'FAIL ...' }
    expect(Hold.parse(value)).toEqual(value)
    expect(CheckRed.parse(value)).toEqual(value)
  })

  it('Failure.MergeRefused', () => {
    const value = {
      _tag: 'MergeRefused',
      run,
      reason: 'conflict',
      why: 'apps/web/foo.ts conflicts',
      paths: ['apps/web/foo.ts'],
      baseSha: 'abc',
      headSha: 'def',
      raw: 'CONFLICT ...',
      afterApproval: false,
    }
    expect(Hold.parse(value)).toEqual(value)
    expect(MergeRefused.parse(value)).toEqual(value)
  })

  it('Failure.MergeRefused refuses a payload with no afterApproval (#441 changed the shape in place)', () => {
    const value = {
      _tag: 'MergeRefused',
      run,
      reason: 'conflict',
      why: 'apps/web/foo.ts conflicts',
      paths: ['apps/web/foo.ts'],
      baseSha: 'abc',
      headSha: 'def',
      raw: 'CONFLICT ...',
    }
    expect(() => MergeRefused.parse(value)).toThrow()
  })

  it('Failure.Ceiling', () => {
    const value = { _tag: 'Ceiling', run, kind: 'out-of-turns', detail: 'ran out of turns', turns: 150, costUsd: null }
    expect(Hold.parse(value)).toEqual(value)
    expect(Ceiling.parse(value)).toEqual(value)
  })

  it('Failure.Ceiling refuses a kind that is not a ceiling', () => {
    const value = { _tag: 'Ceiling', run, kind: 'crash', detail: 'nope', turns: null, costUsd: null }
    expect(() => Ceiling.parse(value)).toThrow()
  })

  it('Failure.DidNotFinish', () => {
    const value = { _tag: 'DidNotFinish', run, step: 'implement', why: 'the agent crashed', raw: null }
    expect(Hold.parse(value)).toEqual(value)
    expect(DidNotFinish.parse(value)).toEqual(value)
  })

  it('Failure.SetupRefused', () => {
    const value = { _tag: 'SetupRefused', run, step: 'prepared', lifts: 'by-itself', why: 'usage limit', raw: null }
    expect(Hold.parse(value)).toEqual(value)
    expect(SetupRefused.parse(value)).toEqual(value)
  })
})

describe('TriageQuestion', () => {
  const base = {
    id: 'q1',
    text: 'keep ours or theirs?',
    answers: [
      { id: 'ours', text: 'ours' },
      { id: 'theirs', text: 'theirs' },
    ],
  }

  it('accepts a recommended answer that is one of the answers', () => {
    expect(() => TriageQuestion.parse({ ...base, recommended: 'ours' })).not.toThrow()
  })

  it('refuses a recommended answer that names nothing in answers', () => {
    expect(() => TriageQuestion.parse({ ...base, recommended: 'neither' })).toThrow()
  })
})

describe('Merge hunks and the 20-hunk rule', () => {
  const mechanical = { _tag: 'Mechanical' as const, path: 'a.ts', line: 1 }
  const question = { id: 'q1', text: 'keep ours or theirs?', answers: [{ id: 'a', text: 'ours' }], recommended: 'a' }
  const divergent = { _tag: 'Divergent' as const, path: 'b.ts', line: 2, question }

  it('round-trips a mechanical and a divergent hunk', () => {
    expect(Hunk.parse(mechanical)).toEqual(mechanical)
    expect(Hunk.parse(divergent)).toEqual(divergent)
  })

  it('accepts a total at or below the limit with every hunk listed', () => {
    const hunks = [mechanical, divergent, mechanical]
    expect(() => Merge.parse({ _tag: 'Merge', hunks, total: 3 })).not.toThrow()
  })

  it('accepts a total past the limit with no hunks listed', () => {
    expect(() => Merge.parse({ _tag: 'Merge', hunks: [], total: MERGE_HUNKS_ONE_BY_ONE + 1 })).not.toThrow()
  })

  it('refuses a total past the limit that still lists hunks', () => {
    const hunks = [mechanical, divergent, mechanical]
    expect(() => Merge.parse({ _tag: 'Merge', hunks, total: MERGE_HUNKS_ONE_BY_ONE + 1 })).toThrow()
  })

  it('refuses a total at or below the limit that does not list every hunk', () => {
    expect(() => Merge.parse({ _tag: 'Merge', hunks: [mechanical], total: 3 })).toThrow()
  })
})

describe('Cause, Move and TriageResult round-trip', () => {
  it('Decision', () => {
    const questions = [{ id: 'q1', text: 't', answers: [{ id: 'a', text: 'a' }], recommended: 'a' }]
    const value = { _tag: 'Decision', questions }
    expect(Cause.parse(value)).toEqual(value)
    expect(Decision.parse(value)).toEqual(value)
  })

  it('every Move tag round-trips', () => {
    for (const tag of ['Approve', 'Requeue', 'Close', 'BodyAndRequeue', 'Answer']) {
      expect(Move.parse({ _tag: tag })).toEqual({ _tag: tag })
    }
  })

  it('TriageResult.Failed', () => {
    const value = { _tag: 'Failed', failure: 'could not parse an answer' }
    expect(TriageResult.parse(value)).toEqual(value)
    expect(Failed.parse(value)).toEqual(value)
  })

  it('TriageResult.Advised', () => {
    const value = {
      _tag: 'Advised',
      cause: { _tag: 'Approach' },
      move: { _tag: 'Requeue' },
      sentence: 'the approach will not converge',
      want: null,
    }
    expect(TriageResult.parse(value)).toEqual(value)
    expect(Advised.parse(value)).toEqual(value)
  })
})

describe('what @lingtai/domain imports', () => {
  function specifiersIn(text: string): string[] {
    const found = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName)
    if (/\b(?:import|require)\s*\(\s*(?!["'])/.test(text)) found.push('<a computed import>')
    return found
  }

  async function specifiersUnder(dir: string): Promise<string[]> {
    const specifiers: string[] = []
    for (const file of await readdir(dir, { recursive: true })) {
      if (!/\.[cm]?[jt]s$/.test(file)) continue
      specifiers.push(...specifiersIn(await readFile(join(dir, file), 'utf8')))
    }
    return specifiers
  }

  it('reaches into neither @lingtai/recipe nor @lingtai/conductor, from src or unit', async () => {
    const root = join(import.meta.dirname, '..')
    const specifiers = [...(await specifiersUnder(join(root, 'src'))), ...(await specifiersUnder(join(root, 'unit')))]

    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((s) => s.startsWith('@lingtai/recipe') || s.startsWith('@lingtai/conductor'))).toEqual([])
  })

  it('declares a dependency on zod and nothing else', async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(['zod'])
  })
})
