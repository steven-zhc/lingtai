import { boundedEvidence, runCommand } from '@lingtai/actions'
import { resolveAgentEnv, runnableEnv, productionPatterns } from '@lingtai/agent-env'
import { parseDuration, readRecipeKey, type RecipeFiles } from '@lingtai/recipe'
import { provisionWorktreeEffect, removeWorktreeEffect, type ProvisionOptions } from '@lingtai/repo'
import { Data, Effect, Ref } from 'effect'

/**
 * The trial run #436 adds to #397's install and build questions: the confirmed
 * commands, run once in a throwaway worktree cut from the mirror at the base,
 * with the env file planted, as a pass would. No agent runs and nothing is
 * spent — it is the repository's own commands, on this machine.
 *
 * **The worktree is removed in a `finally`**, so a red or interrupted trial
 * never leaves a checkout with a planted secrets file behind. Ctrl+C is not a
 * result: the runner throws `TrialInterrupted` after the removal, and
 * `setup-build.ts` turns that into a refusal rather than the failed-list
 * question.
 */
import { messageOf } from './failure.ts'
import { portCause } from './port-cause.ts'

/**
 * One command the trial run tried, and how it went. A command the trial never
 * reached is `not-run` and carries why, not evidence: nothing ran to produce any.
 */
export type TrialResult =
  | { command: string; outcome: 'passed' | 'failed'; evidence: string }
  | { command: string; outcome: 'not-run'; because: string }

/** What a trial hands back: its results, and whether the recipe declares any env. */
export interface TrialReport {
  results: TrialResult[]
  nothingDeclared: boolean
}

/** The trial: the base it will cut at (asked when it is about to run), and the run itself. */
export interface Trial {
  base: Effect.Effect<string, unknown>
  run: (install: string | null, build: string[]) => Effect.Effect<TrialReport, unknown>
}

/** Thrown by the runner, after its worktree is gone, when Ctrl+C stopped the trial. */
export class TrialInterrupted extends Data.TaggedError('TrialInterrupted') {
  override get message() {
    return 'the trial run was interrupted'
  }
}

/** `runPlugin`'s own default timeout (`packages/recipe/src/recipe.ts`) — what a command the file does not mention gets. */
const RUN_TIMEOUT = '15m'

/** Where `recipe-flow.ts`'s `ENV_PLANT_AT` plants it, for a recipe that does not exist yet. */
const DEFAULT_PLANT_AT = '.env.local'

export interface TrialDeps {
  provision: (options: ProvisionOptions) => Effect.Effect<{ path: string }, unknown>
  remove: (options: { project: string; runId: string; home?: string }) => Effect.Effect<void, unknown>
  run: typeof runCommand
  resolveEnv: typeof resolveAgentEnv
  /** Stable per-trial id, so the worktree path never collides with a pass's. */
  runId: () => string
  log: (line: string) => void
}

export const liveTrialDeps = (log: (line: string) => void): TrialDeps => ({
  provision: provisionWorktreeEffect,
  remove: removeWorktreeEffect,
  run: runCommand,
  resolveEnv: resolveAgentEnv,
  runId: () => `setup-${Date.now()}`,
  log,
})

export interface TrialAt {
  project: string
  /** '' for a project with no GitHub owner, as a pass does. */
  owner: string
  repo: string
  /** The branch the worktree is cut from. */
  base: string
  remote?: string
  token?: ProvisionOptions['token']
  home?: string
  files?: RecipeFiles
  /** Aborted by Ctrl+C; the caller owns the listener. */
  interrupt?: AbortSignal
}

interface Run {
  run: string
  timeout: string
}

function asStrings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : undefined
}

/** A recipe key, or `null` when it cannot be read. */
const recipeKey = (at: TrialAt, path: string[]): Effect.Effect<unknown> =>
  Effect.tryPromise(() => readRecipeKey(at.project, path, { home: at.home, files: at.files })).pipe(
    Effect.catch(() => Effect.succeed(null)),
  )

