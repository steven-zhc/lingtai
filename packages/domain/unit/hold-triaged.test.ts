/**
 * 0118 §3's shape for `TriageStarted` and `HoldTriaged` (#409), through
 * `parsePayload` — the store's own entry point, so these cases are about what
 * the log would actually accept or refuse.
 *
 * Several cases here would have parsed before this ticket: zod strips
 * unknown keys by default, so a `Failed` carrying `cause`, an `Advised`
 * carrying `questions` beside it, or a `Mechanical` carrying `costUsd` all
 * parsed silently. Each "refuses" case below is one of those, proving the
 * strictness is actually in place rather than merely intended.
 */
import { describe, expect, it } from 'vitest'

import {
  MERGE_HUNKS_ONE_BY_ONE,
  parsePayload,
  TRIAGE_ANSWERS_MAX,
  TRIAGE_FIXES_MAX,
  TRIAGE_QUESTIONS_MAX,
  TRIAGE_SENTENCE_MAX,
  TRIAGE_TEXT_MAX,
} from '../src/index.ts'

const baseAgent = { _tag: 'Agent' as const, runtime: 'claude-code', model: 'opus-5', costUsd: 0.42 }

const baseAdvised = {
  attempt: 1,
  blocked: 3,
  headSha: 'a'.repeat(40),
  result: {
    _tag: 'Advised' as const,
    cause: { _tag: 'Approach' as const },
    move: { _tag: 'Requeue' as const },
    sentence: 'the approach will not converge',
    want: null,
  },
  by: baseAgent,
}

const question = {
  id: 'q1',
  text: 'keep ours or theirs?',
  answers: [{ id: 'a', text: 'ours' }],
  recommended: 'a',
}

