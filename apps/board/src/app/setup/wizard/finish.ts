"use server";

/**
 * The end of the wizard's page: the recipe it describes, as a file, or why
 * there is none yet (#164).
 *
 * **Computed again here rather than trusted from the page.** `finishRefusals`
 * runs on the server as well, so a state that arrived with `source.kinds` empty
 * is refused whatever the browser let through.
 *
 * **Onboarding ends by writing, on this machine** (0046 §3, #180). A new recipe
 * goes through `startOnboarding` — parsed by the system's own parser on the
 * bytes, written to `~/.lingtai/<project>/recipe.yml` with its own ceiling in
 * it (`#371`) and the page's agent under `projects.<project>.runtime` in
 * `~/.lingtai/config.yml`, and `ProjectOnboardingStarted` appended — so the
 * board draws a pending card whose `Recheck` reads exactly that file. Nothing
 * is written to the repository.
 *
 * An existing recipe — the machine's, never a copy in the repository — goes
 * through `editExisting`, which changes the lines of the fields that moved and
 * refuses rather than drop a comment, and writes nothing.
 */
import {
  applyDraft,
  changesFrom,
  finishRefusals,
  saidFor,
  wholeLimits,
  wholeSteps,
  type WizardState,
} from "@lingtai/conductor/wizard-page";
import { startOnboarding } from "@lingtai/conductor/wizard";
import { githubApp, hasGitHubApp } from "@lingtai/env";
import { createGitHubClient, parseSlug } from "@lingtai/github";
import { Recipe, editRecipe, hashRecipe, hasLegacyProjectLimits, machineFiles, machinePath, recipePath, resolveRecipe } from "@lingtai/recipe";
import { readFile } from "node:fs/promises";
import { actor } from "../../../lib/actor.ts";

export type Finished =
  | {
      ok: true;
      /** `path`'s text — never with `runtime.agent` in it; `runtime.limits` is in it since `#371`. */
      file: string;
      path: string;
      /** `~/.lingtai/config.yml` as it would be with this change, or null when it needs none. */
      machine: string | null;
      changed: string[];
      /** Whether `file` is on disk already: onboarding writes, an edit does not. */
      written: boolean;
    }
  | { ok: false; refusals: string[] };

export async function finishWizard(input: {
  state: WizardState;
  /** The recipe the page started from: the scan's proposal, or the machine's, resolved. */
  recipe: Recipe;
  /** `~/.lingtai/<project>/recipe.yml` as it is, when there is one. */
  existing: string | null;
}): Promise<Finished> {
  const { state } = input;
  const refusals = finishRefusals(state);
  if (refusals.length > 0) return { ok: false, refusals };

  try {
    const { owner, repo } = parseSlug(state.slug);
    if (input.existing === null) {
      if (!hasGitHubApp()) return { ok: false, refusals: ["no GitHub App configured"] };
      const started = await startOnboarding({
        client: await createGitHubClient({ auth: githubApp(), owner, repo }),
        recipe: Recipe.parse(applyDraft(Recipe.parse(input.recipe), state)),
        said: saidFor(state),
        by: actor(),
      });
      if (!started.ok) return { ok: false, refusals: [started.refusal] };
      return {
        ok: true,
        file: await readFile(started.path, "utf8"),
        path: started.path,
        machine: null,
        changed: [],
        written: true,
      };
    }
    const machine = await readFile(machinePath(), "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return null;
      throw err;
    });
    return await editExisting(input.existing, state, { project: repo, current: input.recipe, machine });
  } catch (err) {
    return { ok: false, refusals: [(err as Error).message] };
  }
}

/**
 * The existing file with the page's changes made, **checked by reading it back**.
 *
 * The changes are worked out on the recipe with its preset filled in, and made
 * to the file as written, and the two are not the same shape: a file that says
 * `extends:` and has no `gates:` gets every gate from the preset, and a `gates`
 * block of one point replaces all of them. So the edited file is resolved again
 * and must describe the recipe the page does; where it does not, the gates are
 * written whole, and where that still does not, nothing is offered.
 *
 * **`runtime.agent` is never written into it** (#180): a recipe carrying it is
 * refused at the path it is read from. It is compared with `current` — what
 * the machine resolved it to — and a change to it is the machine file with
 * `projects.<project>.runtime.agent` set, beside it.
 *
 * **`runtime.limits` is the opposite since `#371`: it is written here, and the
 * machine file only loses its stale copy of it.** The ceiling is written
 * whole — every key, not only the ones that moved — whenever a dial moved or
 * the machine file still carries `projects.<project>.runtime.limits`: a save
 * nobody touched a dial on still migrates that block out from under it, and a
 * number left unwritten would otherwise drift the day a schema default
 * changes under a file nobody edited.
 */
export async function editExisting(
  existing: string,
  state: WizardState,
  at: { project: string; current: Recipe; machine: string | null; home?: string },
): Promise<Finished> {
  const ref = state.draft.base;
  const { recipe } = await resolveRecipe(async () => existing, ref);
  const drafted = Recipe.parse(applyDraft(at.current, state));
  // The file's half: everything the page changed, including the ceiling —
  // `runtime.limits` is the recipe's own since `#371`. `agent` stays pinned to
  // what the file's own bytes already say (the machine's, until a save moves
  // it), so it is never offered as a change to the file.
  const after = Recipe.parse({
    ...drafted,
    runtime: { ...drafted.runtime, agent: recipe.runtime.agent },
  });
  const describes = async (file: string) =>
    (await resolveRecipe(async () => file, ref)).configHash === hashRecipe(after);

  let changes = changesFrom(recipe, after);
  const legacy = hasLegacyProjectLimits(at.machine, at.project);
  if (legacy || changes.some((c) => c.path[0] === "runtime" && c.path[1] === "limits")) {
    changes = wholeLimits(changes, after);
  }
  let file = editRecipe(existing, changes);
  if (!(await describes(file))) {
    changes = wholeSteps(changes, after);
    file = editRecipe(existing, changes);
    if (!(await describes(file))) {
      return {
        ok: false,
        refusals: [
          `the edit to ${changes.map((c) => c.path.join(".")).join(", ")} would not read back as the recipe this page ` +
            "describes — what the file inherits would change with it — so it is not offered",
        ],
      };
    }
  }

  // `limits` excluded: it is the recipe file's own change now, handled above,
  // and reaches `machineFiles` only through `legacy`'s migration — never
  // because a dial moved with nothing on this machine left to migrate.
  const runtime = changesFrom(at.current, drafted).filter((c) => c.path[0] === "runtime" && c.path[1] !== "limits");
  let machine: string | null = null;
  if (runtime.length > 0 || legacy) {
    const split = machineFiles({
      file,
      recipe: drafted,
      project: at.project,
      machine: at.machine,
      ...(at.home === undefined ? {} : { home: at.home }),
      replace: true,
    });
    if (!split.ok) return { ok: false, refusals: [split.refusal] };
    machine = split.machine;
  }
  return {
    ok: true,
    file,
    path: recipePath(at.project, at.home),
    machine,
    changed: [...changes, ...runtime].map((c) => c.path.join(".")),
    written: false,
  };
}
