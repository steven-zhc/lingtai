'use server'

import { readFile } from 'node:fs/promises'

import { startOnboarding } from '@lingtai/conductor/wizard'
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
 * bytes, written to `~/.lingtai/<project>/recipe.yml` with the page's agent
 * under `runtime.agent` (`#372`), and `ProjectOnboardingStarted` appended — so the board draws a pending card whose
 * `Recheck` reads exactly that file. Nothing is written to the repository. The
 * page's limits are the recipe's own (`#375`) and are written into the file
 * itself, with every other field it chose.
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
  wholeSteps,
  type WizardState,
} from '@lingtai/conductor/wizard-page'
import { githubApp, hasGitHubApp } from '@lingtai/env'
import { createGitHubClient, parseSlug } from '@lingtai/github'
import { Recipe, editRecipe, hashRecipe, recipePath, resolveRecipe, writtenAgent } from '@lingtai/recipe'

import { actor } from '../../../lib/actor.ts'

export type Finished =
  | {
      ok: true
      /** `path`'s text, its agent included (#372). */
      file: string
      path: string
      changed: string[]
      /** Whether `file` is on disk already: onboarding writes, an edit does not. */
      written: boolean
    }
  | { ok: false; refusals: string[] }

export async function finishWizard(input: {
  state: WizardState
  /** The recipe the page started from: the scan's proposal, or the machine's, resolved. */
  recipe: Recipe
  /** `~/.lingtai/<project>/recipe.yml` as it is, when there is one. */
  existing: string | null
}): Promise<Finished> {
  const { state } = input
  const refusals = finishRefusals(state)
  if (refusals.length > 0) return { ok: false, refusals }

  try {
    const { owner, repo } = parseSlug(state.slug)
    if (input.existing === null) {
      if (!hasGitHubApp()) return { ok: false, refusals: ['no GitHub App configured'] }
      const started = await startOnboarding({
        client: await createGitHubClient({ auth: githubApp(), owner, repo }),
        recipe: Recipe.parse(applyDraft(Recipe.parse(input.recipe), state)),
        said: saidFor(state),
        by: actor(),
      })
      if (!started.ok) return { ok: false, refusals: [started.refusal] }
      return {
        ok: true,
        file: await readFile(started.path, 'utf8'),
        path: started.path,
        changed: [],
        written: true,
      }
    }
    return await editExisting(input.existing, state, { project: repo, current: input.recipe })
  } catch (err) {
    return { ok: false, refusals: [(err as Error).message] }
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
 * **`runtime.agent` is the recipe's** (`#372`) and is written into the file as
 * every other field is — and written **whenever the file names none**, even
 * where the page's choice equals the schema's default: a file silent about its
 * agent is resolved by asking what is signed in, so leaving the line out would
 * make the page's answer depend on the machine. `runtime.limits` is the
 * recipe's own (`#375`) and is written exactly as every other field.
 */
export async function editExisting(
  existing: string,
  state: WizardState,
  at: { project: string; current: Recipe; home?: string },
): Promise<Finished> {
  const ref = state.draft.base
  const { recipe } = await resolveRecipe(async () => existing, ref)
  const after = Recipe.parse(applyDraft(at.current, state))
  const describes = async (file: string) =>
    (await resolveRecipe(async () => file, ref)).configHash === hashRecipe(after)

  let changes = changesFrom(recipe, after)
  if (writtenAgent(existing) === 'absent' && !changes.some((c) => c.path.join('.') === 'runtime.agent')) {
    changes = [...changes, { path: ['runtime', 'agent'], value: after.runtime.agent }]
  }
  let file = editRecipe(existing, changes)
  if (!(await describes(file))) {
    changes = wholeSteps(changes, after)
    file = editRecipe(existing, changes)
    if (!(await describes(file))) {
      return {
        ok: false,
        refusals: [
          `the edit to ${changes.map((c) => c.path.join('.')).join(', ')} would not read back as the recipe this page ` +
            'describes — what the file inherits would change with it — so it is not offered',
        ],
      }
    }
  }

  return {
    ok: true,
    file,
    path: recipePath(at.project, at.home),
    changed: changes.map((c) => c.path.join('.')),
    written: false,
  }
}
