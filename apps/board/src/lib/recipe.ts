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
import { homedir } from "node:os";
import { STEPS, type ProjectState } from "@lingtai/domain";
import type { GitHubClient } from "@lingtai/github";
import { currentRecipe } from "@lingtai/conductor/projects";
import { passCeiling } from "@lingtai/conductor/ceiling";
import { describeAssignee } from "@lingtai/conductor/filter";
import { AgentUnresolvedError, LIMIT_DEFAULTS, MachineConfigInvalidError, PLUGINS, PROVENANCE_ARROW, RecipeInvalidError, RecipeMissingError, assigneeOf, backoffOf, disclose, discloseSteps, excludeOf, kindOfAction, kindsOf, limitsFor, machinePath, parseDuration, provenanceSource, recipePath, resolveRecipe, type GateAction, type PluginSecrets, type Recipe } from "@lingtai/recipe";

/** The limits `a pass` is made of, from the recipe rather than listed again here. */
const LIMIT_KEYS = Object.keys(LIMIT_DEFAULTS) as (keyof typeof LIMIT_DEFAULTS)[];

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
  /** Its path in the recipe, keyed by name where a list has names — `steps.proposed.build.run`. */
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
 *
 * **`changed` is settled by the hash, and `changes` is only what a walk of the
 * two documents could name.** The two are not the same question: the walk
 * renders every leaf as a string, so two documents the hash tells apart can
 * still read alike all the way down (`[a, b]` and `["a, b"]` do), and the list
 * comes back empty. `changed` stands — the hash is the proof — and the page
 * says the difference is not in a value it can name, never *0 values differ*.
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
 * **And its order is a value of its own**, because keying by name is exactly
 * what loses it. `canonical` serialises a list in order, so two gates holding
 * the same actions in the other order hash differently — and without this line
 * the walk finds nothing, `changed` carries an empty list, and the page asserts
 * a difference it then shows none of. Order is not decoration at a gate point:
 * it decides which action runs first and so which refusal stops the pass.
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
    else if (value.every((v) => typeof (v as { name?: unknown })?.name === "string")) {
      // The list's own path carries the names in the order they run, and each
      // one's values hang under it. A swap says so on this line and on no
      // other; an insertion says so here and names the new action below.
      into.set(at, value.map((v) => (v as { name: string }).name).join(" > "));
      for (const item of value) flatten(item, `${at}.${(item as { name: string }).name}`, into);
    } else into.set(at, value.map(say).join(", "));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, v] of Object.entries(value)) flatten(v, at === "" ? key : `${at}.${key}`, into);
    return;
  }
  into.set(at, say(value));
}

/**
 * Every path the two recipes disagree on, in the recipe's own order of keys.
 *
 * **The one place an action's field values are rendered whatever they are**,
 * which is why the walk is over `discloseSteps` and not over the recipe: every
 * other reading on this page asks for a field by name. A field a plugin marked
 * `no_log` carries `withheld`'s digest of its value before `flatten` sees it
 * (0061 §9) — so a rotated credential is a row saying that field changed, and
 * no row says what it changed to. A recipe with none — which is every recipe
 * today — walks exactly what it walked before.
 */
