/**
 * Every step `runPlugin` serves, with a *sandboxed* decision and without one (#1152). The wrap and the runner are
 * fakes that record: no process starts, and the real `Sandbox` is never loaded.
 */
import { runPlugin, type SandboxDecision, type Step } from '@lingtai/recipe'
import { SandboxUnavailable, SandboxWrapFailed, type Wrapped } from '@lingtai/sandbox'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import type { ActionContext } from '../src/action.ts'
import type { CommandOutcome, RunCommandOptions } from '../src/command.ts'
import { ActionUnavailableError, actionPortsFromRecipe, type ActionPortDeps } from '../src/from-recipe.ts'
import type { RunSandbox } from '../src/process-action.ts'

const STEPS = Object.keys(runPlugin.at) as Step[]
const context: ActionContext = { runId: 'pass-abc', onSha: 'a'.repeat(40), cwd: '/tmp/wt', env: { SECRET: 'agent' } }
const action = { name: 'check', run: 'pnpm test', env: [] as string[] }

const sandboxed: SandboxDecision = {
  kind: 'sandboxed',
  project_additions: { network: [], write: [], deny: [] },
}

function fakes(failWith?: SandboxUnavailable | SandboxWrapFailed) {
  const wraps: { command: readonly string[]; worktree: string; env: Record<string, string> }[] = []
  const spawns: RunCommandOptions[] = []
  const sandbox: RunSandbox = {
    wrap: (command, worktree, env) => {
      wraps.push({ command, worktree, env })
      if (failWith) return Effect.fail(failWith)
      return Effect.succeed({ argv: ['/wrap', ...command], env: { ...env, WRAPPED: '1' }, commandId: 'id' } satisfies Wrapped)
    },
  }
  const command = (options: RunCommandOptions): Effect.Effect<CommandOutcome> => {
    spawns.push(options)
    return Effect.succeed({ ok: true, evidence: 'ok', timedOut: false, durationMs: 1, exitCode: 0 })
  }
  const commits: string[] = []
  const deps: ActionPortDeps = {
    env: () => ({ PATH: '/bin' }),
    command,
    keptRun: {
      clean: () => Effect.succeed({ ok: true as const }),
      keep: (name) => {
        commits.push(name)
        return Effect.succeed({ nothing: true as const })
      },
    },
  }
  return { wraps, spawns, sandbox, deps, commits }
}

describe('a sandboxed decision, at every step a run: is served', () => {
  it.each(STEPS)('wraps %s as /bin/sh -c and hands the runner the wrapped argv and env', async (step) => {
    const f = fakes()
    const [port] = actionPortsFromRecipe(step, [action], { ...f.deps, sandboxDecision: sandboxed, sandbox: f.sandbox })
    const result = await Effect.runPromise(port!.run(context))
    expect(result.verdict).toBe('passed')
    expect(f.wraps).toEqual([{ command: ['/bin/sh', '-c', 'pnpm test'], worktree: '/tmp/wt', env: { PATH: '/bin' } }])
    expect(f.spawns).toHaveLength(1)
    expect(f.spawns[0]).toMatchObject({
      run: 'pnpm test',
      ownGroup: true,
      cwd: '/tmp/wt',
      wrapped: { argv: ['/wrap', '/bin/sh', '-c', 'pnpm test'], env: { PATH: '/bin', WRAPPED: '1' } },
    })
    // Not the agent's environment, wrapped or otherwise.
    expect(JSON.stringify(f.spawns[0])).not.toContain('SECRET')
    // At `implement` the kept run's own git is Lingtai's, outside: the wrap saw the command and nothing else.
    expect(f.wraps).toHaveLength(1)
  })
})

describe('a decision that is not sandboxed', () => {
  const unsandboxed: (SandboxDecision | undefined)[] = [
    undefined,
    { kind: 'unsandboxed', reason: 'off by choice' },
    { kind: 'unsandboxed', reason: 'degraded', why: 'no bwrap' },
  ]
  it.each(unsandboxed.map((d) => [d?.kind ?? 'absent', d] as const))('%s never wraps and hands today’s options', async (_n, decision) => {
    for (const step of STEPS) {
      const f = fakes()
      const [port] = actionPortsFromRecipe(step, [action], {
        ...f.deps,
        ...(decision ? { sandboxDecision: decision } : {}),
        sandbox: f.sandbox,
      })
      await Effect.runPromise(port!.run(context))
      expect(f.wraps).toEqual([])
      expect(f.spawns[0]).not.toHaveProperty('wrapped')
      expect(f.spawns[0]).not.toHaveProperty('ownGroup')
      expect(f.spawns[0]).toMatchObject({ run: 'pnpm test', env: { PATH: '/bin' } })
    }
  })
})

describe('fail closed', () => {
  it.each([sandboxed, { kind: 'refused', why: 'no bwrap' } as SandboxDecision])(
    'a $kind decision with no sandbox dep throws ActionUnavailableError by name',
    (decision) => {
      for (const step of STEPS) {
        const f = fakes()
        expect(() => actionPortsFromRecipe(step, [action], { ...f.deps, sandboxDecision: decision })).toThrow(
          ActionUnavailableError,
        )
        expect(f.spawns).toEqual([])
      }
    },
  )
})

describe('a wrap that fails', () => {
  it.each([
    [new SandboxUnavailable({ reason: 'bwrap is missing', sentences: ['install it'] }), 'bwrap is missing; install it'],
    [new SandboxWrapFailed({ cause: new Error('srt said no') }), 'srt said no'],
  ])('fails the action with its sentence and spawns nothing', async (error, sentence) => {
    const f = fakes(error)
    const [port] = actionPortsFromRecipe('build', [action], { ...f.deps, sandboxDecision: sandboxed, sandbox: f.sandbox })
    const result = await Effect.runPromise(port!.run(context))
    expect(result.verdict).toBe('failed')
    expect(result.evidence).toContain(sentence)
    expect(f.spawns).toEqual([])
  })
})
