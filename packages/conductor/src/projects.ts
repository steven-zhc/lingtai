/**
 * The registered projects, read from the log.
 *
 * There is no `projects` table: a handful of projects, each with a handful of
 * events, is a stream to fold rather than a projection to maintain. If that ever
 * stops being true it becomes one, which costs a truncate and a replay.
 */
import { PROJECT_STREAM_PREFIX, projectStream } from "@lingtai/domain";
import { type ResolvedRecipe, resolveRecipe } from "@lingtai/recipe";
import { type ProjectState, isRegistered, reduceProject } from "@lingtai/domain";
import { databaseUrl } from "@lingtai/env";
import type { GitHubClient } from "@lingtai/github";
import { type EventStore, eventStore } from "@lingtai/event-store";
import pg from "pg";

/** Every project stream that has ever been written to. */
export async function listProjectStreams(url = databaseUrl()): Promise<string[]> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await client.query<{ stream_id: string }>(
      "select distinct stream_id from events where stream_id like $1 order by stream_id",
      [`${PROJECT_STREAM_PREFIX}%`],
    );
    return r.rows.map((x) => x.stream_id);
  } finally {
    await client.end();
  }
}

export async function loadProject(
  project: string,
  store: EventStore = eventStore,
): Promise<ProjectState | null> {
  const events = await store.read(projectStream(project));
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
export async function loadAllProjects(store: EventStore = eventStore): Promise<ProjectState[]> {
  const streams = await listProjectStreams();
  return Promise.all(streams.map((s) => store.read(s).then(reduceProject)));
}

/**
 * The projects a conductor may take work from.
 *
 * **`isRegistered` is the guard, and it predates anything it guards against.**
 * A repository that has been recorded and whose recipe has not landed yet
 * (`ProjectOnboardingStarted`, #163) has no `configHash`, so it does not come
 * back from here — the daemon needs no new check, and `test/projects.test.ts`
 * pins that rather than adding one.
 */
export async function loadProjects(store: EventStore = eventStore): Promise<ProjectState[]> {
  return (await loadAllProjects(store)).filter(isRegistered);
}


/**
 * The recipe governing this project's next run.
 *
 * Read from `origin/<base>` every time rather than from anything stored: a
 * snapshot in Lingtai's database would be a second source of truth, and the
 * repository's copy is the one its own commits change.
 *
 * **`GatesResolved` does store a recipe, and it is not that snapshot** (0047
 * §1). It records the recipe a run that is *over* was given, beside the hash it
 * is verified by — a record, like `baseSha`, and nothing resolves from it. What
 * this refuses is *deciding* from a copy; reading the log's copy here, or
 * anywhere in `conductor`, `recipe` or `actions`, would be exactly that, and
 * `pure/recorded-recipe.test.ts` fails if anything does.
 */
export async function currentRecipe(
  state: ProjectState,
  client: GitHubClient,
  base?: string,
): Promise<ResolvedRecipe> {
  // Recorded base first; GitHub's default branch only when a project predates
  // it being recorded.
  const ref = base ?? state.base ?? (await client.defaultBranch());
  return resolveRecipe((path, r) => client.fileAt(path, r), ref);
}
