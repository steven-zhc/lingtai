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

/**
 * `ResolvedRecipe`, named off the function that returns one.
 *
 * Inferred rather than imported so the board does not take a dependency on the
 * recipe package to write down a type it never constructs — it holds one and
 * hands it back.
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
