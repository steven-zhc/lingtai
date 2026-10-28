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
import { boundedEvidence, runCommand } from '@lingtai/actions'
import { resolveAgentEnv, runnableEnv, productionPatterns } from '@lingtai/agent-env'
import { parseDuration, readRecipeKey, type RecipeFiles } from '@lingtai/recipe'
import { provisionWorktree, removeWorktree, type ProvisionOptions } from '@lingtai/repo'

import type { AskInstallAndBuildInput, TrialResult } from './setup-build.ts'

/** Thrown by the runner, after its worktree is gone, when Ctrl+C stopped the trial. */
export class TrialInterrupted extends Error {
  constructor() {
    super('the trial run was interrupted')
    this.name = 'TrialInterrupted'
  }
}

/** `runPlugin`'s own default timeout (`packages/recipe/src/recipe.ts`) — what a command the file does not mention gets. */
const RUN_TIMEOUT = '15m'

/** Where `recipe-flow.ts`'s `ENV_PLANT_AT` plants it, for a recipe that does not exist yet. */
const DEFAULT_PLANT_AT = '.env.local'

export interface TrialDeps {
  provision: (options: ProvisionOptions) => Promise<{ path: string }>
  remove: (options: { project: string; runId: string; home?: string }) => Promise<void>
  run: typeof runCommand
  resolveEnv: typeof resolveAgentEnv
  /** Stable per-trial id, so the worktree path never collides with a pass's. */
  runId: () => string
  log: (line: string) => void
}

export const liveTrialDeps = (log: (line: string) => void): TrialDeps => ({
  provision: provisionWorktree,
  remove: removeWorktree,
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

/** The timeouts of `run:` actions already in the file, by command text. */
async function keptTimeouts(at: TrialAt): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const step of ['prepared', 'build']) {
    const value = await readRecipeKey(at.project, ['steps', step], { home: at.home, files: at.files }).catch(() => null)
    if (!Array.isArray(value)) continue
    for (const a of value) {
      const { run, timeout } = (a ?? {}) as { run?: unknown; timeout?: unknown }
      if (typeof run === 'string' && typeof timeout === 'string') out.set(run, timeout)
    }
  }
  return out
}

export function trialBuild(at: TrialAt, deps: TrialDeps): NonNullable<AskInstallAndBuildInput['tryBuild']> {
  return async (install, build) => {
    const options = { home: at.home, files: at.files }
    const envBlock = await readRecipeKey(at.project, ['env'], options).catch(() => null)
    const declared = (envBlock ?? {}) as Record<string, unknown>
    const plantAt = typeof declared['plantAt'] === 'string' ? declared['plantAt'] : DEFAULT_PLANT_AT
    const nothingDeclared = asStrings(declared['required'])?.length ? false : asStrings(declared['allow']) === undefined

    const env = await deps
      .resolveEnv({
        project: at.project,
        required: asStrings(declared['required']),
        allow: asStrings(declared['allow']),
        deny: asStrings(declared['deny']),
        patterns: productionPatterns(asStrings(declared['refuseHosts'])),
        home: at.home,
      })
      .catch((err: Error) => ({ refusal: err.message, values: {} as Record<string, string> }))
    if (env.refusal) return [{ command: 'env', ok: false, evidence: env.refusal }]

    const timeouts = await keptTimeouts(at)
    const commands: Run[] = [...(install === null ? [] : [install]), ...build].map((run) => ({
      run,
      timeout: timeouts.get(run) ?? RUN_TIMEOUT,
    }))

    const runId = deps.runId()
    const results: TrialResult[] = []
    let interrupted = false
    try {
      deps.log(`cutting a throwaway worktree at ${at.base} — the first time this clones the repository`)
      let path: string
      try {
        path = (
          await deps.provision({
            project: at.project,
            owner: at.owner,
            repo: at.repo,
            base: at.base,
            branch: 'setup-trial',
            runId,
            submodules: false,
            plantAt,
            env: env.values,
            token: at.token,
            remote: at.remote,
            home: at.home,
          })
        ).path
      } catch (err) {
        return [{ command: 'git', ok: false, evidence: boundedEvidence((err as Error).message) }]
      }

      for (const [i, command] of commands.entries()) {
        if (at.interrupt?.aborted) {
          interrupted = true
          break
        }
        const outcome = await deps.run({
          run: command.run,
          timeoutMs: parseDuration(command.timeout),
          timeoutLabel: command.timeout,
          cwd: path,
          env: runnableEnv(env.values),
          signal: at.interrupt,
        })
        if (at.interrupt?.aborted) {
          interrupted = true
          break
        }
        const ok = outcome.ok && outcome.exitCode === 0
        const note = ok || !nothingDeclared ? '' : '\n(no env declared)'
        results.push({ command: command.run, ok, evidence: `${outcome.evidence}${note}` })
        if (!ok) {
          const skipped = commands.slice(i + 1)
          if (skipped.length > 0) {
            results.push({
              command: skipped.map((s) => s.run).join('; '),
              ok: false,
              evidence: `not run because \`${command.run}\` failed`,
            })
          }
          break
        }
      }
    } finally {
      // A failed cleanup must not replace the failure it cleans up after.
      await deps.remove({ project: at.project, runId, home: at.home }).catch(() => {})
    }
    if (interrupted) throw new TrialInterrupted()
    return results
  }
}

/**
 * The live runner: Ctrl+C aborts the running command for the length of the
 * trial only, and the listener goes in the same `finally`, so the process's
 * own Ctrl+C handling is back afterwards.
 */
export function liveTrialBuild(at: Omit<TrialAt, 'interrupt'>): NonNullable<AskInstallAndBuildInput['tryBuild']> {
  return async (install, build) => {
    const controller = new AbortController()
    const onSigint = () => controller.abort()
    process.once('SIGINT', onSigint)
    try {
      return await trialBuild(
        { ...at, interrupt: controller.signal },
        liveTrialDeps((line) => console.log(line)),
      )(install, build)
    } finally {
      process.off('SIGINT', onSigint)
    }
  }
}
