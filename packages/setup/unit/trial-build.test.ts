/**
 * The trial runner (#436) through fakes of the repo port and the process —
 * running a real `git` and a real shell is integration (0060 §1).
 */
import type { CommandOutcome, RunCommandOptions } from '@lingtai/actions'
import type { RecipeFiles } from '@lingtai/recipe'
import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { liveTrialEffect, runTrialEffect, TrialInterrupted, type TrialAt, type TrialDeps } from '../src/trial-build.ts'

/** A fake port written as a promise, handed over as the Effect the port wants; a throw is the port's failure. */
const lift = <A>(f: () => Promise<A>) => Effect.tryPromise({ try: f, catch: (e) => e })

const files: RecipeFiles = { read: async () => null, replace: async () => {} }
const outcome = (ok: boolean, extra: Partial<CommandOutcome> = {}): CommandOutcome => ({
  ok,
  evidence: ok ? 'fine' : 'broke',
  timedOut: false,
  durationMs: 1,
  exitCode: ok ? 0 : 1,
  ...extra,
})

/** The process, written as a promise and handed over as the Effect the port wants. */
type FakeRun = (o: RunCommandOptions) => Promise<CommandOutcome>

function fakes(
  script: Record<string, CommandOutcome>,
  { run: overRun, ...over }: Partial<Omit<TrialDeps, 'run'>> & { run?: FakeRun } = {},
) {
  const ran: { run: string; cwd: string; timeoutLabel?: string }[] = []
  const cuts: { base: string; submodules: boolean }[] = []
  const removed: string[] = []
  const deps: TrialDeps = {
    provision: (o) =>
      lift(async () => {
        cuts.push({ base: o.base, submodules: o.submodules })
        return { path: '/wt' }
      }),
    remove: ({ runId }) => lift(async () => void removed.push(runId)),
    run: (o) =>
      Effect.promise(
        overRun !== undefined
          ? () => overRun(o)
          : async () => {
              ran.push({ run: o.run, cwd: o.cwd, timeoutLabel: o.timeoutLabel })
              return script[o.run] ?? outcome(true)
            },
      ),
    resolveEnv: async () => ({ values: {}, refusal: null }) as never,
    runId: () => 'setup-1',
    log: () => {},
    ...over,
  }
  return { deps, ran, removed, cuts }
}

const AT: TrialAt = { project: 'widget', owner: '', repo: 'widget', base: 'main', files, home: '/h' }

