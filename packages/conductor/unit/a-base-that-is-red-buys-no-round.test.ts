import type { Action, ActionContext, CommandOutcome } from '@lingtai/actions'
import { routeNext, STEPS, type Step } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { StepMap } from '@lingtai/recipe'
/**
 * **A `build` refusal the base shares buys no round** (#744, 0108 §13): `runAttempt` asks
 * `baseIsRed` before `replyFor`, only when a round is on offer, and a `red` releases the ticket
 * `BaseRed` keeping its head (#1208), the stored route replaying as that release. Over fake bodies and the memory store — the live wiring
 * in `conduct.ts` (the cut, the plant) is reached only by the integration half.
 */
import { Effect } from 'effect'
import { describe, expect, it, vi } from 'vitest'

import { createBaseCheck } from '../src/base-check.ts'
import {
  runAttemptEffect,
  attemptPortsFrom,
  type AttemptOptions,
  type StepBodies,
  type StepEnding,
} from '../src/run-attempt.ts'

const context: ActionContext = { runId: 'pass-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }
const SHA = 'a'.repeat(40)
const PASSED = { verdict: 'passed' as const, evidence: 'green', findings: [] }

const bodies = Object.fromEntries(
  STEPS.map((step) => [step, (): Effect.Effect<StepEnding> => Effect.succeed<StepEnding>({ ending: 'passed' })]),
) as unknown as StepBodies

const actionsAt =
  (): AttemptOptions['actionsAt'] =>
  (step: Step): Action[] => {
    if (step === 'admit')
      return [{ name: 'cut', kind: 'worktree', yields: 'worktree', run: async (c) => ({ ...PASSED, head: c.onSha }) }]
    if (step === 'implement')
      return [{ name: 'write', kind: 'agent', yields: 'commit', run: async () => ({ ...PASSED, head: 'c0ffee0' }) }]
    if (step === 'build') {
      return [
        {
          name: 'tests',
          kind: 'run',
          yields: 'verdict',
          run: async () => ({ verdict: 'failed', evidence: 'head: 3 errors', findings: [] }),
        },
      ]
    }
    return []
  }

const run = (ceilings: { rounds: number }, over: Partial<AttemptOptions>) =>
  Effect.runPromise(
    runAttemptEffect(
      attemptPortsFrom({
        recipe: { steps: StepMap.parse({}) },
        context,
        emit: () => {},
        bodies,
        actionsAt: actionsAt(),
        ceilings: {
          refusalFixes: ceilings.rounds,
          conflictResolutions: ceilings.rounds,
          newAttempts: 0,
          newAttemptsSpent: 0,
        },
        ...over,
      }),
    ),
  )

const red = {
  red: { command: 'pnpm test', base: 'main', baseSha: SHA, evidence: 'base: 58 errors', boundary: 'unsandboxed' },
}

describe('a build refusal the base shares', () => {
  it('releases the ticket keeping its head, buys no round, waits on nobody, and visits implement once', async () => {
    const baseIsRed = vi.fn(async () => red)
    const result = await run({ rounds: 2 }, { baseIsRed })
    expect(baseIsRed).toHaveBeenCalledWith({ action: 'tests', mergedOnto: null })
    expect(result.end).toEqual({
      _tag: 'Requeued',
      cause: {
        _tag: 'BaseRed',
        runId: 'pass-1',
        headSha: 'c0ffee0',
        base: 'main',
        baseSha: SHA,
        command: 'pnpm test',
        boundary: 'unsandboxed',
      },
    })
    expect(result.steps.filter((s) => s.step === 'implement')).toHaveLength(1)
    expect(result.routes[0]!.why).toContain('base is red: `pnpm test`')
    // The stored triple replays as the release the pass ended in, never as a wait.
    const route = result.routes[0]!
    expect(routeNext(route.offer, route.reply, route.decision, { runId: 'pass-1' })).toEqual(result.end)
  })

  it.each([
    ['green', { notRed: 'green' }],
    ['unknown', { notRed: 'could not be checked' }],
  ])('goes on to a fix round when the base is %s', async (_name, answer) => {
    const result = await run({ rounds: 1 }, { baseIsRed: async () => answer, judge: async () => ({ noJudge: true }) })
    expect(result.steps.filter((s) => s.step === 'implement').length).toBeGreaterThan(1)
  })

  it('never asks with rounds: 0', async () => {
    const baseIsRed = vi.fn(async () => red)
    const result = await run({ rounds: 0 }, { baseIsRed })
    expect(baseIsRed).not.toHaveBeenCalled()
    expect(result.end._tag).toBe('WaitOnPerson')
  })

  it('never asks a declared judge', async () => {
    const judge = vi.fn(async () => ({ noJudge: true as const }))
    await run({ rounds: 2 }, { baseIsRed: async () => red, judge })
    expect(judge).not.toHaveBeenCalled()
  })

  it('shares one run between two passes cut from the same base', async () => {
    const exits = vi.fn(async (): Promise<CommandOutcome> => ({
      ok: false,
      exitCode: 1,
      timedOut: false,
      evidence: 'base: 58 errors',
      durationMs: 5,
    }))
    const check = createBaseCheck({
      store: createMemoryEventStore(),
      run: () => Effect.promise(() => exits()),
      worktreePath: (p, sha7, id) => `/wt/${p}/base-${sha7}-${id}`,
      note: () => {},
    })
    const tree = { cut: async () => {}, remove: async () => {}, plant: async () => {} }
    const baseIsRed = async () => {
      const answer = await Effect.runPromise(
        check.ask({
          project: 'proj',
          base: 'main',
          baseSha: SHA,
          command: 'pnpm test',
          prepared: [],
          env: {},
          runId: 'pass-1',
          signal: new AbortController().signal,
          timeoutMs: 1000,
          tree,
        }),
      )
      return answer.verdict === 'red'
        ? {
            red: {
              command: 'pnpm test',
              base: 'main',
              baseSha: SHA,
              evidence: answer.evidence,
              boundary: answer.boundary,
            },
          }
        : { notRed: answer.verdict }
    }
    const first = await run({ rounds: 2 }, { baseIsRed })
    const second = await run({ rounds: 2 }, { baseIsRed })
    for (const result of [first, second]) {
      expect(result.end).toMatchObject({ _tag: 'Requeued', cause: { _tag: 'BaseRed' } })
    }
    expect(exits).toHaveBeenCalledTimes(2)
  })

  describe('asked first, when the project was red at claim (#1208)', () => {
    it('releases BaseRed with no agent run and no step past admit', async () => {
      const baseIsRed = vi.fn(async () => red)
      const result = await run({ rounds: 2 }, { baseIsRed, baseFirst: { action: 'tests' } })
      expect(baseIsRed).toHaveBeenCalledTimes(1)
      expect(result.end).toMatchObject({ _tag: 'Requeued', cause: { _tag: 'BaseRed', headSha: 'abc1234def' } })
      expect(result.steps.map((s) => s.step)).not.toContain('implement')
      expect(result.steps.map((s) => s.step)).not.toContain('prepared')
    })

    it.each([
      ['green', { notRed: 'green' }],
      ['unknown', { notRed: 'could not be checked' }],
    ])('goes on to implement when the base is %s', async (_name, answer) => {
      const result = await run({ rounds: 0 }, { baseIsRed: async () => answer, baseFirst: { action: 'tests' } })
      expect(result.steps.map((s) => s.step)).toContain('implement')
    })
  })
})
