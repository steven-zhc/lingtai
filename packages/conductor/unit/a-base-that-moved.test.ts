/**
 * **A base that moved on the branch's own files is merged in by the system, and the
 * change is built and reviewed again** (#593).
 *
 * The lane half — which files count — is `baseMovedOn`'s, tested in
 * `packages/repo/unit/base-moved.test.ts`; the git half is integration and runs
 * after the merge (0060 §1). This file is the pass half: what `runPass` does with
 * a `base-moved` refusal, over fakes, so nothing here leaves the system.
 *
 * Three things are claimed and each has a counter-example in the row beside it: the
 * route runs `build` and `review` again on the merge commit and **spends no
 * round**; the third arrival ends at a person and the port is called exactly twice;
 * and a conflict is a conflict, never a `base-moved`.
 */
import type { Action, ActionContext, ActionResult } from '@lingtai/actions'
import { STEPS } from '@lingtai/domain'
import { StepMap } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { runPass, type PassEvent, type PassOptions, type StepBodies, type StepEnding } from '../src/pass.ts'
import { outcomeOf } from '../src/step-outcome.ts'

const context: ActionContext = { runId: 'pass-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }
const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }

/** Every step's body simply passes: what is under test is the route, not the steps. */
const bodies = Object.fromEntries(
  STEPS.map((step) => [step, async (): Promise<StepEnding> => ({ ending: 'passed' })]),
) as unknown as StepBodies

const recipe = { steps: StepMap.parse({ merge: [{ name: 'land the branch', merge: { strategy: 'merge-commit' } }] }) }

const moved = (toSha: string): ActionResult => ({
  verdict: 'failed',
  evidence: 'main moved on files the branch also changed',
  findings: [],
  because: 'base-moved',
  baseMoved: { paths: ['src/recipe.ts'], fromSha: 'fork0001', toSha },
})

/**
 * A pass whose lane answers `answers` in order and then lands. `merges` is what
 * the port was asked, and `landedOn` the `onSha` each `merge` visit was judged at.
 */
async function walk(answers: readonly ActionResult[], mergeBase: PassOptions['mergeBase']) {
  const events: PassEvent[] = []
  const reviewSaw: ActionContext[] = []
  const landedOn: string[] = []
  const rounds: (number | undefined)[] = []
  let calls = 0
  const lane: Action = {
    name: 'land the branch',
    kind: 'merge',
    yields: 'merge',
    run: async (ctx) => {
      landedOn.push(ctx.onSha)
      rounds.push(ctx.round)
      return answers[calls++] ?? { ...PASSED, merged: 'merge-sha' }
    },
  }
  const actionsAt: PassOptions['actionsAt'] = (step, actions) => {
    if (step === 'merge') return [lane]
    if (step === 'admit')
      return [{ name: 'cut', kind: 'worktree', yields: 'worktree', run: async (c) => ({ ...PASSED, head: c.onSha }) }]
    if (step === 'implement')
      return [{ name: 'write', kind: 'agent', yields: 'commit', run: async () => ({ ...PASSED, head: 'c0ffee0' }) }]
    if (step === 'review')
      return [
        {
          name: 'cold',
          kind: 'agent',
          yields: 'verdict',
          run: async (ctx) => {
            reviewSaw.push(ctx)
            return PASSED
          },
        },
      ]
    return actions.map((a) => ({ name: a.name, kind: 'run', yields: 'verdict', run: async () => PASSED }) as Action)
  }
  const result = await runPass({
    recipe,
    context,
    emit: (event) => void events.push(event),
    bodies,
    actionsAt,
    ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    mergeBase,
  })
  const started = events.flatMap((e) => (e.type === 'StepStarted' ? [e.data] : []))
  return { result, events, landedOn, rounds, started, reviewSaw }
}

describe('a base that moved on the branch’s own files', () => {
  it('is merged in by the system, builds and reviews again, and spends no round', async () => {
    const asked: string[] = []
    const { result, landedOn, started } = await walk([moved('base-1')], async (toSha) => {
      asked.push(toSha)
      return { head: 'merged-1' }
    })

    expect(asked).toEqual(['base-1'])
    const steps = started.map((s) => s.step)
    const firstMerge = steps.indexOf('merge')
    expect(steps.slice(firstMerge)).toEqual(['merge', 'build', 'review', 'proposed', 'merge'])
    // The second `merge` is judged at the merge commit, not at the head the first was.
    expect(landedOn).toEqual(['c0ffee0', 'merged-1'])
    // No round bought: every visit is at round 0, and the pass landed.
    expect(started.every((s) => s.round === 0)).toBe(true)
    expect(result.end).toMatchObject({ _tag: 'Landed' })
    expect(result.routes[0]).toMatchObject({ from: 'merge', to: 'build', ceiling: null })
  })

  it('shows the review what landed, and only the review after the merge (#594)', async () => {
    const { reviewSaw } = await walk([moved('base-1')], async () => ({ head: 'merged-1' }))

    expect(reviewSaw).toHaveLength(2)
    expect('landedOnBase' in reviewSaw[0]!).toBe(false)
    expect(reviewSaw[1]?.landedOnBase).toEqual({ paths: ['src/recipe.ts'], fromSha: 'fork0001', toSha: 'base-1' })
  })

  it('reaches a person on the third arrival, the port having been called exactly twice', async () => {
    const asked: string[] = []
    const { result } = await walk([moved('base-1'), moved('base-2'), moved('base-3')], async (toSha) => {
      asked.push(toSha)
      return { head: `merged-${asked.length}` }
    })

    expect(asked).toEqual(['base-1', 'base-2'])
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'BaseMoved', toSha: 'base-3' } },
    })
    // Nothing but a person was on offer, so no judge was asked and `chose` is
    // `waiting` (as for a spent round): the ceiling is read off the offer.
    expect(result.routes.at(-1)?.offer.unavailable).toEqual([
      { id: 'merge-base', because: { _tag: 'CeilingReached', ceiling: 'base-merges' } },
    ])
  })

  it('reaches a person when the system could not merge the base in', async () => {
    const { result } = await walk([moved('base-1')], async () => ({ failed: 'index.lock exists' }))

    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: {
        _tag: 'ProposedEscalated',
        because: { _tag: 'JudgeHandedOver', why: 'the base could not be merged in: index.lock exists' },
      },
    })
  })

  it('reaches a person when the pass was handed no way to merge', async () => {
    const { result } = await walk([moved('base-1')], undefined)
    expect(result.end).toMatchObject({ _tag: 'WaitOnPerson' })
  })
})

describe('what the lane’s result becomes', () => {
  const merge = (result: ActionResult) =>
    outcomeOf('merge', 0, 'abc', [{ name: 'land', kind: 'merge', yields: 'merge', run: async () => result }], {
      results: [{ ...result, name: 'land' }],
      stopped: true,
    } as never).actions[0]

  it('maps a conflict to Conflicted and a moved base to BaseMoved, never one for the other', () => {
    const conflict = merge({
      verdict: 'failed',
      evidence: 'x',
      findings: [],
      because: 'conflict',
      conflict: { paths: ['a.ts'], baseSha: 'b', headSha: 'h' },
    })
    expect(conflict).toMatchObject({ result: { integration: { _tag: 'Conflicted', paths: ['a.ts'] } } })

    const base = merge(moved('base-1'))
    expect(base).toMatchObject({
      result: { integration: { _tag: 'BaseMoved', paths: ['src/recipe.ts'], fromSha: 'fork0001', toSha: 'base-1' } },
    })
  })
})
