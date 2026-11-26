'use server'
import { everyRuntime } from '@lingtai/agent'
import {
  addProject,
  checkPersonalEffect,
  ghLoginHere,
  livePorts,
  previewOf,
  readLocalTarget,
  type PersonalCheck,
} from '@lingtai/conductor/add-from-page'
import { ceilingReading, ceilingSentences } from '@lingtai/conductor/ceiling'
import { recipePath } from '@lingtai/project'
import { resolveSource } from '@lingtai/recipe'
import { parseDuration } from '@lingtai/recipe/duration'
import { boundsBesides, ceilingOf } from '@lingtai/recipe/settings'
import { LINGTAI_BASE, type SetupForm, type SetupTarget } from '@lingtai/setup'
import { Effect } from 'effect'

/**
 * Step 2's two server actions (#971). **They take the form's answers and build
 * the changes here**: the page never hands the writer a `RecipeChange[]`, and
 * what names the project, the remote and the turn ceiling is read again on the
 * server rather than taken from the page.
 */
import { actor } from '@/lib/actor'

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
    // A `gh` machine's login is read here and overrides the page's; an App machine acts for nobody, so the typed one stands (`refusalOf` checks its shape).
    const login = form.mode === 'team' ? ((await Effect.runPromise(ghLoginHere)) ?? (form.login?.trim() || null)) : null
    return {
      ...form,
      project: repo,
      remote: null,
      closeOnEnd: form.closeOnEnd,
      turnsUnbounded: noCeiling,
      login,
    }
  }
  const found = await Effect.runPromise(readLocalTarget(form.target.path))
  if (!found.ok) return { refused: found.why }
  const name = found.path.split('/').filter(Boolean).at(-1) ?? ''
  return {
    ...form,
    project: name,
    target: { kind: 'local', path: found.path },
    // Solo lands on `lingtai-base`, made from the checked-out branch; a team project's main *is* the checked-out branch (0130 §2).
    base: form.mode === 'team' ? (found.branch ?? '') : LINGTAI_BASE,
    login: null,
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
    const reading = ceilingReading({
      ...limits.attempt,
      ...limits.ticket,
      ...limits.run,
      wallMs: parseDuration(limits.run.wall),
      steps: boundsBesides(recipe, 'implement'),
    })
    return { text: previewed.text, ceiling: { summary: reading.summary, sentences: ceilingSentences(reading) } }
  } catch (err) {
    return { refused: (err as Error).message }
  }
}

/** The one write: the recipe, then the registration `lingtai add` makes. */
export async function addRepository(form: SetupForm): Promise<AddResult> {
  const checked = await trusted(form)
  if ('refused' in checked) return { ok: false, say: checked.refused }
  const added = await Effect.runPromise(addProject(checked, livePorts(checked.target, actor())))
  return added.ok ? { ok: true, project: added.project } : added
}

/**
 * The check as the personal branch is typed: git's rules and whether it exists. **Advisory** — it reads and never
 * writes, and `addRepository` re-runs the refusal and makes the branch on its own authority.
 */
export async function checkPersonal(target: SetupTarget, name: string, base: string): Promise<PersonalCheck> {
  // The target is re-read as `trusted` re-reads it: a page does not choose which directory or repository is asked.
  if (target.kind === 'github') {
    if (!SLUG.test(target.owner) || !SLUG.test(target.repo)) return { ok: false, say: 'not a repository', fix: null }
    return Effect.runPromise(checkPersonalEffect(target, name, base))
  }
  const found = await Effect.runPromise(readLocalTarget(target.path))
  if (!found.ok) return { ok: false, say: found.why, fix: null }
  return Effect.runPromise(checkPersonalEffect({ kind: 'local', path: found.path }, name, base))
}
