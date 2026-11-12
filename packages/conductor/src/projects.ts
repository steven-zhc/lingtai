import { type Runtime, everyRuntime } from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
/**
 * The registered projects, read from the log.
 *
 * There is no `projects` table: a handful of projects, each with a handful of
 * events, is a stream to reduce rather than a projection to maintain. If that ever
 * stops being true it becomes one, which costs a truncate and a replay.
 */
import { PROJECT_STREAM_PREFIX, projectStream } from '@lingtai/domain'
import type { RuntimeId } from '@lingtai/domain'
import { type ProjectState, isRegistered, reduceProject } from '@lingtai/domain'
import type { Log, LogQueries } from '@lingtai/event-store/log'
// **Type-only, and the submodules rather than the barrel** (`#157`, #221).
// Importing `@lingtai/event-store` used to construct the process-wide client as
// a side effect of the import, and `createDb()` read `postgresUrl()` eagerly —
// which threw where nothing was configured. This file is the first thing
// `lingtai status` reaches, so an eager import here was the machine with no
// Postgres losing its first command before a line of it ran. #179 made the
// store a written choice, opened at first use, so the barrel no longer builds
// anything at import; the split stays because a caller that brings its own log
// should still load no store at all.
import type { EventStore } from '@lingtai/event-store/store'
import { type LocalRecipeOptions, type ResolvedRecipe, type SignedIn, resolveLocalRecipe } from '@lingtai/recipe'
import { Effect } from 'effect'

import { asFailure } from './port-face.ts'

/** The process-wide log — whichever store this machine chose — reached only when nobody supplied one. */
const defaultLog = (): Effect.Effect<Log> =>
  Effect.promise(() => import('@lingtai/event-store')).pipe(Effect.map((m) => m.log))

/**
 * Every project stream that has ever been written to.
 *
 * Through `LogQueries` since #221 rather than a `pg.Client` of its own: this is
 * the query `lingtai status` runs first, and a raw client here is a place the
 * init-time choice does not reach (0055 §1).
 */
export function listProjectStreamsEffect(queries?: LogQueries): Effect.Effect<string[]> {
  return Effect.gen(function* () {
    const ask = queries ?? (yield* defaultLog()).queries
    return yield* Effect.promise(() => ask.projectStreams(PROJECT_STREAM_PREFIX))
  })
}

/** A store that fails is a defect (0101 §6): through the face it rejects with the driver's own error. */
export function loadProjectEffect(project: string, store?: EventStore): Effect.Effect<ProjectState | null> {
  return Effect.gen(function* () {
    const from = store ?? (yield* defaultLog()).store
    const events = yield* Effect.promise(() => from.read(projectStream(project)))
    if (events.length === 0) return null
    const state = reduceProject(events)
    return isRegistered(state) ? state : null
  })
}

/** `loadProjectEffect` as the promise every CLI verb and board page awaits (a listed face, #790). */
export function loadProject(project: string, store?: EventStore): Promise<ProjectState | null> {
  return Effect.runPromise(loadProjectEffect(project, store))
}

/**
 * Every project stream reduced, registered or not.
 *
 * The board needs both halves and must not read the log twice to get them
 * (#163); everything that conducts wants `loadProjects` below and nothing else.
 *
 * There is no `loadPendingProjects` beside it on purpose. The board's pending
 * half comes out of `splitRegister` over *this* list, and a second reader
 * nothing called would have been a test's idea of the board rather than the
 * board — one that keeps passing while the strip it is named for is broken.
 */
export function loadAllProjectsEffect(log?: Log): Effect.Effect<ProjectState[]> {
  // A log rather than a store, because this is two questions of the same log
  // and they must not be able to come from different ones: it used to take an
  // `EventStore` and then ask `listProjectStreams()` — whose default was
  // Postgres whatever store it had been handed (#221).
  return Effect.gen(function* () {
    const from = log ?? (yield* defaultLog())
    const streams = yield* Effect.promise(() => from.queries.projectStreams(PROJECT_STREAM_PREFIX))
    return yield* Effect.forEach(
      streams,
      (s) => Effect.promise(() => from.store.read(s)).pipe(Effect.map(reduceProject)),
      { concurrency: 'unbounded' },
    )
  })
}

/** `loadAllProjectsEffect` as a promise (a listed face, #790). */
export function loadAllProjects(log?: Log): Promise<ProjectState[]> {
  return Effect.runPromise(loadAllProjectsEffect(log))
}

/**
 * The projects a conductor may take work from.
 *
 * **`isRegistered` is the guard, and it predates anything it guards against.**
 * A repository that has been recorded and not yet registered — waiting for
 * `Recheck` (`ProjectOnboardingStarted`, #163, #182) — has no `configHash`, so it does not come
 * back from here — the daemon needs no new check, and `integration/projects.test.ts`
 * pins that rather than adding one.
 */
export function loadProjectsEffect(log?: Log): Effect.Effect<ProjectState[]> {
  return loadAllProjectsEffect(log).pipe(Effect.map((all) => all.filter(isRegistered)))
}

/** `loadProjectsEffect` as a promise (a listed face, #790). */
export function loadProjects(log?: Log): Promise<ProjectState[]> {
  return Effect.runPromise(loadProjectsEffect(log))
}

