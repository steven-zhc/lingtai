import type { Action, ActionContext, ActionResult } from '@lingtai/actions'
import { STEPS } from '@lingtai/domain'
import { StepMap } from '@lingtai/recipe'
/**
 * **A base that moved on the branch's own files is merged in by the system, and the
 * change is built and reviewed again** (#593).
 *
 * The lane half — which files count — is `baseMovedOn`'s, tested in
 * `packages/repo/unit/base-moved.test.ts`; the git half is integration and runs
 * after the merge (0060 §1). This file is the pass half: what `runAttempt` does with
 * a `base-moved` refusal, over fakes, so nothing here leaves the system.
 *
 * Three things are claimed and each has a counter-example in the row beside it: the
 * route runs `build` and `review` again on the merge commit and **spends no
 * round**; the third arrival ends at a person and the port is called exactly twice;
 * and a conflict is a conflict, never a `base-moved`.
 */
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  runAttemptEffect,
  attemptPortsFrom,
  type AttemptEvent,
  type AttemptOptions,
  type StepBodies,
  type StepEnding,
} from '../src/run-attempt.ts'
import { outcomeOf } from '../src/step-outcome.ts'

const context: ActionContext = { runId: 'pass-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }
const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }

/** Every step's body simply passes: what is under test is the route, not the steps. */
const bodies = Object.fromEntries(
  STEPS.map((step) => [step, (): Effect.Effect<StepEnding> => Effect.succeed<StepEnding>({ ending: 'passed' })]),
) as unknown as StepBodies

const recipe = {
  steps: StepMap.parse({
    review: [{ name: 'cold', agent: 'claude-code', prompt: 'read the diff' }],
    merge: [{ name: 'land the branch', merge: { strategy: 'merge-commit' } }],
  }),
}

const moved = (toSha: string, paths: string[] = ['src/recipe.ts']): ActionResult => ({
  verdict: 'failed',
  evidence: 'main moved on files the branch also changed',
  findings: [],
  because: 'base-moved',
  baseMoved: { paths, fromSha: 'fork0001', toSha },
})

/**
 * A pass whose lane answers `answers` in order and then lands. `merges` is what
 * the port was asked, and `landedOn` the `onSha` each `merge` visit was judged at.
 */
