/**
 * `run:` after the agent at `implement`, through the real `runPass` and
 * `runActionPipeline` — `#390`.
 *
 * `actionsAt` replaces every step's declared list with fakes — `pass.test.ts`'s
 * own `judging()` does the same — so what runs is `runPass`, `runStep`,
 * `runActionPipeline`, `headFrom` and `endingOf`, the five that decide whose
 * commit `build` judges. Unit by 0060 §1: no process, no git, no agent.
 */
import type { Action, ActionResult } from '@lingtai/actions'
import { createKeptRunAction, type KeptRunActionDeps, type KeptRunAnswer } from '@lingtai/actions'
import { STEPS, type Step } from '@lingtai/domain'
import { StepMap } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import {
  outcomeOf,
  runPass,
  type Destination,
  type PassOptions,
  type StepBodies,
  type StepEnding,
  type StepWork,
} from '../src/pass.ts'

const PASSED: ActionResult = { verdict: 'passed', evidence: 'green', findings: [] }

/** The recipe this file resolves — `implement: [agent, run]`, as the ticket writes it. */
const recipe: PassOptions['recipe'] = {
  steps: StepMap.parse({
    implement: [
      { name: 'write the change', agent: 'claude-code', prompt: '' },
      { name: 'format', run: 'pnpm fmt', timeout: '5m', env: [] },
    ],
  }),
}

const context = { runId: 'run-1', onSha: 'abc1234def', cwd: '/nowhere', env: {} }

/** The agent's own action, reporting the head it committed — `createWorkAction`'s shape. */
function agentCommitting(head: string): Action {
  return { name: 'write the change', kind: 'agent', run: async () => ({ ...PASSED, head }) }
}

function fakePort(answer: KeptRunAnswer): KeptRunActionDeps & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async baseline() {
      return new Set()
    },
    async keep() {
      calls.push('keep')
      return answer
    },
    async restore() {
      calls.push('restore')
      return { ok: true }
    },
  }
}

/** One command, wrapped the way `actionsFromRecipe` wraps a `run:` at `implement`. */
function runCommand(verdict: ActionResult, port: KeptRunActionDeps): Action {
  return createKeptRunAction('format', { name: 'format', kind: 'run', run: async () => verdict }, port)
}

function routerSaying(to: (work: StepWork<'proposed'>) => Destination) {
  return async (work: StepWork<Step>): Promise<StepEnding> => {
    const at = work as StepWork<'proposed'>
    if (at.arriving === null) return { ending: 'passed' }
    return { ending: 'routed', to: to(at), why: 'because a test said so' }
  }
}

const PASSING: StepBodies = Object.fromEntries(
  STEPS.map((step) => [step, async (): Promise<StepEnding> => ({ ending: 'passed' })]),
) as unknown as StepBodies

/** `build`'s body, overridden only to record the head its plugins were judged against. */
function watchingBuild(
  seenAt: Record<string, string>,
): (work: StepWork<'build'>) => Promise<{ readonly ending: 'passed' }> {
  return async (work) => {
    seenAt.build = work.context.onSha
    return { ending: 'passed' }
  }
}

/**
 * `implement` carries each lap's `[agent, run]`; `build` reports `failed` on
 * lap 0 where a test asks it to, and `passed` otherwise; every other step
 * runs whatever the recipe declared (`[]` everywhere but `implement`),
 * which is a no-op pipeline that passes.
 */
function actionsAtWith(
  implementLaps: readonly (readonly Action[])[],
  buildFailsOnLap0 = false,
): PassOptions['actionsAt'] {
  const laps = new Map<Step, number>()
  return (step, actions) => {
    const lap = laps.get(step) ?? 0
    laps.set(step, lap + 1)
    if (step === 'implement') return implementLaps[Math.min(lap, implementLaps.length - 1)]!
    if (step === 'build' && buildFailsOnLap0) {
      return [
        {
          name: 'check',
          kind: 'run',
          run: async () => (lap === 0 ? { ...PASSED, verdict: 'failed' as const, evidence: '3 failing' } : PASSED),
        },
      ]
    }
    return actions.map((a) => ({ name: a.name, kind: 'run' as const, run: async () => PASSED }))
  }
}

describe('a run at implement commits what it changed, before build judges it', () => {
  it('advances `onSha` to the commit, and build judges that commit', async () => {
    const run = runCommand(PASSED, fakePort({ committed: 'c3c3c3c' }))
    const seenAt: Record<string, string> = {}
    const result = await runPass({
      recipe,
      context,
      emit: () => {},
      bodies: { ...PASSING, build: watchingBuild(seenAt) },
      actionsAt: actionsAtWith([[agentCommitting('b2b2b2b'), run]]),
    })

    expect(result.stoppedAt).toBeNull()
    expect(seenAt.build).toBe('c3c3c3c')
  })

  it('leaves `onSha` at the agent’s commit when the run changed nothing', async () => {
    const run = runCommand(PASSED, fakePort({ clean: true }))
    const seenAt: Record<string, string> = {}
    const result = await runPass({
      recipe,
      context,
      emit: () => {},
      bodies: { ...PASSING, build: watchingBuild(seenAt) },
      actionsAt: actionsAtWith([[agentCommitting('b2b2b2b'), run]]),
    })

    expect(result.stoppedAt).toBeNull()
    expect(seenAt.build).toBe('b2b2b2b')
  })

  it('does not refuse when the command fails, and build still judges the agent’s commit', async () => {
    const port = fakePort({ committed: 'c3c3c3c' })
    const run = runCommand({ verdict: 'failed', evidence: 'pnpm fmt exited 1', findings: [] }, port)
    const seenAt: Record<string, string> = {}
    const result = await runPass({
      recipe,
      context,
      emit: () => {},
      bodies: { ...PASSING, build: watchingBuild(seenAt) },
      actionsAt: actionsAtWith([[agentCommitting('b2b2b2b'), run]]),
    })

    expect(result.stoppedAt).toBeNull()
    expect(seenAt.build).toBe('b2b2b2b')
    expect(result.steps.find((v) => v.step === 'implement')?.ending.ending).toBe('passed')
    expect(port.calls).toEqual(['restore'])
  })

  it('runs again after each fix round’s agent run', async () => {
    const ports = [fakePort({ committed: 'c3c3c3c' }), fakePort({ committed: 'd4d4d4d' })]
    const laps = [
      [agentCommitting('b2b2b2b'), runCommand(PASSED, ports[0]!)],
      [agentCommitting('e5e5e5e'), runCommand(PASSED, ports[1]!)],
    ]

    const result = await runPass({
      recipe,
      context,
      emit: () => {},
      ceilings: { rounds: 2, restartsLeft: 0 },
      bodies: { ...PASSING, proposed: routerSaying(() => 'implement') },
      actionsAt: actionsAtWith(laps, true),
    })

    expect(result.stoppedAt).toBeNull()
    expect(outcomeOf(result)).toBe('landed')
    // The run after the agent ran once per lap — once in the first pass and
    // once more after the fix round's agent run, each committing its own head.
    expect(ports[0]!.calls).toEqual(['keep'])
    expect(ports[1]!.calls).toEqual(['keep'])
  })
})
