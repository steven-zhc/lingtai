/**
 * #1256: triage answers a cause and never an action. `actionFor` is 0108 §6's table, row by row; a
 * `TriageAnswered` recommends what its cause calls for; and a `TriageAdvised` already on the log still parses and
 * reads as the advice it was.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { actionFor, type CauseBound, type CauseCounter } from '../src/failure/respond.ts'
import {
  allowedResolutions,
  recommendedResolution,
  TriageResult as TriageResultSchema,
  triageAdviceOf,
  triageCauseOf,
  WaitReason as WaitReasonSchema,
  type Cause,
  type Resolution,
  type TriageResult,
} from '../src/wait.ts'

const SPENT: Record<CauseBound, CauseCounter> = {
  refusalFixes: { used: 3, allowed: 3 },
  newAttempts: { used: 2, allowed: 2 },
  ticketSplits: { used: 1, allowed: 1 },
  stepRedos: { used: 3, allowed: 3 },
  conflictResolutions: { used: 5, allowed: 5 },
  personAsks: { used: 5, allowed: 5 },
}
const FRESH: Record<CauseBound, CauseCounter> = Object.fromEntries(
  Object.entries(SPENT).map(([k, v]) => [k, { used: 0, allowed: v.allowed }]),
) as Record<CauseBound, CauseCounter>

const question = {
  id: 'q',
  text: 'which?',
  answers: [{ id: 'a', text: 'a' }],
  recommended: 'a',
}
const plan = {
  children: [
    { key: 'a', title: 'a', body: 'a', kind: 'bug', covers: ['x'] },
    { key: 'b', title: 'b', body: 'b', kind: 'bug', covers: [] },
  ],
  blockedBy: [],
  uncovered: ['y'],
}
const hunk = {
  mechanical: { _tag: 'Mechanical', path: 'a.ts', line: 1 },
  contradicting: { _tag: 'Contradicting', path: 'a.ts', line: 2, why: 'both delete it differently' },
  divergent: { _tag: 'Divergent', path: 'a.ts', line: 3, question },
} as const
const conflict = (...hunks: Cause extends infer C ? (C extends { hunks: infer H } ? H : never) : never): Cause => ({
  _tag: 'ConflictingHunks',
  hunks,
  total: hunks.length,
})
const limit = (bound: CauseBound) => ({ _tag: 'askPerson', why: { _tag: 'limit', bound, used: SPENT[bound].used } })

describe('actionFor — 0108 §6, a row at a time', () => {
  const fixable: Cause = { _tag: 'FixableLines', fixes: [] }
  const wrong: Cause = { _tag: 'WrongApproach', why: 'w' }
  const big = (withPlan: boolean): Cause => ({
    _tag: 'TicketTooBig',
    plan: withPlan ? plan : null,
    spentOn: withPlan ? null : 'the parser',
  })
  const unfinished: Cause = { _tag: 'Unfinished', addToBody: null }

  it('FixableLines → fixRefusal while refusalFixes are left, else askPerson(limit)', () => {
    expect(actionFor(fixable, 'other', FRESH)).toEqual({ _tag: 'fixRefusal' })
    expect(actionFor(fixable, 'other', SPENT)).toEqual(limit('refusalFixes'))
  })

  it('WrongApproach → startNewAttempt while newAttempts are left, else askPerson(limit)', () => {
    expect(actionFor(wrong, 'other', FRESH)).toEqual({ _tag: 'startNewAttempt' })
    expect(actionFor(wrong, 'other', SPENT)).toEqual(limit('newAttempts'))
  })

  it('TicketTooBig with a plan → splitTicket while ticketSplits are left, else askPerson(limit)', () => {
    for (const origin of ['run-limit', 'diff-too-large', 'other'] as const)
      expect(actionFor(big(true), origin, FRESH)).toEqual({ _tag: 'splitTicket' })
    expect(actionFor(big(true), 'run-limit', SPENT)).toEqual(limit('ticketSplits'))
  })

  it('TicketTooBig without a plan from a run limit → write where the turns went, then redo, while stepRedos are left', () => {
    expect(actionFor(big(false), 'run-limit', FRESH)).toEqual({
      _tag: 'writeSpentOnThenRedoStep',
      spentOn: 'the parser',
    })
    expect(actionFor(big(false), 'run-limit', SPENT)).toEqual(limit('stepRedos'))
  })

  it('TicketTooBig without a plan from a too-large diff → askPerson: redoing does not make a diff smaller', () => {
    expect(actionFor(big(false), 'diff-too-large', FRESH)).toEqual({ _tag: 'askPerson', why: { _tag: 'unclear' } })
  })

  it('TicketTooBig with neither plan nor spentOn is read as without a plan', () => {
    const empty: Cause = { _tag: 'TicketTooBig', plan: null, spentOn: null }
    expect(actionFor(empty, 'run-limit', FRESH)).toEqual({ _tag: 'writeSpentOnThenRedoStep', spentOn: null })
  })

  it('Unfinished → redoStep while stepRedos are left, else askPerson(limit)', () => {
    expect(actionFor(unfinished, 'run-limit', FRESH)).toEqual({ _tag: 'redoStep' })
    expect(actionFor(unfinished, 'run-limit', SPENT)).toEqual(limit('stepRedos'))
  })

  it('ConflictingHunks is read in order: a divergent hunk, then a contradicting one, then the rest', () => {
    const { mechanical, contradicting, divergent } = hunk
    expect(actionFor(conflict(mechanical, contradicting, divergent), 'other', FRESH)).toEqual({
      _tag: 'askPerson',
      why: { _tag: 'unclear' },
    })
    expect(actionFor(conflict(mechanical, contradicting), 'other', FRESH)).toEqual({ _tag: 'startNewAttempt' })
    expect(actionFor(conflict(mechanical), 'other', FRESH)).toEqual({ _tag: 'resolveConflict' })
    // past MERGE_HUNKS_ONE_BY_ONE the hunks are not listed, which is the rest
    expect(actionFor({ _tag: 'ConflictingHunks', hunks: [], total: 40 }, 'other', FRESH)).toEqual({
      _tag: 'resolveConflict',
    })
  })

  it('each ConflictingHunks branch falls to askPerson(limit) on its own action’s bound', () => {
    const { mechanical, contradicting, divergent } = hunk
    expect(actionFor(conflict(divergent), 'other', SPENT)).toEqual(limit('personAsks'))
    expect(actionFor(conflict(contradicting), 'other', SPENT)).toEqual(limit('newAttempts'))
    expect(actionFor(conflict(mechanical), 'other', SPENT)).toEqual(limit('conflictResolutions'))
  })

  it('SetupBroken → askPerson(environment), whatever is left', () => {
    const broken: Cause = { _tag: 'SetupBroken', what: 'w', repair: 'r' }
    expect(actionFor(broken, 'other', FRESH)).toEqual({ _tag: 'askPerson', why: { _tag: 'environment' } })
    expect(actionFor(broken, 'other', SPENT)).toEqual({ _tag: 'askPerson', why: { _tag: 'environment' } })
  })

  it('UndecidedQuestion → askPerson(unclear) while personAsks are left, else askPerson(limit)', () => {
    const undecided: Cause = { _tag: 'UndecidedQuestion', questions: [question] }
    expect(actionFor(undecided, 'other', FRESH)).toEqual({ _tag: 'askPerson', why: { _tag: 'unclear' } })
    expect(actionFor(undecided, 'other', SPENT)).toEqual(limit('personAsks'))
  })

  it('never answers Approve or Close', () => {
    const everything: Cause[] = [fixable, wrong, big(true), big(false), unfinished, conflict(hunk.mechanical)]
    for (const cause of everything)
      for (const origin of ['run-limit', 'diff-too-large', 'other'] as const)
        for (const bounds of [FRESH, SPENT])
          expect(['Approve', 'Close']).not.toContain(actionFor(cause, origin, bounds)._tag)
  })
})

describe('recommendedResolution for a TriageAnswered', () => {
  const run = { runId: 'pass-1' }
  const check = WaitReasonSchema.parse({
    _tag: 'CheckRefused',
    run,
    step: 'proposed',
    action: 'watch:ci',
    evidence: 'red',
    findings: [],
  })
  const answered = (cause: Cause): TriageResult => ({ _tag: 'TriageAnswered', cause, summary: 's', want: null })
  const recommend = (cause: Cause, reason = check) =>
    recommendedResolution(reason, { _tag: 'Done', result: answered(cause) })

  it.each([
    [{ _tag: 'FixableLines', fixes: [] }, 'FixRefusal'],
    [{ _tag: 'WrongApproach', why: 'w' }, 'StartNewAttempt'],
    [{ _tag: 'Unfinished', addToBody: null }, 'RedoStep'],
    [{ _tag: 'UndecidedQuestion', questions: [question] }, 'AnswerQuestions'],
    [{ _tag: 'ConflictingHunks', hunks: [], total: 40 }, 'FixRefusal'],
    [{ _tag: 'SetupBroken', what: 'w', repair: 'r' }, 'RedoStep'],
    [{ _tag: 'TicketTooBig', plan, spentOn: null }, 'EditBodyAndStartNewAttempt'],
    [{ _tag: 'TicketTooBig', plan: null, spentOn: null }, 'RedoStep'],
  ] as [Cause, string][])('%j → %s where the wait offers it, else null', (cause, expected) => {
    const wanted = recommend(cause)
    expect(wanted === null || wanted === expected).toBe(true)
    // `allowedResolutions` is what decides, so the answer is the cause's move exactly when the wait offers it
    expect(wanted === null).toBe(!allowedResolutions(check, answered(cause)).includes(expected as Resolution['_tag']))
  })

  it('draws the cause’s move on a wait that offers it', () => {
    expect(recommend({ _tag: 'FixableLines', fixes: [] })).toBe('FixRefusal')
    expect(recommend({ _tag: 'WrongApproach', why: 'w' })).toBe('StartNewAttempt')
  })

  it('does not draw a move the wait does not offer, and does not fall back to the default', () => {
    const own = WaitReasonSchema.parse({ _tag: 'OwnQuestion', question: 'q', by: 'steven' })
    expect(recommend({ _tag: 'FixableLines', fixes: [] }, own)).toBeNull()
  })

  it('carries no contradiction special cases: a WrongApproach is StartNewAttempt whatever it is on', () => {
    expect(recommend({ _tag: 'WrongApproach', why: 'w' })).toBe('StartNewAttempt')
  })
})

describe('a TriageAdvised already on the log', () => {
  const advised = {
    _tag: 'TriageAdvised',
    cause: {
      _tag: 'TicketTooBig',
      split: {
        children: [
          { key: 'a', title: 'a', body: 'a', kind: 'bug' },
          { key: 'b', title: 'b', body: 'b', kind: 'bug' },
        ],
        blockedBy: [],
      },
    },
    resolution: 'Split',
    summary: 'too big',
    want: null,
  }

  it('still parses, unchanged, with no covers on its children and a bare WrongApproach', () => {
    const parsed = TriageResultSchema.parse(advised)
    expect(parsed).toEqual(advised)
    expect(
      TriageResultSchema.safeParse({
        _tag: 'TriageAdvised',
        cause: { _tag: 'WrongApproach' },
        resolution: 'Requeue',
        summary: 's',
        want: null,
      }).success,
    ).toBe(true)
    expect(
      TriageResultSchema.safeParse({
        _tag: 'TriageAdvised',
        cause: { _tag: 'SetupBroken' },
        resolution: 'Close',
        summary: 's',
        want: null,
      }).success,
    ).toBe(true)
  })

  it('is read as the advice it was, never as a cause’s recommendation', () => {
    const parsed = TriageResultSchema.parse(advised)
    expect(triageAdviceOf(parsed)).toBe('Split')
    expect(triageCauseOf(parsed)?._tag).toBe('TicketTooBig')
    expect(
      triageAdviceOf({
        _tag: 'TriageAnswered',
        cause: { _tag: 'Unfinished', addToBody: null },
        summary: 's',
        want: null,
      }),
    ).toBeNull()
  })

  it('a TriageAnswered refuses a resolution key, and a TicketTooBig with neither plan nor spentOn parses', () => {
    expect(
      TriageResultSchema.safeParse({
        _tag: 'TriageAnswered',
        cause: { _tag: 'Unfinished', addToBody: null },
        resolution: 'Requeue',
        summary: 's',
        want: null,
      }).success,
    ).toBe(false)
    expect(
      TriageResultSchema.safeParse({
        _tag: 'TriageAnswered',
        cause: { _tag: 'TicketTooBig', plan: null, spentOn: null },
        summary: 's',
        want: null,
      }).success,
    ).toBe(true)
  })
})

describe('nothing writes a TriageAdvised', () => {
  /** Every `.ts`/`.tsx` under `packages/*` and `apps/*`'s `src`, the way the other source-reading tests walk it. */
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const at = join(dir, entry.name)
      if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(at)
      return /\.tsx?$/.test(entry.name) ? [at] : []
    })
  }

  it('no src file outside wait.ts builds one', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const srcs = ['packages', 'apps'].flatMap((group) =>
      readdirSync(join(root, group)).flatMap((name) => {
        const src = join(root, group, name, 'src')
        return existsSync(src) ? sources(src) : []
      }),
    )
    expect(srcs.length).toBeGreaterThan(50)
    const builds = srcs.filter(
      (file) =>
        !file.endsWith(join('packages', 'domain', 'src', 'wait.ts')) &&
        /_tag: ['"]TriageAdvised['"]/.test(readFileSync(file, 'utf8')),
    )
    expect(builds).toEqual([])
  })
})