async function walk(
  answers: readonly ActionResult[],
  mergeBase: AttemptOptions['mergeBase'],
  buildAnswers: readonly ActionResult[] = [],
  from?: AttemptOptions['from'],
  reviewAnswers: readonly ActionResult[] = [],
) {
  const events: AttemptEvent[] = []
  const reviewSaw: ActionContext[] = []
  const landedOn: string[] = []
  const rounds: (number | undefined)[] = []
  let calls = 0
  let builds = 0
  let reviews = 0
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
  const actionsAt: AttemptOptions['actionsAt'] = (step, actions) => {
    if (step === 'merge') return [lane]
    if (step === 'admit')
      return [{ name: 'cut', kind: 'worktree', yields: 'worktree', run: async (c) => ({ ...PASSED, head: c.onSha }) }]
    if (step === 'implement')
      return [{ name: 'write', kind: 'agent', yields: 'commit', run: async () => ({ ...PASSED, head: 'c0ffee0' }) }]
    if (step === 'build')
      return [{ name: 'gate', kind: 'run', yields: 'verdict', run: async () => buildAnswers[builds++] ?? PASSED }]
    if (step === 'review')
      return [
        {
          name: 'cold',
          kind: 'agent',
          yields: 'verdict',
          run: async (ctx) => {
            reviewSaw.push(ctx)
            return reviewAnswers[reviews++] ?? PASSED
          },
        },
      ]
    return actions.map((a) => ({ name: a.name, kind: 'run', yields: 'verdict', run: async () => PASSED }) as Action)
  }
  const result = await Effect.runPromise(
    runAttemptEffect(
      attemptPortsFrom({
        recipe,
        context,
        emit: (event) => void events.push(event),
        bodies,
        actionsAt,
        ceilings: { refusalFixes: 2, conflictResolutions: 2, newAttempts: 0, newAttemptsSpent: 0 },
        mergeBase,
        ...(from === undefined ? {} : { from }),
      }),
    ),
  )
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
    expect('mergedOnto' in reviewSaw[0]!).toBe(false)
    expect(reviewSaw[1]?.landedOnBase).toEqual({ paths: ['src/recipe.ts'], fromSha: 'fork0001', toSha: 'base-1' })
    // Kept for every later review, which the section is not (a fix round drops it).
    expect(reviewSaw[1]?.mergedOnto).toBe('base-1')
  })

  it('keeps the section for the review when the rerun’s build fails first (#594)', async () => {
    const red: ActionResult = { verdict: 'failed', evidence: 'red', findings: [], because: 'red' }
    const { reviewSaw } = await walk([moved('base-1')], async () => ({ head: 'merged-1' }), [PASSED, red])

    expect(reviewSaw).toHaveLength(2)
    expect('landedOnBase' in reviewSaw[0]!).toBe(false)
    expect(reviewSaw[1]?.landedOnBase).toMatchObject({ fromSha: 'fork0001', toSha: 'base-1' })
  })

  it('owes a continuation’s first review the section too, the merge having been an earlier pass’s (#594)', async () => {
    const landedOnBase = { paths: ['src/recipe.ts'], fromSha: 'fork0001', toSha: 'base-1' }
    const { reviewSaw } = await walk([], async () => ({ head: 'merged-1' }), [], {
      step: 'build',
      waive: [],
      landedOnBase,
    })

    expect(reviewSaw[0]?.landedOnBase).toEqual(landedOnBase)
    expect(reviewSaw[0]?.mergedOnto).toBe('base-1')
  })

  it('reaches a person on the eleventh arrival, the port having been called exactly ten times', async () => {
    const asked: string[] = []
    const arrivals = Array.from({ length: 11 }, (_, i) => moved(`base-${i + 1}`))
    const { result } = await walk(arrivals, async (toSha) => {
      asked.push(toSha)
      return { head: `merged-${asked.length}` }
    })

    expect(asked).toEqual(arrivals.slice(0, 10).map((_, i) => `base-${i + 1}`))
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { _tag: 'ProposedEscalated', proposal: { _tag: 'BaseMoved', toSha: 'base-11' } },
    })
    // Nothing but a person was on offer, so no judge was asked and `chose` is
    // `waiting` (as for a spent round): the ceiling is read off the offer.
    expect(result.routes.at(-1)?.offer.unavailable).toEqual([
      { id: 'merge-base', because: { _tag: 'CeilingReached', ceiling: 'baseBranchMerges' } },
    ])
  })

  it('a continuation of an attempt that spent ten base merges is not offered another (#1200)', async () => {
    const { result } = await walk([moved('base-1')], async () => ({ head: 'merged-1' }), [], {
      step: 'build',
      waive: [],
      baseMergesSpent: 10,
    })

    expect(result.routes.at(-1)?.offer.unavailable).toEqual([
      { id: 'merge-base', because: { _tag: 'CeilingReached', ceiling: 'baseBranchMerges' } },
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
    outcomeOf('merge', 0, 'abc', [{ name: 'land', kind: 'merge', yields: 'merge' }], {
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

  it('keeps base-protected as itself rather than the generic unexpected (#662)', () => {
    const refused = merge({ verdict: 'failed', evidence: 'x', findings: [], because: 'base-protected' })
    expect(refused).toMatchObject({
      result: { integration: { _tag: 'IntegrationRefused', reason: 'base-protected' } },
    })
  })
})

describe('what the next review is told it already read (#671)', () => {
  it('has no earlier head on a first review, nor after a base merge nobody approved', async () => {
    const { reviewSaw } = await walk([moved('base-1')], async () => ({ head: 'merged-1' }))

    expect(reviewSaw).toHaveLength(2)
    expect('reviewedSha' in reviewSaw[0]!).toBe(false)
    expect('reviewedSha' in reviewSaw[1]!).toBe(false)
    // The first review read a head; the second is scoped to what the merge left, with the overlap open (#1274).
    expect('mergedSinceReview' in reviewSaw[0]!).toBe(false)
    expect(reviewSaw[1]?.mergedSinceReview).toEqual({
      reviewed: reviewSaw[0]?.onSha,
      base: 'base-1',
      overlap: ['src/recipe.ts'],
    })
  })

  it('carries a person’s approval across a clean merge: build runs, review does not (#1279)', async () => {
    for (const paths of [['src/recipe.ts'], []]) {
      const { reviewSaw, started } = await walk([moved('base-1', paths)], async () => ({ head: 'merged-1' }), [], {
        step: 'proposed',
        waive: [],
        approvedHead: 'abc1234def',
        approvedNow: true,
      })
      expect(reviewSaw).toHaveLength(0)
      const steps = started.map((s) => s.step)
      expect(steps.slice(steps.indexOf('merge'))).toEqual(['merge', 'build', 'proposed', 'merge'])
    }
  })

  it('carries it across two base moves in a row (#1279)', async () => {
    const { reviewSaw } = await walk([moved('base-1'), moved('base-2')], async () => ({ head: 'merged-1' }), [], {
      step: 'proposed',
      waive: [],
      approvedHead: 'abc1234def',
      approvedNow: true,
    })
    expect(reviewSaw).toHaveLength(0)
  })

  it('keeps the carry when the attempt is resumed at build after the merge (#1279)', async () => {
    const { reviewSaw, started } = await walk([], async () => ({ head: 'merged-1' }), [], {
      step: 'build',
      waive: [],
      approvedHead: 'old0000',
    })
    expect(reviewSaw).toHaveLength(0)
    expect(started.map((s) => s.step)).not.toContain('review')
  })

  it('does not carry for a retry that is not an approval (#1279)', async () => {
    const { reviewSaw } = await walk([moved('base-1')], async () => ({ head: 'merged-1' }), [], {
      step: 'proposed',
      waive: [],
    })
    expect(reviewSaw.length).toBeGreaterThan(0)
  })

  it('reads a fix round after a red build from the approved head, with no overlap open (#1279)', async () => {
    const red: ActionResult = { verdict: 'failed', evidence: 'red', findings: [], because: 'red' }
    const { reviewSaw } = await walk([moved('base-1')], async () => ({ head: 'merged-1' }), [red], {
      step: 'proposed',
      waive: [],
      approvedHead: 'abc1234def',
      approvedNow: true,
    })
    expect(reviewSaw).toHaveLength(1)
    expect(reviewSaw[0]?.mergedSinceReview).toEqual({ reviewed: 'abc1234def', base: 'base-1', overlap: [] })
    expect(reviewSaw[0]?.reviewedSha).toBeUndefined()
  })

  it('does not name it for a continuation that is a fix round (a grant)', async () => {
    const { reviewSaw } = await walk([moved('base-1')], async () => ({ head: 'merged-1' }), [], {
      step: 'implement',
      waive: [],
      grant: { rounds: 1 } as never,
    })

    expect(reviewSaw.every((c) => !('reviewedSha' in c))).toBe(true)
  })
})

describe('a base that moved on none of the branch’s files (#1210)', () => {
  const merge = async () => ({ head: 'merged-1' })

  it('is built on the merge commit and carries the review: one merge-base route, no second review', async () => {
    const { result, started, reviewSaw, events } = await walk([moved('base-1', [])], merge)

    const steps = started.map((s) => s.step)
    expect(steps.slice(steps.indexOf('merge'))).toEqual(['merge', 'build', 'proposed', 'merge'])
    expect(steps.filter((s) => s === 'review')).toHaveLength(1)
    expect(reviewSaw).toHaveLength(1)
    // The skip is an absence: nothing started or ended for it after the merge.
    expect(events.filter((e) => e.type === 'StepStarted' && e.data.step === 'review')).toHaveLength(1)
    expect(result.routes.filter((r) => r.to === 'build')).toHaveLength(1)
    expect(result.end).toMatchObject({ _tag: 'Landed' })
  })

  it('reviews again when the earlier review read the diff clipped', async () => {
    const clipped = { ...PASSED, clipped: { shown: 1, total: 2 } } as unknown as ActionResult
    const { reviewSaw } = await walk([moved('base-1', [])], merge, [], undefined, [clipped])
    expect(reviewSaw).toHaveLength(2)
  })

  it('reviews the next head in full after a red build and a fix round', async () => {
    const red: ActionResult = { verdict: 'failed', evidence: 'red', findings: [], because: 'red' }
    const { reviewSaw, started } = await walk([moved('base-1', [])], merge, [PASSED, red])
    expect(started.filter((s) => s.step === 'review')).toHaveLength(2)
    expect(reviewSaw).toHaveLength(2)
    expect(reviewSaw[1]?.reviewedSha).toBeUndefined()
  })
})
