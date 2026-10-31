/**
 * **A `build` refusal the base shares buys no round** (#744, 0108 §13): `runPass` asks
 * `baseIsRed` before `replyFor`, only when a round is on offer, and a `red` ends the pass at a
 * person with the base's own evidence. Over fake bodies and the memory store — the live wiring
 * in `conduct.ts` (the cut, the plant) is reached only by the integration half.
 */
import type { Action, ActionContext, CommandOutcome } from '@lingtai/actions'
import { STEPS, type Step } from '@lingtai/domain'
import { createMemoryEventStore } from '@lingtai/event-store/memory'
import { StepMap } from '@lingtai/recipe'
import { describe, expect, it, vi } from 'vitest'

import { createBaseCheck } from '../src/base-check.ts'
import { runPass, type PassOptions, type StepBodies } from '../src/pass.ts'

const context: ActionContext = { runId: 'pass-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }
const SHA = 'a'.repeat(40)
const PASSED = { verdict: 'passed' as const, evidence: 'green', findings: [] }

const bodies = Object.fromEntries(
  STEPS.map((step) => [step, async () => ({ ending: 'passed' })]),
) as unknown as StepBodies

const actionsAt =
  (): PassOptions['actionsAt'] =>
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

const run = (ceilings: { rounds: number }, over: Partial<PassOptions>) =>
  runPass({
    recipe: { steps: StepMap.parse({}) },
    context,
    emit: () => {},
    bodies,
    actionsAt: actionsAt(),
    ceilings: { rounds: ceilings.rounds, restarts: 0, restartsSpent: 0 },
    ...over,
  })

const red = { red: { command: 'pnpm test', base: 'main', baseSha: SHA, evidence: 'base: 58 errors' } }

describe('a build refusal the base shares', () => {
  it('holds for a person with the base evidence, buys no round, and visits implement once', async () => {
    const baseIsRed = vi.fn(async () => red)
    const result = await run({ rounds: 2 }, { baseIsRed })
    expect(baseIsRed).toHaveBeenCalledWith({ action: 'tests', mergedOnto: null })
    expect(result.end).toMatchObject({
      _tag: 'WaitOnPerson',
      reason: {
        _tag: 'ProposedEscalated',
        proposal: { _tag: 'BuildRed' },
        because: { _tag: 'BaseRed', evidence: 'base: 58 errors' },
      },
    })
    expect(result.steps.filter((s) => s.step === 'implement')).toHaveLength(1)
    expect(result.routes[0]!.why).toContain('base is red: `pnpm test`')
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
      run: exits,
      worktreePath: (p, sha7, id) => `/wt/${p}/base-${sha7}-${id}`,
      note: () => {},
    })
    const tree = { cut: async () => {}, remove: async () => {}, plant: async () => {} }
    const baseIsRed = async () => {
      const answer = await check.ask({
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
      })
      return answer.verdict === 'red'
        ? { red: { command: 'pnpm test', base: 'main', baseSha: SHA, evidence: answer.evidence } }
        : { notRed: answer.verdict }
    }
    const first = await run({ rounds: 2 }, { baseIsRed })
    const second = await run({ rounds: 2 }, { baseIsRed })
    for (const result of [first, second]) {
      expect(result.end).toMatchObject({ reason: { because: { _tag: 'BaseRed' } } })
    }
    expect(exits).toHaveBeenCalledTimes(1)
  })
})
