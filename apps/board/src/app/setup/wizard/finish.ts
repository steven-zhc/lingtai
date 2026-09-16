"use server";

/**
 * The end of the wizard's page: the recipe it describes, as a file, or why
 * there is none yet (#164).
 *
 * **Computed again here rather than trusted from the page.** `finishRefusals`
 * runs on the server as well, so a state that arrived with `source.kinds` empty
 * is refused whatever the browser let through; a new recipe goes through
 * `validateProposal` — the system's own parser, on the bytes — and an existing
 * one through `editRecipe`, which changes the lines of the fields that moved and
 * refuses rather than drop a comment.
 *
 * It writes nothing. Where the file goes is 0046's, and not this page's.
 */
import {
  applyDraft,
  changesFrom,
  finishRefusals,
  saidFor,
  wholeGates,
  type WizardState,
} from "@lingtai/conductor/wizard-page";
import { validateProposal } from "@lingtai/conductor/wizard";
import { Recipe, editRecipe, hashRecipe, resolveRecipe } from "@lingtai/recipe";

export type Finished =
  | { ok: true; file: string; changed: string[] }
  | { ok: false; refusals: string[] };

export async function finishWizard(input: {
  state: WizardState;
  /** The recipe the page started from: the scan's proposal, or the file's. */
  recipe: Recipe;
  /** The file as it is on the base branch, when there is one. */
  existing: string | null;
}): Promise<Finished> {
  const { state } = input;
  const refusals = finishRefusals(state);
  if (refusals.length > 0) return { ok: false, refusals };

  try {
    if (input.existing === null) {
      const started = Recipe.parse(input.recipe);
      const validated = await validateProposal(applyDraft(started, state), saidFor(state));
      return validated.ok ? { ok: true, file: validated.file, changed: [] } : { ok: false, refusals: [validated.refusal] };
    }
    return await editExisting(input.existing, state);
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
 */
export async function editExisting(existing: string, state: WizardState): Promise<Finished> {
  const ref = state.draft.base;
  const { recipe } = await resolveRecipe(async () => existing, ref);
  const after = Recipe.parse(applyDraft(recipe, state));
  const describes = async (file: string) =>
    (await resolveRecipe(async () => file, ref)).configHash === hashRecipe(after);

  let changes = changesFrom(recipe, after);
  let file = editRecipe(existing, changes);
  if (!(await describes(file))) {
    changes = wholeGates(changes, after);
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
  return { ok: true, file, changed: changes.map((c) => c.path.join(".")) };
}
