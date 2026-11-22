/**
 * The recipe's `build` at one commit, outside any attempt (#1312): what a PR's `build` step and its merge back ask.
 *
 * One `baseCheckQuestion` per `run:` action at `build`, in order, stopping at the first red — the question a pass
 * asks of its base, built one way, under the pass's own sandbox decision. It never throws: a recipe whose environment
 * is refused, a sandbox the host cannot provide, or a check that could not run is `unknown`, which is never green.
 * A recipe with no `run:` at `build` passes on the merge alone, as a pass does when `build` declares nothing.
 */
import { productionPatterns } from '@lingtai/agent-env'
import type { EventStore } from '@lingtai/event-store/store'
import type { Recipe } from '@lingtai/recipe'
import type { TokenSource } from '@lingtai/repo'
import { Effect, Result } from 'effect'

import { baseCheckFor, baseCheckQuestion } from './base-check.ts'
import { buildRunsOf } from './base-red.ts'
import { AgentHost, Repo } from './ports.ts'
import type { PrBuildAnswer } from './pr.ts'
import { type SandboxService, decidePassSandbox } from './sandbox-decision.ts'

export interface BuildAtOptions {
  readonly store: EventStore
  readonly log: (line: string) => void
  readonly home: string
  readonly project: string
  readonly recipe: Recipe
  readonly sha: string
  /** Where the answers are recorded (`int-{project}-{base}`): the PR branch, never `branch.personal` (see `PrPorts.build`). */
  readonly base: string
  readonly checkId: string
  readonly sandbox: SandboxService | undefined
  readonly token: TokenSource | undefined
}

export const buildAt = (options: BuildAtOptions): Effect.Effect<PrBuildAnswer, never, Repo | AgentHost> =>
  Effect.gen(function* () {
    const { recipe, project, home } = options
    const runs = buildRunsOf(recipe)
    if (runs.length === 0) return { kind: 'green' } as PrBuildAnswer

    const passSandbox = yield* decidePassSandbox(recipe.sandbox, options.sandbox)
    const host = yield* AgentHost
    const asked = yield* Effect.result(
      host.resolveEnv({
        project,
        required: recipe.env.required,
        allow: recipe.env.allow,
        deny: recipe.env.deny,
        patterns: productionPatterns(recipe.env.refuseHosts),
        home,
      }),
    )
    if (Result.isFailure(asked)) return { kind: 'unknown', why: asked.failure.detail } as PrBuildAnswer
    const env = asked.success
    if (env.refusal) return { kind: 'unknown', why: env.refusal } as PrBuildAnswer

    const abort = new AbortController()
    return yield* Effect.gen(function* () {
      for (const run of runs) {
        const built = yield* baseCheckQuestion({
          project,
          base: options.base,
          baseSha: options.sha,
          recipe,
          action: run.name,
          env,
          home,
          sandbox: passSandbox,
          checkId: options.checkId,
          signal: abort.signal,
          token: options.token,
          gitEnv: undefined,
        })
        if ('notBuilt' in built) return { kind: 'unknown', why: built.notBuilt } as PrBuildAnswer
        const answer = yield* baseCheckFor(options.store, options.log, home).ask(built.question)
        if (answer.verdict === 'red') {
          return { kind: 'red', command: built.question.command, evidence: answer.evidence } as PrBuildAnswer
        }
        if (answer.verdict === 'unknown') return { kind: 'unknown', why: answer.why } as PrBuildAnswer
      }
      return { kind: 'green' } as PrBuildAnswer
    }).pipe(Effect.ensuring(Effect.sync(() => abort.abort())))
  })
