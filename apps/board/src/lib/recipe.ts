/**
 * The recipe the board renders from, and the one a run was given.
 *
 * There was a cache here, keyed on the commit `origin/<base>` pointed at, so a
 * board re-rendering on every append (#112) did not fetch the recipe from
 * GitHub for every render. Since #180 the recipe is this machine's file
 * (0046 §3) and `currentRecipe` makes no request, so the board calls it like
 * everything else and there is nothing left to key.
 *
 * A run's *own* recipe is still read at its base commit below: a run recorded
 * before the move was given the repository's copy, and that commit is where it
 * still is.
 */
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
 * **Since [0046 §3](../../../../doc/decisions/0046-lingtai-is-personal.md)
 * (#180)** `atHead` is this machine's file, and a run is given that file — not
 * anything in the repository. `recipeAtSha` still reads `.lingtai/config.yaml`
 * at the run's base commit, and that is only ever a *candidate*: for a run
 * recorded before the move it is the document the run was given, and for one
 * after it a leftover copy that no run obeys. The hash is what decides between
 * them, never where the text was found — a stale copy that happens to hash the
 * same *is* the same document, and one that does not is passed over for the
 * machine's file, proved the same way, or named as `head` with the reason. So
 * whether a leftover copy exists changes which bytes are shown, never whether
 * the page claims they are the run's.
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
