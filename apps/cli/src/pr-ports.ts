import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The daemon's ports for serving a PR (0130 §5): the log, the project's recipe, the tickets that may be in the draft,
 * and the project's mirror — fetched, and asked about by exit code.
 *
 * Every IO is an `Effect` (0101 §6). `packages/conductor/src/pr.ts` is the serve; this is only what it is handed.
 */
import type { RunSandbox } from '@lingtai/agent'
import { NO_RUN_LOG, createRuntime, runtimeVersionOfEffect, writeUnhookedSettingsEffect } from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
import {
  type ConflictResolver,
  type PrPorts,
  buildAt,
  claudeConfigDirFor,
  decidePassSandbox,
  runtimesOf,
} from '@lingtai/conductor'
import { ciProviderFor } from '@lingtai/conductor/ci-providers'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { currentRecipeEffect } from '@lingtai/conductor/projects'
import { ticketStream } from '@lingtai/domain'
import { githubClientAuth, stateDir } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import { createGitHubClient, makeGitHub } from '@lingtai/github'
import { loadProjectsEffect, readProjectStateEffect } from '@lingtai/project'
import { readSpendEffect, readTasksEffect } from '@lingtai/projector'
import { EVERY_LANDED_ROW_DAYS } from '@lingtai/projector/task-view'
import { invocationDecision, remoteOf } from '@lingtai/recipe'
import {
  RepoFailed,
  retryUnreachable,
  checkedOutAt,
  ensureMirrorEffect,
  gitEffect,
  isLocalRemote,
  mergeInWorktree,
  mirrorPathFor,
  standMergeUp,
  standCommitUp,
  sweepPrWorktrees,
} from '@lingtai/repo'
import { standInExcludes } from '@lingtai/sandbox'
import { Effect } from 'effect'

import { processSandbox } from './sandbox.ts'
import { tracedPorts } from './tracing.ts'

/** How long the installation token may take: a read inside a write the drain waits for. */
const TOKEN_MS = 60_000

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/**
 * `locked` is the daemon's guard as a function (`lockedEffect`): the sentence for a lock that stops new work on a project,
 * or null. **Without it no agent is given a PR's conflict** — a round that could not be stopped by a pause, the day's
 * ceiling or an account limit would be new work outside every lock (0126 §6), so the person is asked as before.
 */
