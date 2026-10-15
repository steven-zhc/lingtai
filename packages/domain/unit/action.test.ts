/**
 * 0120 §1's model, read back as tests: one `it` per `yields` × result `_tag`
 * combination for `cleared`, one per cell of the *Legality* table for
 * `accepts`, and hand-built outcomes for the step-level readings.
 *
 * Fixtures go through `Action.parse`, the same method `moves.test.ts` uses,
 * so a branded id and a discriminated union both get the validation the
 * schema actually performs rather than a cast.
 */
import { describe, expect, it } from 'vitest'

import {
  Action,
  accepts,
  changedNothing,
  cleared,
  decidingAction,
  designOf,
  headOf,
  stepCleared,
  StepOutcome,
  wellFormed,
} from '../src/action.ts'
import { STEPS, Step } from '../src/vocabulary.ts'

const base = { plugin: 'run', name: 'pnpm test', onSha: 'sha-onsha', call: null, evidence: '' }

// Every `${yields}/${result._tag}` combination the `cleared` tests below
// actually exercised, populated by `parseAction` — never a literal that
// could drift from the schema.
const combosExercised = new Set<string>()

function parseAction(input: unknown): Action {
  const action = Action.parse(input)
  combosExercised.add(`${action.yields}/${action.result._tag}`)
  return action
}

function combosInSchema(): Set<string> {
  const combos = new Set<string>()
  for (const option of Action.options) {
    const yields = option.shape.yields.value as string
    for (const resultOption of option.shape.result.options) {
      combos.add(`${yields}/${resultOption.shape._tag.value}`)
    }
  }
  return combos
}

