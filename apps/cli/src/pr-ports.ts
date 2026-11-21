/**
 * The daemon's ports for serving a PR (0130 §5): the log, the project's recipe, the tickets that may be in the draft,
 * and the project's mirror — fetched, and asked about by exit code.
 *
 * Every IO is an `Effect` (0101 §6). `packages/conductor/src/pr.ts` is the serve; this is only what it is handed.
 */
import type { PrPorts } from '@lingtai/conductor'
import { currentRecipeEffect } from '@lingtai/conductor/projects'
import { githubClientAuth } from '@lingtai/env'
import type { EventStore } from '@lingtai/event-store/store'
import { createGitHubClient, makeGitHub } from '@lingtai/github'
import { loadProjectsEffect, readProjectStateEffect } from '@lingtai/project'
import { readSpendEffect, readTasksEffect } from '@lingtai/projector'
import { remoteOf } from '@lingtai/recipe'
import { RepoFailed, ensureMirrorEffect, gitEffect, mirrorPathFor } from '@lingtai/repo'
import { Effect } from 'effect'

/** A window that covers every landed row: the board's two-day default would lose a ticket landed last week. */
const EVERY_LANDED_ROW_DAYS = 36_500

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
      const client = yield* Effect.tryPromise({
        try: () => createGitHubClient({ auth: githubClientAuth(), ...slug }),
        catch: asError,
      })
      return () => client.token()
    })
  const answered = (run: Effect.Effect<string, RepoFailed>) =>
    run.pipe(
      Effect.map((stdout) => ({ code: 0, stdout })),
      Effect.catch((err: RepoFailed) =>
        typeof err.exitCode === 'number'
          ? Effect.succeed({ code: err.exitCode, stdout: err.stdout ?? '' })
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
        return yield* answered(gitEffect([...args], { cwd: mirrorPathFor(project), token }))
      }),
    github: githubOf,
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
