/**
 * The onboarding wizard's page (#164): two speeds, and the collapse that makes
 * it work. What the rows are and how a line moves is
 * `@lingtai/conductor/wizard-page`; this is where the page gets its first state.
 *
 * **Step one reads this machine, not the repository.** The recipe is
 * `~/.lingtai/<project>/recipe.yml` ([0046](../../../../../../doc/decisions/0046-lingtai-is-personal.md)
 * §3, #180), so if that file is there the page is an update flow — the same two
 * speeds, the fast lane filled from it with the machine's agent and limits, and
 * an edit made with `editRecipe` so the file's comments survive it. A
 * `.lingtai/config.yaml` in the repository is not read: nothing runs by it, and
 * a page editing it would be editing values nothing obeys. Otherwise the
 * repository is read back by `proposeRecipe` (#161).
 *
 * **Nothing is written by loading it.** Every request here is a `GET`; the
 * page's button is what writes, and only on this machine (`finish.ts`).
 */
import { onboardState, updateState } from "@lingtai/conductor/wizard-page";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient, parseSlug } from "@lingtai/github";
import type { ProjectState } from "@lingtai/domain";
import { currentRecipe } from "@lingtai/conductor/projects";
import {
  AgentUnresolvedError,
  MachineConfigInvalidError,
  RecipeInvalidError,
  proposeRecipe,
  recipePath,
} from "@lingtai/recipe";
import { readFile } from "node:fs/promises";
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
    const existing = await readFile(recipePath(repo), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    if (existing !== null) {
      let resolved;
      try {
        // The read a run makes, so the page shows the agent and limits a run gets.
        resolved = await currentRecipe({ project: repo, owner } as ProjectState);
      } catch (err) {
        // The files on this machine are what is wrong, and picking another repository does not fix it.
        if (
          err instanceof RecipeInvalidError ||
          err instanceof MachineConfigInvalidError ||
          err instanceof AgentUnresolvedError
        ) {
          return { state: "invalid", slug, why: err.message };
        }
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
        agent: proposal.found.runtime,
        proposedFromScan: proposal.proposedFromScan,
      }),
      recipe: proposal.recipe,
      existing: null,
    };
  } catch (err) {
    return { state: "unreadable", why: (err as Error).message };
  }
}