/** The timeouts of `run:` actions already in the file, by command text. */
const keptTimeouts = (at: TrialAt): Effect.Effect<Map<string, string>> =>
  Effect.gen(function* () {
    const out = new Map<string, string>()
    for (const step of ['prepared', 'build']) {
      const value = yield* recipeKey(at, ['steps', step])
      if (!Array.isArray(value)) continue
      for (const a of value) {
        const { run, timeout } = (a ?? {}) as { run?: unknown; timeout?: unknown }
        if (typeof run === 'string' && typeof timeout === 'string') out.set(run, timeout)
      }
    }
    return out
  })

/**
 * Where the next pass cuts from, and whether it takes submodules: what the file
 * already says (`baseOf` and `submodulesOf`, `settings.ts` — `worktree:` at
 * `admit` first, then `repo:`), and only for a recipe that says nothing, the
 * base the caller was handed. A flag or GitHub's default branch is not where an
 * existing project's passes run.
 */
const cutOf = (at: TrialAt): Effect.Effect<{ base: string; submodules: boolean }> =>
  Effect.gen(function* () {
    const admit = yield* recipeKey(at, ['steps', 'admit'])
    const declared = Array.isArray(admit)
      ? (admit.find((a) => a !== null && typeof a === 'object' && 'worktree' in a) as
          | { worktree?: unknown }
          | undefined)
      : undefined
    const wt = (declared?.worktree ?? {}) as { base?: unknown; submodules?: unknown }
    const repoBase = yield* recipeKey(at, ['repo', 'base'])
    const repoSubmodules = yield* recipeKey(at, ['repo', 'submodules'])
    const base = typeof wt.base === 'string' ? wt.base : typeof repoBase === 'string' ? repoBase : at.base
    const submodules = typeof wt.submodules === 'boolean' ? wt.submodules : repoSubmodules === true
    return { base, submodules }
  })

export const trialBaseEffect = Effect.fn('setup.trial.base')(function* (at: TrialAt) {
  return (yield* cutOf(at)).base
})

type Used = { results: TrialResult[]; interrupted: boolean }