export function livePrPorts(
  store: EventStore,
  log: (line: string) => void,
  locked?: (project: string) => Effect.Effect<string | null>,
): PrPorts {
  const recipeOf = (project: string) =>
    readProjectStateEffect(project, store).pipe(
      Effect.flatMap((state) => currentRecipeEffect(state)),
      Effect.map((resolved) => resolved.recipe),
      Effect.mapError(asError),
    )
  /** The project's GitHub owner and repo; null where it has none on record (a local remote). */
  const slugOf = (project: string) =>
    readProjectStateEffect(project, store).pipe(
      Effect.map((state) =>
        state.owner === null || state.project === null ? null : { owner: state.owner, repo: state.project },
      ),
      Effect.mapError(asError),
    )
  const githubOf = (project: string) =>
    Effect.gen(function* () {
      const slug = yield* slugOf(project)
      if (slug === null) return yield* Effect.fail(new Error(`${project} has no GitHub owner on record`))
      return yield* makeGitHub({ auth: githubClientAuth(), ...slug }).pipe(Effect.mapError(asError))
    })
  /** A token source for git: the installation's, or none where the project has no owner (`git` plants nothing). */
  const tokenOf = (project: string) =>
    Effect.gen(function* () {
      const slug = yield* slugOf(project)
      if (slug === null) return undefined
      // Building the client and asking for its token are requests: bounded, so a stalled one cannot hold a push the
      // drain waits for. The token is resolved here (an installation's lasts an hour), never inside `git`.
      return yield* Effect.gen(function* () {
        const client = yield* Effect.tryPromise({
          try: () => createGitHubClient({ auth: githubClientAuth(), ...slug }),
          catch: asError,
        })
        return yield* Effect.tryPromise({ try: () => client.token(), catch: asError })
      }).pipe(
        Effect.timeoutOrElse({
          duration: TOKEN_MS,
          orElse: () => Effect.fail(new Error(`the installation token did not arrive in ${TOKEN_MS}ms`)),
        }),
      )
    })
  const answered = (run: Effect.Effect<string, RepoFailed>) =>
    run.pipe(
      Effect.map((stdout) => ({ code: 0, stdout, stderr: '' })),
      Effect.catch((err: RepoFailed) =>
        typeof err.exitCode === 'number'
          ? Effect.succeed({ code: err.exitCode, stdout: err.stdout ?? '', stderr: err.stderr ?? '' })
          : Effect.fail(asError(err)),
      ),
    )
  const resolver: ConflictResolver | undefined =
    locked === undefined
      ? undefined
      : {
          standMerge: (project, options) => standMergeUp({ project, ...options }),
          standCommit: (project, options) => standCommitUp({ project, ...options }),
          gitIn: (cwd, args) => answered(gitEffect([...args], { cwd })),
          // Unhooked, as the cold reviewer is: the hook's events belong to a pass's stream and a PR's has none. The run is
          // bounded by the runtime's own flags — turns, wall and dollars — and by nothing of the hook's.
          dispatch: (project, request) =>
            Effect.gen(function* () {
              const runtime = createRuntime(request.runtime)
              const settingsPath = yield* writeUnhookedSettingsEffect(request.runId, 'pr', stateDir(), false).pipe(
                Effect.mapError(asError),
              )
              // **The recipe's own sandbox decision, as a pass makes it** (0127): sandboxed where the host can, refused by name
              // where it must and cannot, and unwrapped where the recipe turned it off or the runtime cannot be wrapped.
              const recipe = yield* recipeOf(project)
              const pass = yield* decidePassSandbox(recipe.sandbox, processSandbox)
              const decision = invocationDecision(pass.decision, request.runtime)
              const home = stateDir()
              const service = pass.service
              const sandbox: RunSandbox | undefined =
                decision.kind === 'unsandboxed'
                  ? undefined
                  : {
                      decision:
                        decision.kind === 'sandboxed'
                          ? { kind: 'sandboxed', project_additions: decision.project_additions }
                          : { kind: 'refused', why: decision.why },
                      project,
                      mirror: mirrorPathFor(project, home),
                      cache: join(home, 'cache', project),
                      worktree: request.cwd,
                      runDir: claudeConfigDirFor(home, request.runId),
                      operatorClaudeDir: join(homedir(), '.claude'),
                      hostHome: homedir(),
                      codexNamed: runtimesOf(recipe).includes('codex'),
                      read: [],
                      wrap: (input) =>
                        service === undefined
                          ? Effect.fail({ message: 'no sandbox service in this process' })
                          : service.wrap(input).pipe(Effect.mapError((e) => ({ message: String(e) }))),
                    }
              const outcome = yield* runtime.run({
                ...(sandbox === undefined ? {} : { sandbox }),
                runId: request.runId,
                cwd: request.cwd,
                prompt: request.prompt,
                ...(request.model === undefined ? {} : { model: request.model }),
                settingsPath,
                env: runnableEnv({}),
                limits: request.limits,
                log: NO_RUN_LOG,
                traceTools: true,
              })
              return {
                turns: outcome.turns,
                durationMs: outcome.durationMs,
                costUsd: outcome.costUsd,
                ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
                text: outcome.text ?? null,
                failure: outcome.failure ?? null,
              }
            }),
          runtimeVersion: (_project, runtime) =>
            runtimeVersionOfEffect(createRuntime(runtime), runnableEnv({})).pipe(Effect.orElseSucceed(() => null)),
          // The body **as claimed**, off the ticket's own stream: the issue on GitHub may have been edited since the work landed,
          // and the agents are told what the code that conflicts was written to mean.
          ticketBody: (project, ticket) =>
            Effect.tryPromise({ try: () => store.read(ticketStream(project, ticket)), catch: asError }).pipe(
              Effect.flatMap((events) => {
                const claimed = events
                  .filter((e) => e.type === 'TicketClaimed' || e.type === 'TicketContinued')
                  .map((e) => (e.data as { body?: string }).body)
                  .filter((body): body is string => body !== undefined)
                const body = claimed.at(-1)
                return body === undefined
                  ? Effect.fail(new Error(`no body was recorded when #${ticket} was claimed`))
                  : Effect.succeed(body)
              }),
            ),
          locked,
        }
  return {
    store,
    log,
    ...(resolver === undefined ? {} : { resolver }),
    recipe: recipeOf,
    candidates: (project) =>
      readTasksEffect({ project, retentionDays: EVERY_LANDED_ROW_DAYS }).pipe(
        Effect.map((cards) => cards.map((card) => ({ issue: card.issue }))),
        Effect.mapError(asError),
      ),
    fetch: (project) =>
      Effect.gen(function* () {
        const recipe = yield* recipeOf(project)
        const remote = remoteOf(recipe) ?? undefined
        const slug = yield* slugOf(project)
        if (slug === null && remote === undefined) {
          return yield* Effect.fail(new Error(`${project} has no GitHub owner on record: the mirror cannot be fetched`))
        }
        const token = yield* tokenOf(project)
        // srt's stand-in names, so `git add -A` works in a sandboxed conflict round (#1152): the exclude lives in the mirror's
        // `info/exclude`, which every worktree of it shares, and is written on each fetch — so a sandbox enabled later is covered.
        const decided = yield* decidePassSandbox(recipe.sandbox, processSandbox).pipe(Effect.orElseSucceed(() => null))
        const sandboxed = decided !== null && invocationDecision(decided.decision, 'claude-code').kind === 'sandboxed'
        yield* ensureMirrorEffect({
          project,
          owner: slug?.owner ?? '',
          repo: slug?.repo ?? project,
          remote,
          token,
          ...(sandboxed ? { exclude: standInExcludes } : {}),
        }).pipe(Effect.mapError(asError), Effect.asVoid)
      }),
    git: (project, args) => answered(gitEffect([...args], { cwd: mirrorPathFor(project) })),
    remote: (project, args) =>
      Effect.gen(function* () {
        const token = yield* tokenOf(project)
        const run = gitEffect([...args], { cwd: mirrorPathFor(project), token })
        // A fetch that could not reach origin is tried again, as the lane's is; a push is never retried blind.
        return yield* answered(args[0] === 'fetch' ? retryUnreachable(run) : run)
      }),
    github: githubOf,
    // The CI provider the recipe names, over this project's GitHub and mirror (#1339).
    ci: (project, github) =>
      Effect.gen(function* () {
        const recipe = yield* recipeOf(project)
        return ciProviderFor(recipe, {
          github,
          git: (args) => answered(gitEffect([...args], { cwd: mirrorPathFor(project) })),
        })
      }),
    merge: (project, options) => mergeInWorktree({ project, ...options }),
    sweep: (project) => sweepPrWorktrees({ project }),
    build: (project, options) =>
      Effect.gen(function* () {
        const recipe = yield* recipeOf(project)
        const token = yield* tokenOf(project)
        return yield* buildAt({
          store,
          log,
          home: stateDir(),
          project,
          recipe,
          sha: options.sha,
          base: options.base,
          checkId: options.checkId,
          sandbox: processSandbox,
          token,
        }).pipe(Effect.provide(tracedPorts))
      }),
    checkedOut: (project, branch) =>
      Effect.gen(function* () {
        const remote = remoteOf(yield* recipeOf(project))
        if (remote === null || !isLocalRemote(remote)) return null
        const listed = yield* gitEffect(['worktree', 'list', '--porcelain'], { cwd: remote }).pipe(
          Effect.mapError(asError),
        )
        const found = checkedOutAt(listed, branch)
        if (found === 'unreadable') return yield* Effect.fail(new Error(`could not read the worktrees of ${remote}`))
        return found === null ? null : found.dir
      }),
    // The project's own channel, never the raw GitHub client: a `db` project's ticket numbers are not issues there.
    tickets: (project) =>
      Effect.gen(function* () {
        const state = yield* readProjectStateEffect(project, store).pipe(Effect.mapError(asError))
        if (state.owner === null) {
          const recipe = (yield* currentRecipeEffect(state)).recipe
          return (yield* ownerlessClientEffect(state, recipe)).client
        }
        return (yield* projectClientEffect(state)).client
      }).pipe(Effect.mapError(asError)),
    facts: (project, tickets) =>
      Effect.gen(function* () {
        const github = yield* githubOf(project).pipe(Effect.orElseSucceed(() => null))
        return yield* Effect.forEach(tickets, (ticket) =>
          Effect.gen(function* () {
            const open =
              github === null || !/^\d+$/.test(ticket)
                ? null
                : yield* github.getIssue(Number(ticket)).pipe(
                    Effect.map((issue) => issue.state === 'open'),
                    Effect.orElseSucceed(() => null),
                  )
            const rows = yield* readSpendEffect({ project, ticket }).pipe(Effect.orElseSucceed(() => null))
            const spend =
              rows === null || rows.length === 0 || rows.some((r) => r.costUsd === null)
                ? null
                : rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
            return { ticket, open, spend }
          }),
        )
      }),
    projects: () =>
      loadProjectsEffect().pipe(
        Effect.map((projects) => projects.flatMap((p) => (p.project === null ? [] : [p.project]))),
        Effect.mapError(asError),
      ),
  }
}
