/**
 * The onboarding wizard's page (#164): two speeds, and the collapse that makes
 * it work. What the rows are and how a line moves is
 * `@lingtai/conductor/wizard-page`; this is where the page gets its first state.
 *
 * **Step one reads the base branch.** If `.lingtai/config.yaml` is already
 * there the page is an update flow — the same two speeds, the fast lane filled
 * from the file, and an edit made with `editRecipe` so the file's comments
 * survive it. Otherwise the repository is read back by `proposeRecipe` (#161).
 *
 * **Nothing is written.** Every request here is a `GET`, and the page ends at
 * the recipe as a file: [0046](../../../../../../doc/decisions/0046-lingtai-is-personal.md)
 * removed the step that committed it to the repository, so there is no pull
 * request to open from here.
 */
import { onboardState, updateState } from "@lingtai/conductor/wizard-page";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient, parseSlug } from "@lingtai/github";
import { RECIPE_PATH, RecipeInvalidError, proposeRecipe, resolveRecipe } from "@lingtai/recipe";
import { type Loaded, WizardScreen } from "./wizard.tsx";

export const dynamic = "force-dynamic";

export default async function Wizard({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const params = await searchParams;
  return <WizardScreen loaded={await load(params.repo ?? "")} />;
}

async function load(input: string): Promise<Loaded> {
  if (!hasGitHubApp()) return { state: "no-app" };
  let owner: string;
  let repo: string;
  try {
    ({ owner, repo } = parseSlug(input));
  } catch (err) {
    return { state: "unreadable", why: (err as Error).message };
  }
  const slug = `${owner}/${repo}`;
  try {
    const client = await createGitHubClient({ auth: githubApp(), owner, repo });
    const base = await client.defaultBranch();
    const existing = await client.fileAt(RECIPE_PATH, base);
    if (existing !== null) {
      let resolved;
      try {
        resolved = await resolveRecipe(async () => existing, base);
      } catch (err) {
        // The repository answered; the file on it is what is wrong, and picking another repository does not fix it.
        if (err instanceof RecipeInvalidError) return { state: "invalid", slug, why: err.message };
        throw err;
      }
      const { recipe } = resolved;
      return { state: "ready", initial: updateState({ slug, recipe }), recipe, existing };
    }
    const proposal = await proposeRecipe(slug, client);
    return {
      state: "ready",
      initial: onboardState({
        slug,
        recipe: proposal.recipe,
        scripts: proposal.found.scripts,
        labels: proposal.found.labels,
        doubts: proposal.refusals,
      }),
      recipe: proposal.recipe,
      existing: null,
    };
  } catch (err) {
    return { state: "unreadable", why: (err as Error).message };
  }
}
