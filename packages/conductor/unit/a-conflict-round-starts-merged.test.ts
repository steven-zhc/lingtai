/**
 * **A conflict round, bought or granted, starts with the lane's base merged into
 * the worktree** (#1120). The lane aborts its trial merge in a throwaway worktree,
 * so a fixer used to start in a tree with no conflict in it; the conductor now runs
 * the merge first (`mergeForConflict`) and the round, the build and the review that
 * follow are told what that merge is.
 *
 * The pass half, over fakes (0060 §1): what the walk does with the port's answer.
 * The git half is `conduct-a-conflict-round-merges-first.test.ts`.
 */
import type { Action, ActionContext, ActionResult } from '@lingtai/actions'
import { STEPS } from '@lingtai/domain'
import { StepMap } from '@lingtai/recipe'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  attemptPortsFrom,
  runAttemptEffect,
  type AttemptOptions,
  type ConflictMergeAnswer,
  type StepBodies,
  type StepEnding,
} from '../src/run-attempt.ts'

const context: ActionContext = { runId: 'pass-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }
const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }
const BASE = 'b'.repeat(40)
const FORK = 'f'.repeat(40)

const bodies = Object.fromEntries(
  STEPS.map((step) => [step, (): Effect.Effect<StepEnding> => Effect.succeed<StepEnding>({ ending: 'passed' })]),
) as unknown as StepBodies

const recipe = {
  steps: StepMap.parse({
    review: [{ name: 'cold', agent: 'claude-code', prompt: 'read the diff' }],
    merge: [{ name: 'land the branch', merge: { strategy: 'merge-commit' } }],
  }),
}

const conflicted = (baseSha: string | null): ActionResult => ({
  verdict: 'failed',
  evidence: 'CONFLICT (content): Merge conflict in src/fix.ts',
  findings: [],
  because: 'conflict',
  // The lane's result type says a string; the event's says nullable, and an old log holds a null.
  conflict: { paths: ['src/fix.ts'], baseSha: baseSha as string, headSha: 'h'.repeat(40) },
})

const STANDING: ConflictMergeAnswer = {
  conflicted: { paths: ['src/fix.ts'], fromSha: FORK, overlap: ['src/fix.ts', 'src/other.ts'] },
}

async function walk(options: {
  lane: readonly ActionResult[]
  port?: (baseSha: string) => Effect.Effect<ConflictMergeAnswer>
  from?: AttemptOptions['from']
}) {
  const order: string[] = []
  const implementSaw: ActionContext[] = []
  const reviewSaw: ActionContext[] = []
  let laneCalls = 0
  const actionsAt: AttemptOptions['actionsAt'] = (step, actions) => {
    if (step === 'merge')
      return [
        {
          name: 'land the branch',
          kind: 'merge',
          yields: 'merge',
          run: async () => options.lane[laneCalls++] ?? { ...PASSED, merged: 'merge-sha' },
        },
      ]
    if (step === 'admit')
      return [{ name: 'cut', kind: 'worktree', yields: 'worktree', run: async (c) => ({ ...PASSED, head: c.onSha }) }]
    if (step === 'implement')
      return [
        {
          name: 'write',
          kind: 'agent',
          yields: 'commit',
          run: async (ctx) => {
            order.push('implement')
            implementSaw.push(ctx)
            return { ...PASSED, head: `c0ffee${implementSaw.length}` }
          },
        },
      ]
    if (step === 'review')
      return [
        {
          name: 'cold',
          kind: 'agent',
          yields: 'verdict',
          run: async (ctx) => {
            order.push('review')
            reviewSaw.push(ctx)
            return PASSED
          },
        },
      ]
    return actions.map((a) => ({ name: a.name, kind: 'run', yields: 'verdict', run: async () => PASSED }) as Action)
  }
  const ports = attemptPortsFrom({
    recipe,
    context,
    emit: () => undefined,
    bodies,
    actionsAt,
    ceilings: { rounds: 2, restarts: 0, restartsSpent: 0 },
    judge: async () => ({ next: 'implement', named: 'test', why: 'the lines' }),
    ...(options.from === undefined ? {} : { from: options.from }),
  } as AttemptOptions)
  const result = await Effect.runPromise(
    runAttemptEffect({
      ...ports,
      ...(options.port === undefined
        ? {}
        : {
            mergeForConflict: (baseSha: string) =>
              Effect.suspend(() => {
                order.push(`port ${baseSha}`)
                return options.port!(baseSha)
              }),
          }),
    }),
  )
  return { result, order, implementSaw, reviewSaw }
}