export function changesFromHead(
  mine: Recipe,
  head: Recipe,
  plugins?: readonly PluginSecrets[],
): Change[] {
  const a = new Map<string, string>();
  const b = new Map<string, string>();
  const shown = (recipe: Recipe) => ({ ...recipe, steps: discloseSteps(recipe.steps, plugins) });
  flatten(shown(mine), "", a);
  flatten(shown(head), "", b);
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
 * What a project's recipe says today, and where every value in it came from
 * (#218).
 *
 * **The board is the surface that carries this back.**
 * [0046](../../../../doc/decisions/0046-lingtai-is-personal.md) §3 moved the
 * recipe to `~/.lingtai/<project>/recipe.yml` and wrote down what that cost:
 * nothing in the repository says Lingtai is in use, and a file under a home
 * directory is not discoverable by looking at a clone. Two files decide one
 * project — the recipe and `~/.lingtai/config.yml` — and `provenance` is the
 * only thing that says which of them won.
 *
 * **Refused is an answer, not an empty page.** A recipe that will not parse is
 * the failure that cost this project a whole queue with doctor green throughout
 * (#76), and the page that exists to say what is configured must say *that*
 * rather than render a page with no rows on it. `at` is a file either way, so
 * the refusal names something a person can open.
 *
 * **And it is not always the recipe's file.** Two files decide one project, so
 * three of the ways this resolve can fail leave `recipe.yml` perfectly
 * readable: `gates:` in the machine file, an ill-formed `runtime.assignee`
 * there, and two runtimes signed in with nothing naming one — which 0046 §3
 * treats as an expected state and not a mistake. A page that answered all
 * three with *the recipe could not be read* would send its reader to open the
 * one file there is nothing wrong with, so `fault` says which, and `at` is the
 * file that fault is in.
 */
export type ProjectRecipe =
  | {
      ok: true;
      project: string;
      /** The file the recipe was read from. */
      at: string;
      /** Of the resolved recipe — what an attempt's is matched against (#217). */
      configHash: string;
      /** The base branch this recipe governs. */
      ref: string;
      rows: readonly Reading[];
      provenance: Readonly<Record<string, string>>;
    }
  | {
      ok: false;
      project: string;
      /** The file to open: the recipe, or this machine's `config.yml` when the fault is there. */
      at: string;
      /** Which of the two files `at` is, so the page can name the fault it actually has. */
      fault: "recipe" | "machine";
      problem: string;
    };

/**
 * Which file a refusal is about (#218).
 *
 * The machine file refuses `gates:` and an ill-formed `runtime.assignee` by
 * name, and `AgentUnresolvedError` is answered either there — by writing
 * `runtime.agent` — or by signing a runtime out. None of the three is fixed by
 * editing the recipe, and each names its own remedy in its message; what a
 * caller must not do is wrap all three in a sentence about the other file.
 *
 * `instanceof`, as `setup/wizard/page.tsx` already does across this same
 * boundary.
 */
function faultOf(err: unknown, recipe: string): { at: string; fault: "recipe" | "machine" } {
  return err instanceof MachineConfigInvalidError || err instanceof AgentUnresolvedError
    ? { at: machinePath(), fault: "machine" }
    : { at: recipe, fault: "recipe" };
}

/**
 * One project's recipe, resolved from this machine — **no request, and nothing
 * read from the repository**.
 *
 * `currentRecipe` and not `projectFilter`: the filter builds a GitHub client
 * first, and since #180 a recipe needs none, so a board with no App would be
 * told about its App by the one page that has nothing to do with GitHub.
 *
 * Never throws, for `projectFilter`'s reason: a caller asking what a project is
 * configured to do always gets an answer, and "it could not be read, because …"
 * is one of the answers.
 *
 * **The resolve is what the `try` is around, and nothing else.** `faultOf`
 * sorts the errors the *resolve* raises; anything else thrown under the same
 * `try` is sorted by its `else` branch and comes out as `fault: "recipe"`,
 * naming a file that need not hold the offending value at all. `readRecipe` is
 * outside it for that reason, and may be: the one value it parses rather than
 * prints is `runtime.limits.wall`, and since #218 both schemas that can carry
 * a `wall` refuse one that is not a duration — so the file that holds it says
 * so, under its own key, before a resolve ever succeeds.
 */
export async function projectRecipe(state: ProjectState): Promise<ProjectRecipe> {
  const project = state.project ?? "(unnamed)";
  const at = recipePath(project);
  let resolved: Resolved;
  try {
    resolved = await currentRecipe(state);
  } catch (err) {
    return {
      ok: false,
      project,
      ...faultOf(err, at),
      problem: (err as Error).message.replace(/\s*\n\s*/g, " ").trim(),
    };
  }
  return {
    ok: true,
    project,
    at,
    configHash: resolved.configHash,
    ref: resolved.ref,
    rows: readRecipe(resolved.recipe),
    provenance: resolved.provenance ?? {},
  };
}

/**
 * What an action does, and what bounds it, as one line each.
 *
 * Only a command carries a clock of its own (`gatePlan` reads the same
 * `timeout`), so every other kind says what holds it instead of inventing one.
 */
export function describeAction(
  action: GateAction,
  plugins: readonly PluginSecrets[] = PLUGINS,
): { does: string; bound: string } {
  // Every `no_log` value gone before a word of this is written (0061 §9). It
  // reads named fields, so today it could not print one by accident — the point
  // is that it does not have to be relied on not to.
  action = disclose(action, plugins);
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
    // The two the pass calls itself, so no step in the recipe can hold one
    // today — `whyNoKindAt` refuses both everywhere. A reading with no case
    // for them would be a `switch` that returns `undefined` the moment the
    // ticket after this one wires them up, on a page nobody would think to
    // re-test; the closed set is read here, so the set is what this answers.
    case "worktree": {
      const a = action as Extract<GateAction, { worktree: { base: string; submodules: boolean } }>;
      return {
        does: `cuts the branch from origin/${a.worktree.base}${a.worktree.submodules ? ", submodules and all" : ""}`,
        bound: "no clock — it is the directory the work happens in",
      };
    }
    case "merge": {
      const a = action as Extract<GateAction, { merge: { strategy: string } }>;
      return {
        does: `lands the branch by ${a.merge.strategy}, onto the base it was cut from`,
        bound: "no clock — the base moving under it is a recomputation, not a refusal",
      };
    }
    // And the one `claim` will hold, on the same footing and for the same
    // reason: the queue calls it itself today, so no step can hold one and
    // this reading is here so that the day one can, the page already says what
    // it does rather than returning `undefined`.
    //
    // **Its `assignee` field is read here and not in a case of its own** (0063
    // §3, `#244`): it used to be a plugin beside this one, and the two rows the
    // page drew for it were two rows about one decision.
    case "queue": {
      const a = action as Extract<
        GateAction,
        { queue: { kinds: string[]; exclude: string[]; backoff: string; assignee?: { login?: string; take: string } } }
      >;
      const exclude = a.queue.exclude.length === 0 ? "" : `, never ${a.queue.exclude.join(", ")}`;
      const me = a.queue.assignee?.login ?? "this machine's login";
      const whose =
        a.queue.assignee?.take === "mine"
          ? `, only where assigned to ${me}`
          : a.queue.assignee?.take === "unassigned"
            ? ", only where assigned to nobody"
            : "";
      return {
        does: `takes ${a.queue.kinds.join(" before ")}${exclude}${whose}`,
        bound: `a failed attempt waits ${a.queue.backoff} before its own ticket is offered again`,
      };
    }
    // And the one `proposed` will hold, whose `bound` is the whole of why it is
    // worth naming: the ceilings are the workflow's and a judge never sees
    // them, so what this row says about money is true of any judge a project
    // writes, including one that is somebody else's code (0061 §3).
    case "judge": {
      const a = action as Extract<GateAction, { judge: string; when: string }>;
      return {
        does:
          a.judge === "same-worktree"
            ? `decides a ${a.when} refusal with a built-in: back to implement, spending nothing`
            : `asks ${a.judge} which step is next, for a ${a.when} refusal`,
        bound: "the workflow counts the rounds and restarts, and offers only the steps still left",
      };
    }
    // And the one that sits beside it and decides nothing about where the pass
    // goes: `backlog:` is an effect, so its `bound` is *nothing* — the reading
    // a person budgets from, since at or below the bar is the half of a
    // reviewer's output that costs no agent at all (`#237`).
    case "backlog": {
      const a = action as Extract<GateAction, { backlog: string }>;
      return {
        does: `files every finding at ${a.backlog} or below for a person, instead of refusing`,
        bound: "no clock, and no round — a finding that did not refuse buys nothing",
      };
    }
  }
}

/** One row of the reading: the recipe's own word for a section, and what it says. */
export interface Reading {
  name: string;
  says: string;
  /**
   * The paths in `provenance` this row's value is made of, so the page that has
   * one can say where the row came from (#218).
   *
   * Paths and not a source, because the reading is the same reading whether it
   * was resolved on this machine or read out of a run's record: an attempt's
   * recipe has no provenance at all, and `sourceOf` answers null for it rather
   * than this function having two shapes.
   *
   * Several for a row that is several values — `a pass` is four limits and each
   * can come from a different file, which is exactly the fact worth showing.
   */
  keys: readonly string[];
}

/**
 * Where a row's value came from, as the source column reads it (#218).
 *
 * **Distinct sources, in the row's own order, and every one of them.** `a pass`
 * is four limits: with `turns` in the machine file and the rest defaulted, one
 * source printed there would be a sentence that is true of a number it is not
 * made of — the failure the-bar.md records for `rounds ×N`. Null when nothing
 * is known, which is what an attempt's recorded recipe always answers.
 */
export function sourceOf(row: Reading, provenance?: Readonly<Record<string, string>>): string | null {
  if (provenance === undefined) return null;
  const wheres: string[] = [];
  for (const key of row.keys) {
    const where = provenanceSource(provenance[key]);
    if (where !== null && !wheres.includes(underHome(where))) wheres.push(underHome(where));
  }
  return wheres.length === 0 ? null : wheres.join(", ");
}

/**
 * A path under this machine's home as its owner writes it — `~/.lingtai/…`.
 *
 * The source column is read across a row, and an absolute path spends most of
 * its width on the part every row shares. Only the prefix is touched, so a
 * source that is not a path (`default`, `detected — the only runtime signed
 * in`) and a path with a section after it (`…/config.yml (projects.lingtai)`)
 * both come back saying exactly what they said.
 */
export function underHome(where: string): string {
  const home = homedir();
  return home !== "" && where.startsWith(`${home}/`) ? `~${where.slice(home.length)}` : where;
}

/** One line of `lingtai doctor`'s provenance block, split into its columns. */
export interface Provenance {
  /** Its path in the recipe — `runtime.limits.turns`. */
  key: string;
  value: string;
  /** The file, `detected …`, or `default`. */
  from: string;
}

/**
 * Every value the resolve knows the origin of, as three columns (#218).
 *
 * **The whole map and not the rows' keys.** `repo.base` and `env.required` are
 * in it and in no reading, and a page whose exhaustive list was assembled from
 * what the reading above already showed would be exhaustive of the wrong thing.
 * This is `provenanceLines`' block, which `lingtai doctor` has printed since
 * #180 and no surface with a screen ever has.
 */
export function provenanceRows(provenance: Readonly<Record<string, string>>): Provenance[] {
  return Object.entries(provenance).map(([key, entry]) => {
    const at = entry.indexOf(PROVENANCE_ARROW);
    return {
      key,
      value: at === -1 ? entry : entry.slice(0, at),
      from: underHome(provenanceSource(entry) ?? "(not said)"),
    };
  });
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
 * All ten steps are counted, including the empty ones, for the reason the
 * rail draws them: a step that is merely absent looks like one that was
 * configured and silently did not run (0016 §4, 0061 §5).
 */
export function readRecipe(recipe: Recipe): Reading[] {
  const limits = limitsFor(recipe, "implement");
  const budget = recipe.runtime.budget;
  return [
    {
      name: "picks up",
      says:
        kindsOf(recipe).join(" > ") +
        (kindsOf(recipe).length > 1 ? " (in priority order)" : ""),
      keys: ["source.kinds"],
    },
    {
      name: "excludes",
      says: excludeOf(recipe).length > 0 ? excludeOf(recipe).join(", ") : "nothing",
      keys: ["source.exclude"],
    },
    {
      name: "assignee",
      says: describeAssignee(assigneeOf(recipe)),
      keys: ["runtime.assignee.take", "runtime.assignee.login"],
    },
    {
      name: "the points",
      says: STEPS.map((point) => `${point} ${recipe.steps[point].length}`).join(" · "),
      keys: ["steps"],
    },
    {
      name: "a pass",
      says: passCeiling({ ...limits, wallMs: parseDuration(limits.wall) }),
      keys: LIMIT_KEYS.map((key) => `runtime.limits.${key}`),
    },
    // **Beside the limits, because it is the other half of the same answer.**
    // Which CLI runs the work and what it may spend are the two the machine
    // decides (0046 §3), and a reading that named the spend and not the runtime
    // would leave the one value a machine can silently detect unattributed.
    { name: "agent", says: recipe.runtime.agent, keys: ["runtime.agent"] },
    {
      name: "retries",
      says: `after ${backoffOf(recipe)}, unless a repair is pending`,
      keys: ["source.backoff"],
    },
    {
      name: "budget",
      says:
        `evidence ${budget.evidence} · attempts ${budget.attempts} · ` +
        `findings ${budget.findings} · diff ${budget.diff}`,
      // Four numbers with four origins, like `a pass`: a recipe that sets
      // `attempts` and leaves the rest to the schema has one source for one of
      // them and `default` for three, and the row says both.
      keys: Object.keys(budget).map((key) => `runtime.budget.${key}`),
    },
  ];
}