describe('cleared', () => {
  // verdict
  it('verdict/Completed accepted: cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'verdict',
      result: { _tag: 'Completed', assessment: { verdict: 'accepted', findings: [] } },
    })
    expect(cleared(action)).toBe(true)
  })

  it('verdict/Completed refused: not cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'verdict',
      result: { _tag: 'Completed', assessment: { verdict: 'refused', findings: [] } },
    })
    expect(cleared(action)).toBe(false)
  })

  it('verdict/AnswerUnreadable: not cleared', () => {
    const action = parseAction({ ...base, yields: 'verdict', result: { _tag: 'AnswerUnreadable', raw: 'garbled' } })
    expect(cleared(action)).toBe(false)
  })

  it('verdict/Interrupted: not cleared', () => {
    const action = parseAction({ ...base, yields: 'verdict', result: { _tag: 'Interrupted', cause: 'crash' } })
    expect(cleared(action)).toBe(false)
  })

  it('verdict/NeverStarted: not cleared', () => {
    const action = parseAction({ ...base, yields: 'verdict', result: { _tag: 'NeverStarted', scope: 'work-item' } })
    expect(cleared(action)).toBe(false)
  })

  it('verdict/Waived: cleared', () => {
    const action = parseAction({ ...base, yields: 'verdict', result: { _tag: 'Waived', waitId: 'wait-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('verdict/NotReached: not cleared', () => {
    const action = parseAction({ ...base, yields: 'verdict', result: { _tag: 'NotReached' } })
    expect(cleared(action)).toBe(false)
  })

  // signoff
  it('signoff/Completed, requested null: cleared', () => {
    const action = parseAction({ ...base, yields: 'signoff', result: { _tag: 'Completed', requested: null } })
    expect(cleared(action)).toBe(true)
  })

  it('signoff/Completed, requested: not cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'signoff',
      result: { _tag: 'Completed', requested: { question: 'ship it?' } },
    })
    expect(cleared(action)).toBe(false)
  })

  it('signoff/Waived: cleared', () => {
    const action = parseAction({ ...base, yields: 'signoff', result: { _tag: 'Waived', waitId: 'wait-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('signoff/NotDone: not cleared', () => {
    const action = parseAction({ ...base, yields: 'signoff', result: { _tag: 'NotDone' } })
    expect(cleared(action)).toBe(false)
  })

  it('signoff/NotReached: not cleared', () => {
    const action = parseAction({ ...base, yields: 'signoff', result: { _tag: 'NotReached' } })
    expect(cleared(action)).toBe(false)
  })

  // commit
  it('commit/Completed, head, no question: cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'commit',
      result: { _tag: 'Completed', head: 'sha-1', question: null },
    })
    expect(cleared(action)).toBe(true)
  })

  it('commit/Completed, question: not cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'commit',
      result: { _tag: 'Completed', head: null, question: 'rename to X or Y?' },
    })
    expect(cleared(action)).toBe(false)
  })

  it('commit/Interrupted: not cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'commit',
      result: { _tag: 'Interrupted', cause: 'timeout', head: 'sha-1' },
    })
    expect(cleared(action)).toBe(false)
  })

  it('commit/NotDone: not cleared', () => {
    const action = parseAction({ ...base, yields: 'commit', result: { _tag: 'NotDone' } })
    expect(cleared(action)).toBe(false)
  })

  it('commit/NeverStarted: not cleared', () => {
    const action = parseAction({ ...base, yields: 'commit', result: { _tag: 'NeverStarted', scope: 'conductor' } })
    expect(cleared(action)).toBe(false)
  })

  it('commit/Waived: cleared', () => {
    const action = parseAction({ ...base, yields: 'commit', result: { _tag: 'Waived', waitId: 'wait-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('commit/NotReached: not cleared', () => {
    const action = parseAction({ ...base, yields: 'commit', result: { _tag: 'NotReached' } })
    expect(cleared(action)).toBe(false)
  })

  // design
  it('design/Drafted: cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'design',
      result: { _tag: 'Drafted', design: { document: 'the plan' } },
    })
    expect(cleared(action)).toBe(true)
  })

  it('design/Asked: not cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'design',
      result: { _tag: 'Asked', question: 'which shape?', draft: null },
    })
    expect(cleared(action)).toBe(false)
  })

  it('design/AnswerUnreadable: not cleared', () => {
    const action = parseAction({ ...base, yields: 'design', result: { _tag: 'AnswerUnreadable', raw: 'garbled' } })
    expect(cleared(action)).toBe(false)
  })

  it('design/Interrupted: not cleared', () => {
    const action = parseAction({ ...base, yields: 'design', result: { _tag: 'Interrupted', cause: 'aborted' } })
    expect(cleared(action)).toBe(false)
  })

  it('design/NotDone: not cleared', () => {
    const action = parseAction({ ...base, yields: 'design', result: { _tag: 'NotDone' } })
    expect(cleared(action)).toBe(false)
  })

  it('design/NeverStarted: not cleared', () => {
    const action = parseAction({ ...base, yields: 'design', result: { _tag: 'NeverStarted', scope: 'work-item' } })
    expect(cleared(action)).toBe(false)
  })

  it('design/Waived: cleared', () => {
    const action = parseAction({ ...base, yields: 'design', result: { _tag: 'Waived', waitId: 'wait-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('design/NotReached: not cleared', () => {
    const action = parseAction({ ...base, yields: 'design', result: { _tag: 'NotReached' } })
    expect(cleared(action)).toBe(false)
  })

  // worktree
  it('worktree/Completed: cleared', () => {
    const action = parseAction({ ...base, yields: 'worktree', result: { _tag: 'Completed', head: 'sha-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('worktree/NotDone: not cleared', () => {
    const action = parseAction({ ...base, yields: 'worktree', result: { _tag: 'NotDone' } })
    expect(cleared(action)).toBe(false)
  })

  it('worktree/Waived: cleared', () => {
    const action = parseAction({ ...base, yields: 'worktree', result: { _tag: 'Waived', waitId: 'wait-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('worktree/NotReached: not cleared', () => {
    const action = parseAction({ ...base, yields: 'worktree', result: { _tag: 'NotReached' } })
    expect(cleared(action)).toBe(false)
  })

  // merge
  it('merge/Completed, Integrated: cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'merge',
      result: { _tag: 'Completed', integration: { _tag: 'Integrated', mergeSha: 'sha-1' } },
    })
    expect(cleared(action)).toBe(true)
  })

  it('merge/Completed, Conflicted: not cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'merge',
      result: {
        _tag: 'Completed',
        integration: { _tag: 'Conflicted', paths: ['a.ts'], baseSha: 'base-1', headSha: 'head-1' },
      },
    })
    expect(cleared(action)).toBe(false)
  })

  it('merge/Completed, IntegrationRefused: not cleared', () => {
    const action = parseAction({
      ...base,
      yields: 'merge',
      result: { _tag: 'Completed', integration: { _tag: 'IntegrationRefused', reason: 'dirty-base' } },
    })
    expect(cleared(action)).toBe(false)
  })

  it('merge/Waived: cleared', () => {
    const action = parseAction({ ...base, yields: 'merge', result: { _tag: 'Waived', waitId: 'wait-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('merge/NotReached: not cleared', () => {
    const action = parseAction({ ...base, yields: 'merge', result: { _tag: 'NotReached' } })
    expect(cleared(action)).toBe(false)
  })

  // nothing
  it('nothing/Completed: cleared', () => {
    const action = parseAction({ ...base, yields: 'nothing', result: { _tag: 'Completed' } })
    expect(cleared(action)).toBe(true)
  })

  it('nothing/NotDone: not cleared', () => {
    const action = parseAction({ ...base, yields: 'nothing', result: { _tag: 'NotDone' } })
    expect(cleared(action)).toBe(false)
  })

  it('nothing/Waived: cleared', () => {
    const action = parseAction({ ...base, yields: 'nothing', result: { _tag: 'Waived', waitId: 'wait-1' } })
    expect(cleared(action)).toBe(true)
  })

  it('nothing/NotReached: not cleared', () => {
    const action = parseAction({ ...base, yields: 'nothing', result: { _tag: 'NotReached' } })
    expect(cleared(action)).toBe(false)
  })

  it('every yields × result variant the schema defines is exercised above', () => {
    // Against the schema itself, not a literal copy of this list: a variant
    // added to `Action` without a fixture above shows up here as a combo
    // `combosInSchema()` has and `combosExercised` doesn't, so this goes red
    // rather than passing on an updated literal nobody wrote an `it` for.
    expect(combosExercised).toEqual(combosInSchema())
  })
})

const LEGALITY: Record<Step, Action['yields'][]> = {
  claim: [],
  admit: ['worktree', 'nothing'],
  prepared: ['verdict', 'nothing'],
  design: ['design', 'nothing'],
  implement: ['commit', 'nothing'],
  build: ['verdict'],
  review: ['verdict'],
  proposed: ['verdict', 'signoff'],
  merge: ['verdict', 'signoff', 'merge'],
  end: [],
}

const YIELDS: Action['yields'][] = ['verdict', 'signoff', 'commit', 'design', 'worktree', 'merge', 'nothing']

describe('accepts', () => {
  for (const step of STEPS) {
    for (const yields of YIELDS) {
      const expected = LEGALITY[step].includes(yields)
      it(`${step} × ${yields}: ${expected}`, () => {
        expect(accepts(step, yields)).toBe(expected)
      })
    }
  }
})

function verdictAction(verdict: 'accepted' | 'refused'): Action {
  return Action.parse({
    ...base,
    yields: 'verdict',
    result: { _tag: 'Completed', assessment: { verdict, findings: [] } },
  })
}

function notReached(yields: Action['yields']): Action {
  return Action.parse({ ...base, yields, result: { _tag: 'NotReached' } })
}

function commitAction(head: string | null, question: string | null = null): Action {
  return Action.parse({ ...base, yields: 'commit', result: { _tag: 'Completed', head, question } })
}

function interruptedCommit(head: string | null): Action {
  return Action.parse({ ...base, yields: 'commit', result: { _tag: 'Interrupted', cause: 'timeout', head } })
}

function worktreeAction(head: string): Action {
  return Action.parse({ ...base, yields: 'worktree', result: { _tag: 'Completed', head } })
}

function designAction(document: string, locator?: string): Action {
  return Action.parse({ ...base, yields: 'design', result: { _tag: 'Drafted', design: { document, locator } } })
}

function askedDesign(question: string): Action {
  return Action.parse({ ...base, yields: 'design', result: { _tag: 'Asked', question, draft: null } })
}

function outcome(step: Step, actions: Action[], round = 0): StepOutcome {
  return StepOutcome.parse({ step, round, actions })
}

describe('decidingAction', () => {
  it('no actions: null', () => {
    expect(decidingAction(outcome('build', []))).toBeNull()
  })

  it('the last action not NotReached', () => {
    const last = verdictAction('refused')
    const result = outcome('build', [verdictAction('accepted'), last, notReached('verdict')])
    // `toEqual`, not `toBe`: `StepOutcome.parse` reconstructs each action, so
    // the deciding action is equal to `last`, never the same reference.
    expect(decidingAction(result)).toEqual(last)
  })

  it('every action NotReached: null', () => {
    expect(decidingAction(outcome('build', [notReached('verdict'), notReached('verdict')]))).toBeNull()
  })
})

describe('stepCleared', () => {
  it('no actions: cleared', () => {
    expect(stepCleared(outcome('build', []))).toBe(true)
  })

  it('deciding action cleared: cleared', () => {
    expect(stepCleared(outcome('build', [verdictAction('accepted')]))).toBe(true)
  })

  it('deciding action did not clear: not cleared', () => {
    expect(stepCleared(outcome('build', [verdictAction('refused'), notReached('verdict')]))).toBe(false)
  })
})

describe('headOf', () => {
  it('a kept-run after an agent that commits a format: the later head', () => {
    const result = outcome('implement', [commitAction('agent-sha'), commitAction('format-sha')])
    expect(headOf(result)).toBe('format-sha')
  })

  it('a kept-run after a committing agent that commits nothing: the agent head survives', () => {
    const result = outcome('implement', [commitAction('agent-sha'), commitAction(null)])
    expect(headOf(result)).toBe('agent-sha')
  })

  it('an interrupted commit with a head', () => {
    const result = outcome('implement', [interruptedCommit('partial-sha')])
    expect(headOf(result)).toBe('partial-sha')
  })

  it('worktree at admit', () => {
    const result = outcome('admit', [worktreeAction('worktree-sha')])
    expect(headOf(result)).toBe('worktree-sha')
  })

  it('no commit or worktree action: null', () => {
    expect(headOf(outcome('build', [verdictAction('accepted')]))).toBeNull()
  })
})

describe('designOf', () => {
  it('an agent Drafted then a file: Drafted with a locator: the file: wins', () => {
    const result = outcome('design', [
      designAction('draft from the agent'),
      designAction('draft from the agent', 'doc/design/the-shape.md'),
    ])
    expect(designOf(result)).toEqual({ document: 'draft from the agent', locator: 'doc/design/the-shape.md' })
  })

  it('an Asked only: null', () => {
    expect(designOf(outcome('design', [askedDesign('which shape?')]))).toBeNull()
  })
})

describe('changedNothing', () => {
  it('an empty implement: true', () => {
    expect(changedNothing(outcome('implement', []))).toBe(true)
  })

  it('a non-implement step: false, whatever its actions', () => {
    expect(changedNothing(outcome('build', []))).toBe(false)
  })

  it('implement with a cleared commit that carries no head: true', () => {
    expect(changedNothing(outcome('implement', [commitAction(null)]))).toBe(true)
  })

  it('implement with a commit that carries a head: false', () => {
    expect(changedNothing(outcome('implement', [commitAction('sha-1')]))).toBe(false)
  })

  it('implement with an uncleared action: false', () => {
    const result = outcome('implement', [commitAction(null, 'rename to X or Y?')])
    expect(changedNothing(result)).toBe(false)
  })
})

describe('wellFormed', () => {
  it('empty: well-formed', () => {
    expect(wellFormed(outcome('build', []))).toBe(true)
  })

  it('all cleared: well-formed', () => {
    expect(wellFormed(outcome('build', [verdictAction('accepted'), verdictAction('accepted')]))).toBe(true)
  })

  it('cleared, then fails, then NotReached: well-formed', () => {
    const result = outcome('build', [verdictAction('accepted'), verdictAction('refused'), notReached('verdict')])
    expect(wellFormed(result)).toBe(true)
  })

  it('two uncleared actions, neither NotReached: not well-formed', () => {
    const result = outcome('build', [verdictAction('refused'), verdictAction('refused')])
    expect(wellFormed(result)).toBe(false)
  })

  it('NotReached after a cleared deciding action: not well-formed', () => {
    const result = outcome('build', [verdictAction('accepted'), notReached('verdict')])
    expect(wellFormed(result)).toBe(false)
  })

  it('NotReached first, a real action after it: not well-formed', () => {
    const result = outcome('build', [notReached('verdict'), verdictAction('accepted')])
    expect(wellFormed(result)).toBe(false)
  })

  it('all NotReached, not empty: not well-formed', () => {
    const result = outcome('build', [notReached('verdict'), notReached('verdict')])
    expect(wellFormed(result)).toBe(false)
  })
})