describe('runTrialEffect', () => {
  it('runs install then each build command in order, in the provisioned worktree, and removes it', async () => {
    const { deps, ran, removed } = fakes({})
    const { results } = await Effect.runPromise(runTrialEffect(AT, deps, 'pnpm i', ['pnpm build', 'pnpm test']))
    expect(ran.map((r) => r.run)).toEqual(['pnpm i', 'pnpm build', 'pnpm test'])
    expect(ran.every((r) => r.cwd === '/wt' && r.timeoutLabel === '15m')).toBe(true)
    expect(results.map((r) => r.outcome)).toEqual(['passed', 'passed', 'passed'])
    expect(removed).toEqual(['setup-1'])
  })

  it('stops at a failing install and says the rest were not run', async () => {
    const { deps, ran, removed } = fakes({ 'pnpm i': outcome(false) })
    const { results } = await Effect.runPromise(runTrialEffect(AT, deps, 'pnpm i', ['pnpm build', 'pnpm test']))
    expect(ran.map((r) => r.run)).toEqual(['pnpm i'])
    expect(results.map((r) => r.outcome)).toEqual(['failed', 'not-run', 'not-run'])
    expect(results.slice(1)).toEqual([
      { command: 'pnpm build', outcome: 'not-run', because: '`pnpm i` failed first' },
      { command: 'pnpm test', outcome: 'not-run', because: '`pnpm i` failed first' },
    ])
    expect(removed).toEqual(['setup-1'])
  })

  it('a failing middle command leaves the one after it not run, naming the cause', async () => {
    const { deps } = fakes({ b: outcome(false) })
    const { results } = await Effect.runPromise(runTrialEffect(AT, deps, null, ['a', 'b', 'c']))
    expect(results).toMatchObject([
      { command: 'a', outcome: 'passed' },
      { command: 'b', outcome: 'failed' },
      { command: 'c', outcome: 'not-run', because: '`b` failed first' },
    ])
  })

  it('a failed result’s evidence never carries the env note, and nothingDeclared travels beside it', async () => {
    const { deps } = fakes({ b: outcome(false) })
    const report = await Effect.runPromise(runTrialEffect(AT, deps, null, ['b']))
    expect(report.nothingDeclared).toBe(true)
    expect((report.results[0] as { evidence: string }).evidence).not.toContain('no env declared')
  })

  it('carries a timeout’s label as evidence', async () => {
    const { deps } = fakes({
      slow: outcome(false, { timedOut: true, exitCode: null, evidence: 'timed out after 15m\n\n' }),
    })
    const { results } = await Effect.runPromise(runTrialEffect(AT, deps, null, ['slow']))
    expect(results[0]).toMatchObject({ outcome: 'failed' })
    expect((results[0] as { evidence: string }).evidence).toContain('timed out after 15m')
  })

  it('turns a provision throw into a failed result and still removes', async () => {
    const { deps, ran, removed } = fakes(
      {},
      {
        provision: () =>
          lift(async () => {
            throw new Error('fatal: could not clone')
          }),
      },
    )
    const { results } = await Effect.runPromise(runTrialEffect(AT, deps, 'pnpm i', ['pnpm build']))
    expect(results).toEqual([
      { command: 'git', outcome: 'failed', evidence: 'fatal: could not clone' },
      { command: 'pnpm i', outcome: 'not-run', because: 'the worktree could not be cut' },
      { command: 'pnpm build', outcome: 'not-run', because: 'the worktree could not be cut' },
    ])
    expect(ran).toEqual([])
    expect(removed).toEqual(['setup-1'])
  })

  it('removes the worktree when a command throws', async () => {
    const { deps, removed } = fakes(
      {},
      {
        run: async () => {
          throw new Error('spawn failed')
        },
      },
    )
    await expect(Effect.runPromise(runTrialEffect(AT, deps, null, ['x']))).rejects.toThrow('spawn failed')
    expect(removed).toEqual(['setup-1'])
  })

  it('throws TrialInterrupted after removing the worktree when aborted', async () => {
    const controller = new AbortController()
    const { deps, removed } = fakes(
      {},
      {
        run: async () => {
          controller.abort()
          return outcome(false)
        },
      },
    )
    await expect(
      Effect.runPromise(runTrialEffect({ ...AT, interrupt: controller.signal }, deps, null, ['x'])),
    ).rejects.toBeInstanceOf(TrialInterrupted)
    expect(removed).toEqual(['setup-1'])
  })

  it('never provisions when the environment is refused', async () => {
    let provisioned = false
    const { deps, removed } = fakes(
      {},
      {
        resolveEnv: async () => ({ values: {}, refusal: 'FOO is required' }) as never,
        provision: () =>
          lift(async () => {
            provisioned = true
            return { path: '/wt' }
          }),
      },
    )
    const { results } = await Effect.runPromise(runTrialEffect(AT, deps, 'i', ['x', 'y']))
    expect(results).toEqual([
      { command: 'env', outcome: 'failed', evidence: 'FOO is required' },
      { command: 'i', outcome: 'not-run', because: 'the env refused' },
      { command: 'x', outcome: 'not-run', because: 'the env refused' },
      { command: 'y', outcome: 'not-run', because: 'the env refused' },
    ])
    expect(provisioned).toBe(false)
    expect(removed).toEqual([])
  })

  it('uses a kept run: action’s timeout for the same command', async () => {
    const yml = 'steps:\n  build:\n    - run: pnpm build\n      timeout: 30m\n'
    const { deps, ran } = fakes({})
    await Effect.runPromise(
      runTrialEffect({ ...AT, files: { ...files, read: async () => yml } }, deps, null, ['pnpm build']),
    )
    expect(ran[0]!.timeoutLabel).toBe('30m')
  })

  it('cuts from the base and submodules the existing recipe declares, not the one handed in', async () => {
    const yml = 'repo:\n  base: release\n  submodules: true\n'
    const { deps, cuts } = fakes({})
    await Effect.runPromise(runTrialEffect({ ...AT, files: { ...files, read: async () => yml } }, deps, null, ['x']))
    expect(cuts).toEqual([{ base: 'release', submodules: true }])
  })

  it('prefers the worktree action at admit over repo', async () => {
    const yml =
      'repo:\n  base: release\nsteps:\n  admit:\n    - worktree:\n        base: next\n        submodules: true\n'
    const { deps, cuts } = fakes({})
    await Effect.runPromise(runTrialEffect({ ...AT, files: { ...files, read: async () => yml } }, deps, null, ['x']))
    expect(cuts).toEqual([{ base: 'next', submodules: true }])
  })

  it('says so when the checkout could not be removed', async () => {
    const lines: string[] = []
    const { deps } = fakes(
      {},
      {
        remove: () =>
          lift(async () => {
            throw new Error('EACCES')
          }),
        log: (l) => void lines.push(l),
      },
    )
    const { results } = await Effect.runPromise(runTrialEffect(AT, deps, null, ['x']))
    expect(results.at(-1)).toMatchObject({ command: 'cleanup', outcome: 'failed' })
    expect((results.at(-1) as { evidence: string }).evidence).toContain('EACCES')
    expect(lines.join('\n')).toContain('remove it by hand')
  })

  it('treats a provision failure under Ctrl+C as an interruption', async () => {
    const controller = new AbortController()
    const { deps, removed } = fakes(
      {},
      {
        provision: () =>
          lift(async () => {
            controller.abort()
            throw new Error('git killed')
          }),
      },
    )
    await expect(
      Effect.runPromise(runTrialEffect({ ...AT, interrupt: controller.signal }, deps, null, ['x'])),
    ).rejects.toBeInstanceOf(TrialInterrupted)
    expect(removed).toEqual(['setup-1'])
  })
})

describe('fiber interruption and the Ctrl+C wrapper', () => {
  it('removes the worktree and aborts the signal handed to the runner when the fiber is interrupted', async () => {
    let seen: AbortSignal | undefined
    let started!: () => void
    const running = new Promise<void>((r) => (started = r))
    const { deps, removed } = fakes(
      {},
      {
        run: (o) => {
          seen = o.signal
          started()
          return new Promise(() => {})
        },
      },
    )
    const fiber = Effect.runFork(runTrialEffect(AT, deps, null, ['x']))
    await running
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(seen?.aborted).toBe(true)
    expect(removed).toEqual(['setup-1'])
  })

  it('leaves no SIGINT listener behind on a pass, a red and a runner throw', async () => {
    const before = process.listenerCount('SIGINT')
    const at = { project: 'widget', owner: '', repo: 'widget', base: 'main', files, home: '/h' }
    const live = (deps: TrialDeps) => Effect.runPromise(liveTrialEffect(at, null, ['x'], deps))
    await live(fakes({}).deps)
    await live(fakes({ x: outcome(false) }).deps)
    await expect(
      live(
        fakes(
          {},
          {
            run: async () => {
              throw new Error('spawn failed')
            },
          },
        ).deps,
      ),
    ).rejects.toThrow('spawn failed')
    expect(process.listenerCount('SIGINT')).toBe(before)
  })
})
