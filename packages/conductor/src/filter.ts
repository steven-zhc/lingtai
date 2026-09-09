/**
 * What a project will and will not take, in one value and one wording.
 *
 * The reason this is a module rather than three call sites is #76. The recipe
 * on `main` was edited to name a label the core's `WorkKind` enum did not have,
 * so it stopped parsing and *every* issue in the project vanished from the
 * queue — including the two open bugs. The reason existed the whole time:
 * `resolveRecipe` throws with the offending path, `conduct.ts` puts it in
 * `outcome.refused`, and `lingtai status` prints it. It was simply nowhere the
 * operator was looking, and the operator's report was "I still don't know why
 * the issues weren't picked up."
 *
 * So: **a project's filter is stated where it is taken, before it is taken**,
 * and a project whose recipe will not resolve is a line that says so rather
 * than an absence. `lingtai daemon`, `lingtai status`, `lingtai doctor` and the
 * board all read this, which is what stops any two of them disagreeing about
 * whether a queue is empty or unreadable.
 */
import { GATE_POINTS, type GatePoint, type ProjectState } from "@lingtai/domain";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient, type GitHubClient } from "@lingtai/github";
import { parseDuration, type Recipe, type ResolvedRecipe } from "@lingtai/recipe";
import { currentRecipe } from "./projects.ts";

/**
 * One thing the recipe configures at a point, and what bounds it.
 *
 * `budgetMs` is null where nothing does — a reviewer, a watch, a person. An
 * absent budget is not an unlimited one; it is a thing with no clock on it, and
 * a card that showed `0` there would say the opposite.
 */
export interface PlannedAction {
  name: string;
  budgetMs: number | null;
}

/**
 * Every one of the five points, in loop order, with what runs at each.
 *
 * All five are present even where nothing is configured, because an empty point
 * is `skipped` and the skip has to be visible (ADR 0016 §4) — a point that is
 * merely absent from this map is indistinguishable from one that was
 * configured and silently did not run.
 */
export type GatePlan = ReadonlyMap<GatePoint, readonly PlannedAction[]>;

/**
 * The recipe's gates, with every duration already a number.
 *
 * Lifted out of the recipe for the reason `backoffMs` is: no caller reads a
 * duration string, so nothing downstream gets its own idea of what `20m` is.
 * The board needs it to say how far into its timeout a running gate has got,
 * which is the difference between *slow* and *about to be killed* (#79).
 */
export function gatePlan(recipe: Recipe): GatePlan {
  return new Map(
    GATE_POINTS.map((point) => [
      point,
      recipe.gates[point].map((action) => ({
        name: action.name,
        // Only a command has a clock. `parseDuration` throws on nonsense, and a
        // recipe that resolved has already been through the schema's check.
        budgetMs: "run" in action ? parseDuration(action.timeout) : null,
      })),
    ]),
  );
}

/**
 * Resolved or refused, and never a third thing.
 *
 * `ok: false` covers every way the recipe can fail to be read — missing,
 * unparseable, an App that cannot reach the repository, an owner that was never
 * recorded. They are one fact from where an operator sits: nothing will be
 * taken from this project, and here is why.
 */
export type ProjectFilter =
  | {
      project: string;
      ok: true;
      /** Of the *resolved* recipe. Identifies which configuration this is. */
      configHash: string;
      /** The base branch it was read from — never an agent's branch (0005). */
      ref: string;
      /** The labels that name work, most wanted first. */
      kinds: readonly string[];
      /** The labels that keep an agent off a ticket. */
      exclude: readonly string[];
      /**
       * Whether a failure of this repository's buys an agent, and how many.
       *
       * Lifted out of the recipe for the same reason `kinds` is: this is a
       * thing an operator has to be able to read without opening Lingtai's
       * source (0025 §2), and every place that says what a project will do
       * reads this shape rather than the recipe.
       */
      repair: { on: boolean; maxAttempts: number };
      /**
       * How long a failed attempt keeps its own ticket out of the queue,
       * `source.backoff` in milliseconds
       * ([0028](../../../doc/decisions/0028-the-backoff-is-the-recipes.md)).
       *
       * Lifted out for the reason `repair` is, and it is the same kind of
       * thing: a default that spends money — or, here, one that decides when
       * money is spent next — has to be readable without opening Lingtai's
       * source. Parsed once here so that no caller reads a duration string.
       */
      backoffMs: number;
      /**
       * What runs at each of the five points, with the timeouts as numbers.
       *
       * Lifted for the reason `backoffMs` is, and used for the same kind of
       * thing: a gate's timeout is the denominator a running card measures
       * against, and the board must not parse `20m` itself (#79).
       */
      plan: GatePlan;
      /**
       * The recipe and the client that read it, carried so a caller that wants
       * to go on and ask GitHub what is offered does not fetch either twice.
       */
      recipe: Recipe;
      client: GitHubClient;
    }
  | { project: string; ok: false; problem: string };

/** Builds a client for a project, or throws saying why it cannot. */
export type ClientFor = (state: ProjectState) => Promise<GitHubClient>;

