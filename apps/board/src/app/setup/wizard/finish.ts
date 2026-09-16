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
import { applyDraft, changesFrom, finishRefusals, saidFor, type WizardState } from "@lingtai/conductor/wizard-page";
import { validateProposal } from "@lingtai/conductor/wizard";
import { Recipe, editRecipe, resolveRecipe } from "@lingtai/recipe";

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
    const { recipe } = await resolveRecipe(async () => input.existing, state.draft.base);
    const changes = changesFrom(recipe, applyDraft(recipe, state));
    return {
      ok: true,
      file: editRecipe(input.existing, changes),
      changed: changes.map((c) => c.path.join(".")),
    };
  } catch (err) {
    return { ok: false, refusals: [(err as Error).message] };
  }
}