export function signedInIdsEffect(
  runtimes: readonly Pick<Runtime, 'capabilities' | 'checkAuth'>[],
  env: Record<string, string>,
): Effect.Effect<readonly RuntimeId[]> {
  return Effect.forEach(
    runtimes,
    (r) =>
      Effect.promise(() => Promise.resolve(r.checkAuth?.(env))).pipe(
        Effect.map((auth) => (auth?.loggedIn ? [r.capabilities.id] : [])),
      ),
    { concurrency: 'unbounded' },
  ).pipe(Effect.map((found) => found.flat()))
}

/** `signedInIdsEffect` as the promise `@lingtai/recipe`'s `SignedIn` port is (a listed face, #790). */
export function signedInIds(
  runtimes: readonly Pick<Runtime, 'capabilities' | 'checkAuth'>[],
  env: Record<string, string>,
): Promise<readonly RuntimeId[]> {
  return Effect.runPromise(signedInIdsEffect(runtimes, env))
}

/**
 * Which runtimes are signed in here, in the environment a run gets.
 *
 * **Every runtime is asked, not only the one that runs today.** Detection is
 * allowed only when exactly one is signed in (0046 §3), so a probe that could
 * only ever answer `claude-code` would pick it on a machine signed in to both
 * and record *the only runtime signed in* — a reason that is false.
 *
 * Asked only when no file names `runtime.agent`, and the answer — an empty one
 * too — is remembered for `ttlMs`. Each probe is a process, and the board
 * resolves the recipe on every render (#112): an unremembered *none* would
 * start a `claude auth status` and a `codex login status` per project per
 * append. A minute is short enough that signing in, or out, is seen on a
 * later pass without anybody restarting anything.
 */
export function signedInProbe(
  runtimes: readonly Pick<Runtime, 'capabilities' | 'checkAuth'>[],
  ttlMs = 60_000,
  now: () => number = Date.now,
): SignedIn {
  let kept: { at: number; ids: Promise<readonly RuntimeId[]> } | null = null
  return () => {
    if (kept === null || now() - kept.at >= ttlMs) {
      const env = runnableEnv({})
      const ids = signedInIds(runtimes, env)
      kept = { at: now(), ids }
    }
    return kept.ids
  }
}

/**
 * **Derived from the table, not written out** (`#313`).
 *
 * It was `[createClaudeCodeRuntime(), createCodexRuntime()]`, beside a docstring
 * promising *every* runtime — a list that would silently stop being every runtime
 * the day a third arrived, and the probe is the one place where a forgotten
 * runtime is invisible rather than broken: detection is allowed only when exactly
 * one is signed in, so a missing row makes *the only runtime signed in* a reason
 * that is false. `everyRuntime()` is `RUNTIMES`' own values.
 */
export const signedInHere: SignedIn = signedInProbe(everyRuntime())

/**
 * The recipe governing this project's next run: `~/.lingtai/<project>/recipe.yml`,
 * its `runtime.agent` included (`#372`)
 * ([0046](../../../doc/decisions-archive/0046-lingtai-is-personal.md) §3, #180).
 *
 * Read from the file every time rather than from anything stored: a snapshot
 * in Lingtai's database would be a second source of truth. No request is made
 * and nothing is read from the repository — an agent's blast radius is its
 * worktree, and this file is not in it, which is what 0005's *read from the
 * base branch* used to buy. `client` is unused and kept so every caller that
 * conducts still passes through the one `RecipeFor` shape.
 *
 * `base` becomes `ref`: the file has no branch of its own, so the branch this
 * project was registered against stands in, and `baseDivergence` still
 * compares it with the recipe's `repo.base`.
 *
 * **`StepsResolved` does store a recipe, and it is not that snapshot** (0047
 * §1). It records the recipe a run that is *over* was given, beside the hash it
 * is verified by — a record, like `baseSha`, and nothing resolves from it. What
 * this refuses is *deciding* from a copy; reading the log's copy here, or
 * anywhere in `conductor`, `recipe` or `actions`, would be exactly that, and
 * `unit/recorded-recipe.test.ts` fails if anything does.
 */
export function currentRecipeEffect(
  state: ProjectState,
  _client?: unknown,
  base?: string,
  options: Omit<LocalRecipeOptions, 'base' | 'signedIn'> & { signedIn?: SignedIn } = {},
): Effect.Effect<ResolvedRecipe, Error> {
  const project = state.project
  if (!project) return Effect.fail(new Error('no repository name recorded — re-run lingtai add'))
  // A recipe that is missing or invalid is a typed failure carrying today's message, never a defect.
  return Effect.tryPromise({
    try: () =>
      resolveLocalRecipe(project, {
        ...options,
        base: base ?? state.base ?? null,
        signedIn: options.signedIn ?? signedInHere,
      }),
    catch: asFailure,
  })
}

/** `currentRecipeEffect` as the promise the CLI and the board await (a listed face, #790). */
export function currentRecipe(
  state: ProjectState,
  client?: unknown,
  base?: string,
  options: Omit<LocalRecipeOptions, 'base' | 'signedIn'> & { signedIn?: SignedIn } = {},
): Promise<ResolvedRecipe> {
  return Effect.runPromise(currentRecipeEffect(state, client, base, options))
}