export const runTrialEffect = Effect.fn('setup.trial')(function* (
  at: TrialAt,
  deps: TrialDeps,
  install: string | null,
  build: string[],
) {
  const envBlock = yield* recipeKey(at, ['env'])
  const declared = (envBlock ?? {}) as Record<string, unknown>
  const plantAt = typeof declared['plantAt'] === 'string' ? declared['plantAt'] : DEFAULT_PLANT_AT
  const nothingDeclared = asStrings(declared['required'])?.length ? false : asStrings(declared['allow']) === undefined

  const env = yield* Effect.tryPromise(() =>
    deps.resolveEnv({
      project: at.project,
      required: asStrings(declared['required']),
      allow: asStrings(declared['allow']),
      deny: asStrings(declared['deny']),
      patterns: productionPatterns(asStrings(declared['refuseHosts'])),
      home: at.home,
    }),
  ).pipe(Effect.catch((err) => Effect.succeed({ refusal: messageOf(err.cause), values: {} as Record<string, string> })))
  const runs = [...(install === null ? [] : [install]), ...build]
  if (env.refusal) {
    return {
      results: [{ command: 'env', outcome: 'failed', evidence: env.refusal }, ...notRun(runs, 'the env refused')],
      nothingDeclared,
    } as TrialReport
  }

  const timeouts = yield* keptTimeouts(at)
  const commands: Run[] = runs.map((run) => ({
    run,
    timeout: timeouts.get(run) ?? RUN_TIMEOUT,
  }))

  const cut = yield* cutOf(at)
  const leftBehind = yield* Ref.make<string | null>(null)

  // The resource is the run id, not the worktree: a half-cut checkout is
  // removed too, so `remove` runs even when `provision` threw.
  const used: Used = yield* Effect.acquireUseRelease(
    Effect.sync(() => deps.runId()),
    (runId) =>
      Effect.gen(function* () {
        const results: TrialResult[] = []
        let interrupted = false
        deps.log(`cutting a throwaway worktree at ${cut.base} — the first time this clones the repository`)
        // Uninterruptible: `remove` must not start while git is still writing.
        // Ctrl+C reaches git through its process group, not through the fiber.
        const cutting = yield* Effect.uninterruptible(
          portCause(() =>
            deps.provision({
              project: at.project,
              owner: at.owner,
              repo: at.repo,
              base: cut.base,
              branch: 'setup-trial',
              runId,
              submodules: cut.submodules,
              plantAt,
              env: env.values,
              token: at.token,
              remote: at.remote,
              home: at.home,
            }),
          ),
        ).pipe(
          Effect.match({
            onSuccess: (wt) => ({ path: wt.path as string | null, error: null as unknown }),
            onFailure: (error) => ({ path: null as string | null, error }),
          }),
        )
        const path = cutting.path
        if (path === null) {
          // Ctrl+C stops git as well, and that is not a git failure.
          if (at.interrupt?.aborted) interrupted = true
          else {
            results.push({ command: 'git', outcome: 'failed', evidence: boundedEvidence(messageOf(cutting.error)) })
            results.push(...notRun(runs, 'the worktree could not be cut'))
          }
        }

        for (const [i, command] of path === null ? [] : commands.entries()) {
          if (at.interrupt?.aborted) {
            interrupted = true
            break
          }
          // `Effect.promise`, not `tryPromise`: a throw is a defect carrying the
          // runner's own error. Interrupting the fiber aborts the signal and
          // resumes at once without awaiting the runner, so `remove` may start
          // while the killed group is still exiting; a host that interrupts the
          // fiber is where to make the run wait for its own kill.
          const outcome = yield* Effect.promise((signal) =>
            deps.run({
              run: command.run,
              timeoutMs: parseDuration(command.timeout),
              timeoutLabel: command.timeout,
              cwd: path!,
              env: runnableEnv(env.values),
              signal: at.interrupt ? AbortSignal.any([at.interrupt, signal]) : signal,
              ownGroup: true,
            }),
          )
          if (at.interrupt?.aborted) {
            interrupted = true
            break
          }
          const ok = outcome.ok && outcome.exitCode === 0
          results.push({ command: command.run, outcome: ok ? 'passed' : 'failed', evidence: outcome.evidence })
          if (!ok) {
            results.push(...notRun(runs.slice(i + 1), `\`${command.run}\` failed first`))
            break
          }
        }
        return { results, interrupted }
      }),
    (runId) =>
      // A failed cleanup must not replace the failure it cleans up after — and
      // must not be hidden either: the checkout holds a planted env file.
      portCause(() => deps.remove({ project: at.project, runId, home: at.home })).pipe(
        Effect.catch((err) =>
          Effect.gen(function* () {
            const why = messageOf(err)
            yield* Ref.set(leftBehind, why)
            deps.log(`could not remove the throwaway checkout (${runId}): ${why}`)
            deps.log('it may still hold the env file setup planted — remove it by hand')
          }),
        ),
      ),
  )

  if (used.interrupted) return yield* new TrialInterrupted()
  const left = yield* Ref.get(leftBehind)
  const results = [...used.results]
  if (left !== null) {
    results.push({
      command: 'cleanup',
      outcome: 'failed',
      evidence: boundedEvidence(
        `the throwaway checkout was not removed and may still hold the planted env file: ${left}`,
      ),
    })
  }
  return { results, nothingDeclared } as TrialReport
})

function notRun(runs: string[], because: string): TrialResult[] {
  return runs.map((command) => ({ command, outcome: 'not-run', because }))
}

/**
 * The live runner: Ctrl+C aborts the running command for the length of the
 * trial only, and the listener is released on every exit, so the process's
 * own Ctrl+C handling is back afterwards.
 */
export const liveTrialEffect = Effect.fn('setup.trial.live')(function* (
  at: Omit<TrialAt, 'interrupt'>,
  install: string | null,
  build: string[],
  deps: TrialDeps = liveTrialDeps((line) => console.log(line)),
) {
  const controller = new AbortController()
  const onSigint = () => controller.abort()
  return yield* Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => void process.once('SIGINT', onSigint)),
        () => Effect.sync(() => void process.off('SIGINT', onSigint)),
      )
      return yield* runTrialEffect({ ...at, interrupt: controller.signal }, deps, install, build)
    }),
  )
})

export const liveTrialBuild = (at: Omit<TrialAt, 'interrupt'>): Trial => ({
  base: trialBaseEffect(at),
  run: (install, build) => liveTrialEffect(at, install, build),
})
