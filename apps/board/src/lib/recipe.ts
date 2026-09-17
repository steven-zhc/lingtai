/**
 * The recipe the board renders from: resolved once per commit, not once per
 * render.
 *
 * **This is not a snapshot, and the distinction is the whole file.**
 * `projects.ts` reads the recipe from `origin/<base>` every time on purpose —
 * *"a snapshot in Lingtai's database would be a second source of truth"* — and
 * that rule is untouched here. What is kept is keyed on the commit the base ref
 * points at, and a commit is immutable: a hit returns exactly the bytes a
 * resolve would have fetched, and anything at all landing on the branch is a
 * miss. Nothing is stored anywhere a second reader could find it; it is one
 * process's memory of an answer it can prove is still current.
 *
 * The reason it exists is #112. The board re-renders on *every append to the
 * log* — `live.tsx` asks the router to — and each render resolved every
 * project's recipe from GitHub again, which is a round trip per repository for
 * a file that changes a few times a week. A conductor's resolve is a governance
 * act performed once per claim (0005) and stays exactly as it was; a board's is
 * the same question asked several times a second, and only the second one is
 * worth keying.
 *
 * The sha is asked for every time, deliberately: the cheap question replaces
 * the expensive one rather than removing it. A board that stopped asking would
 * be the snapshot 0005 refuses.
 */
import type { ProjectState } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { currentRecipe } from "@lingtai/conductor/projects";
import {
  RecipeInvalidError,
  RecipeMissingError,
  kindOfAction,
  resolveRecipe,
  type GateAction,
} from "@lingtai/recipe";

/**
 * `ResolvedRecipe`, named off the function that returns one.
 *
 * Inferred rather than imported, so it is always exactly what `currentRecipe`
 * returns — this file holds one and hands it back.
 */
type Resolved = Awaited<ReturnType<typeof currentRecipe>>;

/**
 * One entry per repository and base ref — the last answer, and the commit it
 * was true at.
 *
 * One rather than many because only one question is ever put to it: *is this
 * still the recipe at the head of the base branch*. A history of superseded
 * recipes would be a cache with an eviction policy to get wrong, and nothing
 * would ever read it.
 */
const lastResolved = new Map<string, { sha: string; recipe: Resolved }>();

/** Only for tests, which must not inherit another test's answer. */
export function forgetRecipes(): void {
  lastResolved.clear();
}

/**
 * The recipe at the head of the project's base branch.
 *
 * A `RecipeFor` — pass it to `projectFilter`, which otherwise resolves through
 * `currentRecipe` and should keep doing so everywhere that conducts.
 *
 * Falls through to a full resolve whenever the sha cannot be had. A ref lookup
 * that fails is not evidence that the recipe has not moved, and serving a kept
 * answer on no evidence is the failure this file is written to avoid.
 */
export async function recipeAtHead(
  state: ProjectState,
  client: GitHubClient,
): Promise<Resolved> {
  // The same ref `currentRecipe` would pick, resolved here because the sha has
  // to be keyed by it. `defaultBranch()` is the fallback for a project that
  // predates the base being recorded, and it is passed back down so the resolve
  // does not ask a second time.
  const ref = state.base ?? (await client.defaultBranch());
  const key = `${client.owner}/${client.repo}@${ref}`;

  const sha = await client.refSha(ref).catch(() => null);
  const seen = sha === null ? undefined : lastResolved.get(key);
  if (seen !== undefined && seen.sha === sha) return seen.recipe;

  const recipe = await currentRecipe(state, client, ref);
  if (sha !== null) lastResolved.set(key, { sha, recipe });
  return recipe;
}

/**
 * Which recipe the task page is showing beside an attempt, and whether it can
 * prove that is the one the attempt was given (#190).
 *
 * **"The project's recipe" is two documents on that page.** The one at the head
 * of the base branch is what the *next* run gets; `GatesResolved.configHash`
 * says which one *this* run got. A page that drew head's `build` under
 * yesterday's gates would be confidently wrong about what ran — `2d3353b` took
 * `pnpm test:db` out of `build`, and every run before it ran it. So a recipe
 * is either proved, or it is named as something else, and never shown bare.
 *
 * - `run` — its hash is the one this run recorded. `at` says where the text
 *   came from: the run's own base commit, or head's recipe that happens to hash
 *   the same (which is the same document, and so equally proved).
 * - `head` — the recipe at the head of the base branch, shown **because** this
 *   run's could not be proved, and `why` is the reason, for the page to print
 *   beside it.
 * - `none` — neither could be read, and `why` says so.
 */
export type RunRecipe =
  | {
      of: "run";
      recipe: Resolved["recipe"];
      configHash: string;
      source: string;
      at: { base: string } | { head: string };
    }
  | {
      of: "head";
      recipe: Resolved["recipe"];
      configHash: string;
      source: string;
      ref: string;
      why: string;
    }
  | { of: "none"; why: string };

