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
import { GATE_POINTS } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { currentRecipe } from "@lingtai/conductor/projects";
import { passCeiling } from "@lingtai/conductor/ceiling";
import { describeAssignee } from "@lingtai/conductor/filter";
import {
  RecipeInvalidError,
  RecipeMissingError,
  kindOfAction,
  parseDuration,
  resolveRecipe,
  type GateAction,
  type Recipe,
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
      /**
       * How this recipe stands against the one at head (#217).
       *
       * On the `run` variant only, because it is the only one where the
       * question means anything: a `head` recipe *is* head's, and a `none` has
       * nothing to compare.
       */
      from: FromHead;
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
 * One value this attempt was given that the recipe at head does not have (#217).
 *
 * Both sides are strings because both sides are shown: `null` is *not set at
 * all*, which is a different fact from a value that changed and reads
 * differently on the page.
 */
export interface Change {
  /** Its path in the recipe, keyed by name where a list has names — `gates.proposed.build.run`. */
  path: string;
  run: string | null;
  head: string | null;
}

/**
 * What differs between the recipe this attempt got and the one at head.
 *
 * **`same` is an answer and not an absence**, which is the whole of why this is
 * a value rather than a list that happens to be empty (#217). Most of the time
 * nothing differs, and *nothing differs* is the useful reading: this attempt
 * ran under what you have now. A page that printed a list and showed nothing
 * when it was empty would say the same thing as a page that never looked.
 *
 * `unknown` is the third: head could not be read, so the comparison was not
 * made, and that is not the same as there being nothing in it.
 */
export type FromHead =
  | { of: "same"; ref: string }
  | { of: "changed"; ref: string; changes: readonly Change[] }
  | { of: "unknown"; why: string };

/** A leaf of the recipe as a person reads it. `null` is a value; `undefined` canonical drops. */
function say(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/**
 * The recipe flattened to `path → value`, which is what makes two of them
 * comparable.
 *
 * **A list of named things is keyed by its names, never by position.** An
 * action inserted at the top of `proposed` would otherwise read as every action
 * on that point having changed, and the one that was actually added would be
 * the one row that looked unremarkable.
 *
 * An empty list is a value (`(nothing)`) rather than an absence, for the reason
 * a `skipped` gate point is drawn: a point whose actions were all removed is a
 * change, and a path that merely stops existing does not read as one.
 */
function flatten(value: unknown, at: string, into: Map<string, string>): void {
  // `undefined` never reaches a reader: `canonical` drops it before the hash is
  // taken (0047 §2), so a path that is undefined here is a path the recipe the
  // run was decided by does not have.
  if (value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length === 0) into.set(at, "(nothing)");
    else if (value.every((v) => typeof (v as { name?: unknown })?.name === "string"))
      for (const item of value) flatten(item, `${at}.${(item as { name: string }).name}`, into);
    else into.set(at, value.map(say).join(", "));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) flatten(v, at === "" ? key : `${at}.${key}`, into);
    return;
  }
  into.set(at, say(value));
}

/** Every path the two recipes disagree on, in the recipe's own order of keys. */
export function changesFromHead(mine: Recipe, head: Recipe): Change[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  flatten(mine, "", a);
  flatten(head, "", b);
  return [...new Set([...a.keys(), ...b.keys()])]
    .sort()
    .filter((path) => a.get(path) !== b.get(path))
    .map((path) => ({ path, run: a.get(path) ?? null, head: b.get(path) ?? null }));
}

/**
 * This run's recipe against head's — **by hash first, and the diff only after
 * it says there is one**.
 *
 * Two documents with one hash are one document (0047 §2), so `same` is settled
 * by twelve characters rather than by walking two objects and finding nothing.
 *
 * Never throws, and a head that cannot be read costs the comparison and not the
 * recipe: an attempt whose own recipe is proved still shows it, and says the
 * comparison was not made rather than that nothing differs.
 */
async function fromHead(mine: Resolved, atHead: () => Promise<Resolved>): Promise<FromHead> {
  let head: Resolved;
  try {
    head = await atHead();
  } catch (err) {
    return { of: "unknown", why: (err as Error).message.replace(/\s*\n\s*/g, " ").trim() };
  }
  if (head.configHash === mine.configHash) return { of: "same", ref: head.ref };
  return { of: "changed", ref: head.ref, changes: changesFromHead(mine.recipe, head.recipe) };
}

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
        // **Head is read even here, where nothing needs it to prove anything.**
        // It used not to be, and that was right while the only question was
        // *what did `proposed:build` do*. The other question — *what was this
        // attempt run under* — is answered by the difference, and the answer is
        // usually `same`: this attempt ran under what you have now (#217). It
        // costs no request; since 0046 §3 head is this machine's file, and the
        // caller reads it once however many attempts the page has.
        from: await fromHead(base, atHead),
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
      // The same document as head's by the hash that just proved it, so there
      // is nothing to walk and nothing that could differ.
      from: { of: "same", ref: head.ref },
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

/** One row of the reading: the recipe's own word for a section, and what it says. */
export interface Reading {
  name: string;
  says: string;
}

/**
 * The recipe an attempt was given, as a person reads it (#217).
 *
 * **`lingtai status`'s rows, in `lingtai status`'s words**, and two of them are
 * that command's own sentences rather than a second wording of them —
 * `describeAssignee` and `passCeiling`. There is one recipe and there should be
 * one vocabulary for it; a page that invented its own would be a second place
 * for the sentence about `restarts` to go stale, which is the whole of what
 * `passCeiling` exists to stop (0039 §3).
 *
 * **Grouped rather than dumped.** `canonical` is 3.5KB of sorted JSON and
 * printing it whole is honest and unreadable — the whole document is still one
 * disclosure below, for a reader who wants exactly that.
 *
 * All five points are counted, including the empty ones, for the reason the
 * rail draws them: a point that is merely absent looks like one that was
 * configured and silently did not run (0016 §4).
 */
export function readRecipe(recipe: Recipe): Reading[] {
  const limits = recipe.runtime.limits;
  const budget = recipe.runtime.budget;
  return [
    {
      name: "picks up",
      says:
        recipe.source.kinds.join(" > ") +
        (recipe.source.kinds.length > 1 ? " (in priority order)" : ""),
    },
    {
      name: "excludes",
      says: recipe.source.exclude.length > 0 ? recipe.source.exclude.join(", ") : "nothing",
    },
    { name: "assignee", says: describeAssignee(recipe.runtime.assignee) },
    {
      name: "the points",
      says: GATE_POINTS.map((point) => `${point} ${recipe.gates[point].length}`).join(" · "),
    },
    { name: "a pass", says: passCeiling({ ...limits, wallMs: parseDuration(limits.wall) }) },
    {
      name: "retries",
      says: `after ${recipe.source.backoff}, unless a repair is pending`,
    },
    {
      name: "budget",
      says:
        `evidence ${budget.evidence} · attempts ${budget.attempts} · ` +
        `findings ${budget.findings} · diff ${budget.diff}`,
    },
  ];
}
