/**
 * The registered projects, read from the log.
 *
 * There is no `projects` table: a handful of projects, each with a handful of
 * events, is a stream to fold rather than a projection to maintain. If that ever
 * stops being true it becomes one, which costs a truncate and a replay.
 */
import { PROJECT_STREAM_PREFIX, projectStream } from "@lingtai/domain";
import {
  type LocalRecipeOptions,
  type ResolvedRecipe,
  type SignedIn,
  resolveLocalRecipe,
} from "@lingtai/recipe";
import { type Runtime, createClaudeCodeRuntime, createCodexRuntime } from "@lingtai/agent";
import { runnableEnv } from "@lingtai/agent-env";
import type { RuntimeId } from "@lingtai/domain";
import { type ProjectState, isRegistered, reduceProject } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
// **Type-only, and the submodules rather than the barrel** (`#157`, #221).
// Importing `@lingtai/event-store` used to construct the process-wide client as
// a side effect of the import, and `createDb()` read `postgresUrl()` eagerly —
// which threw where nothing was configured. This file is the first thing
// `lingtai status` reaches, so an eager import here was the machine with no
// Postgres losing its first command before a line of it ran. #179 made the
// store a written choice, opened at first use, so the barrel no longer builds
// anything at import; the split stays because a caller that brings its own log
// should still load no store at all.
import type { EventStore } from "@lingtai/event-store/store";
import type { Log, LogQueries } from "@lingtai/event-store/log";

/** The process-wide log — whichever store this machine chose — reached only when nobody supplied one. */
async function defaultLog(): Promise<Log> {
  return (await import("@lingtai/event-store")).log;
}

/**
 * Every project stream that has ever been written to.
 *
 * Through `LogQueries` since #221 rather than a `pg.Client` of its own: this is
 * the query `lingtai status` runs first, and a raw client here is a place the
 * init-time choice does not reach (0055 §1).
 */
export async function listProjectStreams(queries?: LogQueries): Promise<string[]> {
  const ask = queries ?? (await defaultLog()).queries;
  return ask.projectStreams(PROJECT_STREAM_PREFIX);
}

export async function loadProject(
  project: string,
  store?: EventStore,
): Promise<ProjectState | null> {
  const from = store ?? (await defaultLog()).store;
  const events = await from.read(projectStream(project));
  if (events.length === 0) return null;
  const state = reduceProject(events);
  return isRegistered(state) ? state : null;
}

/**
 * Every project stream folded, registered or not.
 *
 * The board needs both halves and must not read the log twice to get them
 * (#163); everything that conducts wants `loadProjects` below and nothing else.
 *
 * There is no `loadPendingProjects` beside it on purpose. The board's pending
 * half comes out of `splitRegister` over *this* list, and a second reader
 * nothing called would have been a test's idea of the board rather than the
 * board — one that keeps passing while the strip it is named for is broken.
 */
export async function loadAllProjects(log?: Log): Promise<ProjectState[]> {
  // A log rather than a store, because this is two questions of the same log
  // and they must not be able to come from different ones: it used to take an
  // `EventStore` and then ask `listProjectStreams()` — whose default was
  // Postgres whatever store it had been handed (#221).
  const from = log ?? (await defaultLog());
  const streams = await from.queries.projectStreams(PROJECT_STREAM_PREFIX);
  return Promise.all(streams.map((s) => from.store.read(s).then(reduceProject)));
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
export async function loadProjects(log?: Log): Promise<ProjectState[]> {
  return (await loadAllProjects(log)).filter(isRegistered);
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
  runtimes: readonly Pick<Runtime, "capabilities" | "checkAuth">[],
  ttlMs = 60_000,
  now: () => number = Date.now,
): SignedIn {
  let kept: { at: number; ids: Promise<readonly RuntimeId[]> } | null = null;
  return () => {
    if (kept === null || now() - kept.at >= ttlMs) {
      const env = runnableEnv({});
      const ids = Promise.all(
        runtimes.map(async (r) => ((await r.checkAuth?.(env))?.loggedIn ? [r.capabilities.id] : [])),
      ).then((found) => found.flat());
      kept = { at: now(), ids };
    }
    return kept.ids;
  };
}

export const signedInHere: SignedIn = signedInProbe([createClaudeCodeRuntime(), createCodexRuntime()]);

/**
 * The recipe governing this project's next run: `~/.lingtai/<project>/recipe.yml`,
 * with `runtime.agent` and `runtime.limits` from `~/.lingtai/config.yml`
 * ([0046](../../../doc/decisions/0046-lingtai-is-personal.md) §3, #180).
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
 * **`GatesResolved` does store a recipe, and it is not that snapshot** (0047
 * §1). It records the recipe a run that is *over* was given, beside the hash it
 * is verified by — a record, like `baseSha`, and nothing resolves from it. What
 * this refuses is *deciding* from a copy; reading the log's copy here, or
 * anywhere in `conductor`, `recipe` or `actions`, would be exactly that, and
 * `unit/recorded-recipe.test.ts` fails if anything does.
 */
export async function currentRecipe(
  state: ProjectState,
  _client?: GitHubClient,
  base?: string,
  options: Omit<LocalRecipeOptions, "base" | "signedIn"> & { signedIn?: SignedIn } = {},
): Promise<ResolvedRecipe> {
  if (!state.project) throw new Error("no repository name recorded — re-run lingtai add");
  return resolveLocalRecipe(state.project, {
    ...options,
    base: base ?? state.base ?? null,
    signedIn: options.signedIn ?? signedInHere,
  });
}