/**
 * The recipe at a commit, per repository and sha — **exact, and never stale**,
 * because a commit is immutable and a run's base commit never moves.
 *
 * Unlike `lastResolved` this keeps many entries, and needs no eviction policy to
 * be right: nothing it holds can go out of date, and a board has as many of
 * them as it has distinct base commits on the pages people open. A missing or
 * invalid recipe at a sha is kept too — that is also a fact about an immutable
 * commit. A failure to *ask* (a rate limit, a 502) is not, and is asked again.
 */
const atSha = new Map<string, Resolved | { problem: string }>();

/** Only for tests, which must not inherit another test's answer. */
export function forgetRunRecipes(): void {
  atSha.clear();
}

async function recipeAtSha(
  client: GitHubClient,
  sha: string,
): Promise<Resolved | { problem: string }> {
  const key = `${client.owner}/${client.repo}@${sha}`;
  const seen = atSha.get(key);
  if (seen !== undefined) return seen;
  try {
    const resolved = await resolveRecipe((path, ref) => client.fileAt(path, ref), sha);
    atSha.set(key, resolved);
    return resolved;
  } catch (err) {
    const answer = { problem: (err as Error).message.replace(/\s*\n\s*/g, " ").trim() };
    if (err instanceof RecipeMissingError || err instanceof RecipeInvalidError) atSha.set(key, answer);
    return answer;
  }
}

/**
 * The recipe an attempt was given, proved by its hash — or head's, named.
 *
 * **The hash check comes first and the fetch sits behind it**, not the other
 * way round. A run with no `GatesResolved` has nothing to prove against, so its
 * base commit is not fetched at all; a run with one is proved against the
 * recipe at `baseSha` and, failing that, against head's — the same document
 * does not stop being the same because it was read from a later commit.
 *
 * **After [0046 §3](../../../../doc/decisions/0046-lingtai-is-personal.md)** the
 * recipe leaves the repository and there is no commit to read a past one at:
 * `recipeAtSha` goes, `atHead` becomes the file on disk, and what is left is
 * the hash — which still says *this run got a different recipe from the one
 * you have*, and the page must then say the run's text is not recoverable
 * rather than showing the local file as though it were the run's. Built this
 * way round so that removes a source and not the feature (#180).
 *
 * Never throws.
 */
export async function recipeOfRun(
  run: { baseSha: string | null; configHash: string | null },
  client: GitHubClient,
  atHead: () => Promise<Resolved>,
): Promise<RunRecipe> {
  let why: string;
  if (run.configHash === null) {
    why = "this run recorded no GatesResolved, so there is no hash to prove a recipe against";
  } else if (run.baseSha === null) {
    why = "this run recorded no base commit to read its recipe at";
  } else {
    const base = await recipeAtSha(client, run.baseSha);
    if ("problem" in base) {
      why = `the recipe at base ${run.baseSha.slice(0, 7)} could not be read: ${base.problem}`;
    } else if (base.configHash === run.configHash) {
      return {
        of: "run",
        recipe: base.recipe,
        configHash: base.configHash,
        source: base.source,
        at: { base: run.baseSha },
      };
    } else {
      why =
        `the recipe at base ${run.baseSha.slice(0, 7)} hashes to ${base.configHash.slice(0, 12)}, ` +
        `and this run was given ${run.configHash.slice(0, 12)}`;
    }
  }

  let head: Resolved;
  try {
    head = await atHead();
  } catch (err) {
    return { of: "none", why: `${why}; and the recipe at head could not be read either: ${(err as Error).message}` };
  }
  if (run.configHash !== null && head.configHash === run.configHash) {
    return {
      of: "run",
      recipe: head.recipe,
      configHash: head.configHash,
      source: head.source,
      at: { head: head.ref },
    };
  }
  return {
    of: "head",
    recipe: head.recipe,
    configHash: head.configHash,
    source: head.source,
    ref: head.ref,
    why,
  };
}

/**
 * What an action does, and what bounds it, as one line each.
 *
 * Only a command carries a clock of its own (`gatePlan` reads the same
 * `timeout`), so every other kind says what holds it instead of inventing one.
 */
export function describeAction(action: GateAction): { does: string; bound: string } {
  switch (kindOfAction(action)) {
    case "run": {
      const a = action as Extract<GateAction, { run: string }>;
      return { does: a.run, bound: `timeout ${a.timeout}` };
    }
    case "agent": {
      const a = action as Extract<GateAction, { agent: string }>;
      return { does: `a cold reviewer: ${a.agent}`, bound: "no timeout in the recipe" };
    }
    case "watch": {
      const a = action as Extract<GateAction, { watch: string[] }>;
      return { does: `watches ${a.watch.join(", ")}, then ${a.then}`, bound: "no clock — a match against the diff" };
    }
    case "human": {
      const a = action as Extract<GateAction, { human: string }>;
      return { does: `asks a person: ${a.human}`, bound: "waits on a person, with no timeout" };
    }
    case "close": {
      const a = action as Extract<GateAction, { close: true }>;
      return { does: `closes the issue when ${a.when}`, bound: "runs for effect" };
    }
    case "labels": {
      const a = action as Extract<GateAction, { labels: string[] }>;
      return { does: `sets labels ${a.labels.join(", ")} when ${a.when}`, bound: "runs for effect" };
    }
  }
}
