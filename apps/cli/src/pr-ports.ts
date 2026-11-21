/**
 * The daemon's ports for serving a PR (0130 §5): the log, the project's recipe, the tickets that may be in the draft,
 * and the project's mirror — fetched, and asked about by exit code.
 *
 * Every IO is an `Effect` (0101 §6). `packages/conductor/src/pr.ts` is the serve; this is only what it is handed.
 */
import { type PrPorts, buildAt } from '@lingtai/conductor'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { currentRecipeEffect } from '@lingtai/conductor/projects'
import { githubClientAuth, stateDir } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import { createGitHubClient, makeGitHub } from '@lingtai/github'
import { loadProjectsEffect, readProjectStateEffect } from '@lingtai/project'
import { readSpendEffect, readTasksEffect } from '@lingtai/projector'
import { EVERY_LANDED_ROW_DAYS } from '@lingtai/projector/task-view'
import { remoteOf } from '@lingtai/recipe'
import {
  RepoFailed,
  retryUnreachable,
  checkedOutAt,
  ensureMirrorEffect,
  gitEffect,
  isLocalRemote,
  mergeInWorktree,
  mirrorPathFor,
  sweepPrWorktrees,
} from '@lingtai/repo'
import { Effect } from 'effect'

import { processSandbox } from './sandbox.ts'
import { tracedPorts } from './tracing.ts'

/** How long the installation token may take: a read inside a write the drain waits for. */
const TOKEN_MS = 60_000

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function livePrPorts(store: EventStore, log: (line: string) => void): PrPorts {
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
  return {
    store,
    log,
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
        yield* ensureMirrorEffect({
          project,
          owner: slug?.owner ?? '',
          repo: slug?.repo ?? project,
          remote,
          token,
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
