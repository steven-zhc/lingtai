/**
 * The daemon's ports for serving a PR (0130 §5): the log, the project's recipe, the tickets that may be in the draft,
 * and the project's mirror — fetched, and asked about by exit code.
 *
 * Every IO is an `Effect` (0101 §6). `packages/conductor/src/pr.ts` is the serve; this is only what it is handed.
 */
import { currentRecipeEffect } from '@lingtai/conductor/projects'
import type { PrPorts } from '@lingtai/conductor'
import { githubClientAuth } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import { createGitHubClient } from '@lingtai/github'
import { loadProjectsEffect, readProjectStateEffect } from '@lingtai/project'
import { readTasksEffect } from '@lingtai/projector'
import { RepoFailed, ensureMirrorEffect, gitEffect, mirrorPathFor } from '@lingtai/repo'
import { Effect } from 'effect'

/** A window that covers every landed row: the board's two-day default would lose a ticket landed last week. */
const EVERY_LANDED_ROW_DAYS = 36_500

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

export function livePrPorts(store: EventStore, log: (line: string) => void): PrPorts {
  return {
    store,
    log,
    recipe: (project) =>
      readProjectStateEffect(project, store).pipe(
        Effect.flatMap((state) => currentRecipeEffect(state)),
        Effect.map((resolved) => resolved.recipe),
        Effect.mapError(asError),
      ),
    candidates: (project) =>
      readTasksEffect({ project, retentionDays: EVERY_LANDED_ROW_DAYS }).pipe(
        Effect.map((cards) => cards.map((card) => ({ issue: card.issue }))),
        Effect.mapError(asError),
      ),
    fetch: (project) =>
      Effect.gen(function* () {
        const state = yield* readProjectStateEffect(project, store)
        if (state.owner === null || state.project === null) {
          return yield* Effect.fail(new Error(`${project} has no GitHub owner on record: the mirror cannot be fetched`))
        }
        const owner = state.owner
        const repo = state.project
        const client = yield* Effect.tryPromise({
          try: () => createGitHubClient({ auth: githubClientAuth(), owner, repo }),
          catch: asError,
        })
        yield* ensureMirrorEffect({ project, owner, repo, token: () => client.token() }).pipe(
          Effect.mapError(asError),
          Effect.asVoid,
        )
      }),
    git: (project, args) =>
      gitEffect([...args], { cwd: mirrorPathFor(project) }).pipe(
        Effect.map((stdout) => ({ code: 0, stdout })),
        Effect.catch((err: RepoFailed) =>
          typeof err.exitCode === 'number'
            ? Effect.succeed({ code: err.exitCode, stdout: err.stdout ?? '' })
            : Effect.fail(asError(err)),
        ),
      ),
    projects: () =>
      loadProjectsEffect().pipe(
        Effect.map((projects) => projects.flatMap((p) => (p.project === null ? [] : [p.project]))),
        Effect.mapError(asError),
      ),
  }
}