describe('a bought conflict round', () => {
  it('merges the lane’s base before the round’s agent, and tells the walk what is standing', async () => {
    const { result, order, implementSaw, reviewSaw } = await walk({
      lane: [conflicted(BASE)],
      port: () => Effect.succeed(STANDING),
    })

    expect(order.filter((o) => o.startsWith('port'))).toEqual([`port ${BASE}`])
    // Before that round's `implement`, and after the first one.
    expect(order.indexOf(`port ${BASE}`)).toBeGreaterThan(order.indexOf('implement'))
    expect(order.indexOf(`port ${BASE}`)).toBeLessThan(order.lastIndexOf('implement'))
    expect(implementSaw).toHaveLength(2)
    const round = implementSaw[1]!
    expect(round.conflictMerge).toEqual({ baseSha: BASE, fromSha: FORK, paths: ['src/fix.ts'] })
    expect(round.landedOnBase).toEqual({
      paths: ['src/fix.ts', 'src/other.ts'],
      conflicted: ['src/fix.ts'],
      fromSha: FORK,
      toSha: BASE,
    })
    expect(round.mergedOnto).toBe(BASE)
    expect('reviewedSha' in round).toBe(false)
    // The review after the round is asked about the same merge.
    expect(reviewSaw.at(-1)?.landedOnBase).toMatchObject({ conflicted: ['src/fix.ts'], toSha: BASE })
    expect(result.end).toMatchObject({ _tag: 'Landed' })
  })

  it('goes to a person, with no round, when the port answers failed', async () => {
    const { result, implementSaw } = await walk({
      lane: [conflicted(BASE)],
      port: () => Effect.succeed({ failed: 'the lane’s conflict did not reproduce in the worktree' }),
    })

    expect(implementSaw).toHaveLength(1)
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: {
        _tag: 'ProposedEscalated',
        because: { _tag: 'JudgeHandedOver', why: expect.stringContaining('did not reproduce') },
      },
    })
  })

  it('goes to a person when the lane named no base sha, without asking the port', async () => {
    const { result, order } = await walk({
      lane: [conflicted(null)],
      port: () => Effect.succeed(STANDING),
    })

    expect(order.some((o) => o.startsWith('port'))).toBe(false)
    expect(result.end).toMatchObject({ _tag: 'WaitOnPerson' })
  })

  it('goes to a person when the pass was handed no port', async () => {
    const { result, implementSaw } = await walk({ lane: [conflicted(BASE)] })

    expect(implementSaw).toHaveLength(1)
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: { because: { why: expect.stringContaining('no way to merge the base in') } },
    })
  })

  it('does not carry the merge into a later fix round', async () => {
    const { implementSaw } = await walk({
      lane: [conflicted(BASE), conflicted(BASE)],
      port: () => Effect.succeed(STANDING),
    })

    // Two conflict rounds: each is told its own merge.
    expect(implementSaw.slice(1).every((c) => c.conflictMerge?.baseSha === BASE)).toBe(true)
  })
})

describe('a granted conflict round', () => {
  const grant = {
    why: 'A person granted one checked fix round.',
    asked: null,
    printed: { step: 'merge', detail: 'src/fix.ts', because: 'conflict' },
  } as never

  it('merges the base in before the continuation’s first implement', async () => {
    const { order, implementSaw } = await walk({
      lane: [],
      port: () => Effect.succeed(STANDING),
      from: {
        step: 'implement',
        waive: [],
        grant,
        findings: [],
        conflict: { baseSha: BASE, paths: ['src/fix.ts'] },
      },
    })

    expect(order[0]).toBe(`port ${BASE}`)
    expect(order[1]).toBe('implement')
    expect(implementSaw[0]?.conflictMerge).toEqual({ baseSha: BASE, fromSha: FORK, paths: ['src/fix.ts'] })
    expect(implementSaw[0]?.landedOnBase?.conflicted).toEqual(['src/fix.ts'])
  })

  it('goes to a person when the merge cannot be made, and runs no round', async () => {
    const { result, implementSaw } = await walk({
      lane: [],
      port: () => Effect.succeed({ failed: 'the tree holds changes the merge would trip on: M src/a.ts' }),
      from: { step: 'implement', waive: [], grant, findings: [], conflict: { baseSha: BASE, paths: [] } },
    })

    expect(implementSaw).toHaveLength(0)
    expect(result.end).toMatchObject({ _tag: 'WaitOnPerson' })
  })

  it('keeps today’s brief, with no port call, on a wait that recorded no base sha', async () => {
    const { order, implementSaw } = await walk({
      lane: [],
      port: () => Effect.succeed(STANDING),
      from: { step: 'implement', waive: [], grant, findings: [] },
    })

    expect(order.some((o) => o.startsWith('port'))).toBe(false)
    expect(implementSaw[0] && 'conflictMerge' in implementSaw[0]).toBe(false)
  })
})