describe('HoldTriaged', () => {
  it('accepts an advised instance', () => {
    expect(() => parsePayload('HoldTriaged', baseAdvised)).not.toThrow()
  })

  it('accepts a failed instance', () => {
    const value = { ...baseAdvised, result: { _tag: 'Failed', failure: 'could not parse an answer' } }
    expect(() => parsePayload('HoldTriaged', value)).not.toThrow()
  })

  it('refuses a payload with no attempt', () => {
    const { attempt: _attempt, ...rest } = baseAdvised
    expect(() => parsePayload('HoldTriaged', rest)).toThrow()
  })

  it('refuses an advised result with no cause', () => {
    const { cause: _cause, ...rest } = baseAdvised.result
    expect(() => parsePayload('HoldTriaged', { ...baseAdvised, result: rest })).toThrow()
  })

  it('refuses a failed result carrying advice', () => {
    const value = {
      ...baseAdvised,
      result: { _tag: 'Failed', failure: 'nope', cause: { _tag: 'Approach' } },
    }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses questions outside the cause', () => {
    const value = { ...baseAdvised, result: { ...baseAdvised.result, questions: [] } }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses fixes outside the cause', () => {
    const value = { ...baseAdvised, result: { ...baseAdvised.result, fixes: [] } }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('accepts a Merge hunk carrying its own question', () => {
    const value = {
      ...baseAdvised,
      result: {
        ...baseAdvised.result,
        cause: { _tag: 'Merge', hunks: [{ _tag: 'Divergent', path: 'a.ts', line: 1, question }], total: 1 },
      },
    }
    expect(() => parsePayload('HoldTriaged', value)).not.toThrow()
  })

  it('refuses a question on a mechanical hunk', () => {
    const value = {
      ...baseAdvised,
      result: {
        ...baseAdvised.result,
        cause: {
          _tag: 'Merge',
          hunks: [{ _tag: 'Mechanical', path: 'a.ts', line: 1, question }],
          total: 1,
        },
      },
    }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('accepts by: Mechanical{}', () => {
    expect(() => parsePayload('HoldTriaged', { ...baseAdvised, by: { _tag: 'Mechanical' } })).not.toThrow()
  })

  it.each([{ runtime: 'x' }, { model: 'x' }, { costUsd: 1 }, { usage: [] }])(
    'refuses a Mechanical by carrying %j',
    (extra) => {
      const value = { ...baseAdvised, by: { _tag: 'Mechanical', ...extra } }
      expect(() => parsePayload('HoldTriaged', value)).toThrow()
    },
  )

  it('accepts want: null', () => {
    expect(() => parsePayload('HoldTriaged', baseAdvised)).not.toThrow()
  })

  it('refuses a want over 200 characters', () => {
    const value = { ...baseAdvised, result: { ...baseAdvised.result, want: 'x'.repeat(TRIAGE_SENTENCE_MAX + 1) } }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses a sentence over 200 characters', () => {
    const value = {
      ...baseAdvised,
      result: { ...baseAdvised.result, sentence: 'x'.repeat(TRIAGE_SENTENCE_MAX + 1) },
    }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses free text over 500 characters', () => {
    const value = { ...baseAdvised, result: { _tag: 'Failed', failure: 'x'.repeat(TRIAGE_TEXT_MAX + 1) } }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses a Decision past 5 questions', () => {
    const questions = Array.from({ length: TRIAGE_QUESTIONS_MAX + 1 }, (_, i) => ({ ...question, id: `q${i}` }))
    const value = { ...baseAdvised, result: { ...baseAdvised.result, cause: { _tag: 'Decision', questions } } }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses a question past 4 answers', () => {
    const answers = Array.from({ length: TRIAGE_ANSWERS_MAX + 1 }, (_, i) => ({ id: `a${i}`, text: `a${i}` }))
    const value = {
      ...baseAdvised,
      result: {
        ...baseAdvised.result,
        cause: { _tag: 'Decision', questions: [{ ...question, answers, recommended: 'a0' }] },
      },
    }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses a Lines cause past 20 fixes', () => {
    const fixes = Array.from({ length: TRIAGE_FIXES_MAX + 1 }, (_, i) => ({ path: `a${i}.ts`, line: 1, what: 'x' }))
    const value = { ...baseAdvised, result: { ...baseAdvised.result, cause: { _tag: 'Lines', fixes } } }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('refuses a Merge listing more than 20 hunks', () => {
    const hunks = Array.from({ length: MERGE_HUNKS_ONE_BY_ONE + 1 }, (_, i) => ({
      _tag: 'Mechanical' as const,
      path: `a${i}.ts`,
      line: 1,
    }))
    const value = {
      ...baseAdvised,
      result: { ...baseAdvised.result, cause: { _tag: 'Merge', hunks, total: hunks.length } },
    }
    expect(() => parsePayload('HoldTriaged', value)).toThrow()
  })

  it('accepts costUsd: null on an advised instance', () => {
    const value = { ...baseAdvised, by: { ...baseAgent, costUsd: null } }
    expect(() => parsePayload('HoldTriaged', value)).not.toThrow()
  })

  it('accepts costUsd: null on a failed instance', () => {
    const value = {
      ...baseAdvised,
      result: { _tag: 'Failed', failure: 'could not parse an answer' },
      by: { ...baseAgent, costUsd: null },
    }
    expect(() => parsePayload('HoldTriaged', value)).not.toThrow()
  })

  it('refuses an Agent with costUsd absent', () => {
    const { costUsd: _costUsd, ...rest } = baseAgent
    expect(() => parsePayload('HoldTriaged', { ...baseAdvised, by: rest })).toThrow()
  })
})

describe('TriageStarted', () => {
  it('parses with blocked, attempt and by', () => {
    const value = { blocked: 3, attempt: 1, by: { _tag: 'Agent', runtime: 'claude-code', model: 'opus-5' } }
    expect(() => parsePayload('TriageStarted', value)).not.toThrow()
  })

  it('refuses a payload with no attempt', () => {
    const value = { blocked: 3, by: { _tag: 'Mechanical' } }
    expect(() => parsePayload('TriageStarted', value)).toThrow()
  })

  it('accepts by: Mechanical{}', () => {
    expect(() => parsePayload('TriageStarted', { blocked: 3, attempt: 1, by: { _tag: 'Mechanical' } })).not.toThrow()
  })

  it.each([{ runtime: 'x' }, { model: 'x' }, { costUsd: 1 }, { usage: [] }])(
    'refuses a Mechanical by carrying %j',
    (extra) => {
      const value = { blocked: 3, attempt: 1, by: { _tag: 'Mechanical', ...extra } }
      expect(() => parsePayload('TriageStarted', value)).toThrow()
    },
  )

  it('refuses an Agent carrying costUsd — nothing has been spent yet', () => {
    const value = { blocked: 3, attempt: 1, by: { _tag: 'Agent', runtime: 'x', model: 'y', costUsd: null } }
    expect(() => parsePayload('TriageStarted', value)).toThrow()
  })
})