/**
 * Reads a project's recipe from its base branch.
 *
 * `currentRecipe` for everything that conducts, and that is the point of the
 * seam rather than an aside: a conductor's resolve *is* the governance act
 * (0005), so it reads the file every time and this default must not become
 * something else. What a board does is a different question — it re-renders on
 * every append (#112) and asks the same branch the same thing several times a
 * second — and the answer to that one lives with the board.
 */
export type RecipeFor = (state: ProjectState, client: GitHubClient) => Promise<ResolvedRecipe>;

/**
 * The `ClientFor` everything outside a test uses.
 *
 * Throws with the reason rather than returning null. A project that cannot be
 * reached and a recipe that will not parse are the same fact to whoever is
 * reading the output — nothing will be taken from here — so they take the same
 * road out, and none of the four callers has to remember a second branch. This
 * is where "an App that is misconfigured" stopped being an empty column.
 */
export async function githubClientFor(state: ProjectState): Promise<GitHubClient> {
  if (!hasGitHubApp()) throw new Error("no GitHub App configured, so the recipe cannot be read");
  if (!state.project) throw new Error("no repository name recorded — re-run lingtai add");
  if (!state.owner) throw new Error("no owner recorded — re-run lingtai add to record it");
  return createGitHubClient({ auth: githubApp(), owner: state.owner, repo: state.project });
}

/**
 * Reads one project's recipe and reduces it to what it will take.
 *
 * Never throws. A caller asking "what will this project take" always gets an
 * answer, and "it could not be read, because …" is one of the answers rather
 * than an exception the caller may or may not remember to catch — which is the
 * shape of the empty catch this replaces.
 */
export async function projectFilter(
  state: ProjectState,
  clientFor: ClientFor = githubClientFor,
  recipeFor: RecipeFor = currentRecipe,
): Promise<ProjectFilter> {
  const project = state.project ?? "(unnamed)";
  try {
    const client = await clientFor(state);
    const resolved = await recipeFor(state, client);
    return {
      project,
      ok: true,
      configHash: resolved.configHash,
      ref: resolved.ref,
      kinds: resolved.recipe.source.kinds,
      exclude: resolved.recipe.source.exclude,
      repair: resolved.recipe.repair,
      backoffMs: parseDuration(resolved.recipe.source.backoff),
      plan: gatePlan(resolved.recipe),
      recipe: resolved.recipe,
      client,
    };
  } catch (err) {
    return { project, ok: false, problem: oneLine((err as Error).message) };
  }
}

export async function projectFilters(
  projects: readonly ProjectState[],
  clientFor: ClientFor = githubClientFor,
  recipeFor: RecipeFor = currentRecipe,
): Promise<ProjectFilter[]> {
  return Promise.all(projects.map((p) => projectFilter(p, clientFor, recipeFor)));
}

/**
 * `RecipeInvalidError` puts one problem per line, which reads well in a thrown
 * message and badly in a column. Folded to one line here, keeping every problem.
 */
function oneLine(message: string): string {
  return message.replace(/\s*\n\s*/g, " ").trim();
}

/** Wide enough for the project names this has, and stable so the block aligns. */
const NAME_WIDTH = 14;

/**
 * The block a person reads: two or three lines per project, aligned.
 *
 *     lingtai        recipe 3f8a1c2b9d04 from main
 *       picks up     bug > tech-debt > feature   (in priority order)
 *       excludes     blocked, in-progress, agent:hold
 *
 * and, for one that will not resolve, the same slot rather than a gap:
 *
 *     lingtai        RECIPE INVALID — source.kinds.3: Invalid option …
 *                    nothing will be taken from this project
 *
 * Loud on purpose. The failure it names cost a whole queue and read, from
 * outside, exactly like a backlog nobody had labelled.
 */
export function describeFilter(filter: ProjectFilter): string[] {
  const name = filter.project.padEnd(NAME_WIDTH);
  const gap = " ".repeat(NAME_WIDTH);
  if (!filter.ok) {
    return [`${name} RECIPE INVALID — ${filter.problem}`, `${gap} nothing will be taken from this project`];
  }
  const order = filter.kinds.length > 1 ? "   (in priority order)" : "";
  return [
    `${name} recipe ${filter.configHash.slice(0, 12)} from ${filter.ref}`,
    `  picks up     ${filter.kinds.join(" > ")}${order}`,
    `  excludes     ${filter.exclude.length > 0 ? filter.exclude.join(", ") : "nothing"}`,
    // Printed whether it is on or off, like a `skipped` gate point: a default
    // that only appears when it is doing something is a default nobody can
    // audit, and this one spends money (0025 §2).
    `  repairs      ${
      filter.repair.on
        ? `yes — at most ${filter.repair.maxAttempts} agent(s) per item`
        : "no — a failure of this repository's buys nothing"
    }`,
    // In the recipe's own words, for the same reason. The backoff decides when
    // this project spends money again and it was in none of the four places
    // that describe a project (#95) — a rule nobody can read is one nobody can
    // change on purpose.
    `  retries      after ${filter.recipe.source.backoff}, unless a repair is pending`,
  ];
}

export function describeFilters(filters: readonly ProjectFilter[]): string[] {
  return filters.flatMap(describeFilter);
}
