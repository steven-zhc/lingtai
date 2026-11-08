'use server'
/**
 * Step 2's two server actions (#971). **They take the form's answers and build
 * the changes here**: the page never hands the writer a `RecipeChange[]`, and
 * what names the project, the remote and the turn ceiling is read again on the
 * server rather than taken from the page.
 */
import { everyRuntime } from '@lingtai/agent'
import { addProject, livePorts, previewOf, readLocalTarget } from '@lingtai/conductor/add-from-page'
import { attemptCeiling } from '@lingtai/conductor/ceiling'
import { resolveSource } from '@lingtai/recipe'
import { recipePath } from '@lingtai/recipe'
import { parseDuration } from '@lingtai/recipe/duration'
import { boundsBesides, ceilingOf } from '@lingtai/recipe/settings'
import { LINGTAI_BASE, type SetupForm } from '@lingtai/setup'
import { Effect } from 'effect'

import type { AddResult, Preview } from './read-model.ts'

const SLUG = /^[\w.-]+$/

/** The form with every fact the server knows overriding what the page said. */
async function trusted(form: SetupForm): Promise<SetupForm | { refused: string }> {
  const noCeiling = everyRuntime().some(
    (r) => r.capabilities.id === form.writer && !r.capabilities.enforces.includes('turns'),
  )
  if (form.target.kind === 'github') {
    const { owner, repo } = form.target
    if (!SLUG.test(owner) || !SLUG.test(repo)) return { refused: `${owner}/${repo} is not a repository` }
    return { ...form, project: repo, remote: null, closeOnEnd: form.closeOnEnd, turnsUnbounded: noCeiling }
  }
  const found = await Effect.runPromise(readLocalTarget(form.target.path))
  if (!found.ok) return { refused: found.why }
  const name = found.path.split('/').filter(Boolean).at(-1) ?? ''
  return {
    ...form,
    project: name,
    target: { kind: 'local', path: found.path },
    base: LINGTAI_BASE,
    remote: found.path,
    tickets: 'db',
    closeOnEnd: false,
    turnsUnbounded: noCeiling,
  }
}

/** The recipe the answers would write, and the sentence the limits make — nothing is written. */
export async function previewAdd(form: SetupForm): Promise<Preview> {
  const checked = await trusted(form)
  if ('refused' in checked) return checked
  const previewed = await Effect.runPromise(previewOf(checked))
  if ('refused' in previewed) return previewed
  try {
    const path = recipePath(checked.project)
    const { recipe } = resolveSource(previewed.text, path, path)
    const limits = ceilingOf(recipe)
    const ceiling = attemptCeiling({
      ...limits,
      wallMs: parseDuration(limits.wall),
      steps: boundsBesides(recipe, 'implement'),
    })
    return { text: previewed.text, ceiling }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

/** The one write: the recipe, then the registration `lingtai add` makes. */
export async function addRepository(form: SetupForm): Promise<AddResult> {
  const checked = await trusted(form)
  if ('refused' in checked) return { ok: false, say: checked.refused }
  const added = await Effect.runPromise(addProject(checked, livePorts(checked.target)))
  return added.ok ? { ok: true, project: added.project } : added
}
