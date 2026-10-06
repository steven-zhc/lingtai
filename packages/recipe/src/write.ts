import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
/**
 * Writing a project's recipe down (#395) — the part `editRecipe` (#162) does
 * not do: finding the file, creating it when there is none, checking the
 * result with the same resolver a daemon reads it with, and replacing it
 * atomically. Nothing here re-serialises a recipe a person has edited —
 * `emit.ts`'s header says why that is the one thing this module must never do.
 *
 * `setRecipe` is not wired to a caller yet. #396–#399 are.
 */
import { isDeepStrictEqual } from 'node:util'

import { isNode, parse as parseYaml, parseDocument } from 'yaml'
import { z } from 'zod'

import { type RecipeChange, editRecipe } from './emit.ts'
import { recipePath } from './local.ts'
import { RECIPE_VERSION } from './recipe.ts'
import { RecipeInvalidError, resolveSource } from './resolve.ts'

/** The file seam: a `Map`-backed one for tests, `diskFiles` for the real thing. */
export interface RecipeFiles {
  /** Null when the file is not there. */
  read: (path: string) => Promise<string | null>
  replace: (path: string, text: string) => Promise<void>
}

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

/**
 * Beside, then renamed over: an interruption mid-write leaves the old file or
 * the new one, never half of either (`apps/cli/src/init.ts`'s `writeConfig`).
 * The default mode, not `0600` — a recipe carries no credential the way
 * `config.yml`'s database URL does.
 */
export const diskFiles: RecipeFiles = {
  read: readIfThere,
  replace: async (path, text) => {
    await mkdir(dirname(path), { recursive: true })
    const partial = `${path}.${process.pid}.partial`
    await writeFile(partial, text)
    await rename(partial, path)
  },
}

export interface SetRecipeResult {
  path: string
  text: string
  /** False when the change set the same value the file already had. */
  written: boolean
}

/** What a refusal names: the file's own `repo.base` where the text parses that far, else `path`. */
function refFor(text: string, path: string): string {
  try {
    const raw = parseYaml(text) as unknown
    const base = (raw as { repo?: { base?: unknown } } | null)?.repo?.base
    return typeof base === 'string' ? base : path
  } catch {
    return path
  }
}

/**
 * `editRecipe`, on the file or on a seed of just `version:` when there is
 * none — and a `ZodError` turned into a named refusal rather than the JSON
 * dump its own `message` is. `editRecipe` runs its own `Recipe.parse` before
 * the resolver below ever sees the text, which is where both of these show up:
 * a new file given fields that do not add up to a resolvable recipe, and an
 * existing file edited into one that no longer does.
 */
function editedText(existing: string | null, changes: readonly RecipeChange[], path: string): string {
  const base = existing ?? `version: ${RECIPE_VERSION}\n`
  try {
    return editRecipe(base, changes)
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new RecipeInvalidError(
        path,
        err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
        path,
      )
    }
    throw err
  }
}

/**
 * `changes`, widened to a whole `steps:` write when a narrow one would move a
 * step this change did not name.
 *
 * `applyPreset` (`presets.ts:149`) is `steps: recipe['steps'] ?? preset.steps`
 * — all-or-nothing, unlike `repo` and `runtime`, which merge key by key. A file
 * that `extends:` a preset and writes no `steps:` of its own inherits every
 * step from the preset; the moment a change gives it its first `steps:` key,
 * `recipe['steps']` turns truthy and the preset's steps stop applying — a step
 * this change never mentioned moves anyway. Caught by trying the narrow edit
 * first and comparing: only a step named in `changes` may differ from what the
 * file resolved to before.
 */
function widenStepsIfNeeded(existing: string, changes: readonly RecipeChange[], path: string): readonly RecipeChange[] {
  const stepChanges = changes.filter((c) => c.path[0] === 'steps')
  if (stepChanges.length === 0 || stepChanges.some((c) => c.path.length === 1)) return changes

  let before
  try {
    before = resolveSource(existing, refFor(existing, path), path)
  } catch {
    return changes
  }

  const narrowText = editedText(existing, changes, path)
  const narrowSteps = resolveSource(narrowText, refFor(narrowText, path), path).recipe.steps as Record<string, unknown>
  const beforeSteps = before.recipe.steps as Record<string, unknown>
  const touched = new Set(stepChanges.map((c) => String(c.path[1])))
  const displaced = Object.keys(beforeSteps).some(
    (key) => !touched.has(key) && !isDeepStrictEqual(beforeSteps[key], narrowSteps[key]),
  )
  if (!displaced) return changes

  const fullSteps: Record<string, unknown> = { ...beforeSteps }
  for (const key of touched) fullSteps[key] = narrowSteps[key]
  return [...changes.filter((c) => c.path[0] !== 'steps'), { path: ['steps'], value: fullSteps }]
}

/**
 * Sets `changes` on a project's recipe: creates the file when it is absent,
 * edits it in place — keeping every comment and every key it was not asked to
 * change — when it exists. Validates the result with `resolveSource`, the same
 * function a daemon reads the file with, before anything is written: a change
 * the resolver would refuse is refused by name, and the file is left exactly
 * as it was ([doc/design/the-plugin-body.md](../../../doc/design/the-plugin-body.md)
 * — a running daemon refuses a key its code does not know, #148).
 *
 * `written` is false when the change set a value the file already had —
 * `editRecipe` returns the same text, and nothing is replaced.
 */
export async function setRecipe(
  project: string,
  changes: readonly RecipeChange[],
  options?: { home?: string; files?: RecipeFiles },
): Promise<SetRecipeResult> {
  const files = options?.files ?? diskFiles
  const path = recipePath(project, options?.home)
  const existing = await files.read(path)
  const widened = existing === null ? changes : widenStepsIfNeeded(existing, changes, path)
  const text = editedText(existing, widened, path)

  resolveSource(text, refFor(text, path), path)

  if (existing !== null && text === existing) return { path, text, written: false }
  await files.replace(path, text)
  return { path, text, written: true }
}

/**
 * The value at `path` in a project's recipe, or null when the file is absent
 * or does not write that key.
 *
 * **What the file says, not what resolves.** A key a preset supplies but the
 * file does not write reads null here, not the preset's value: for #392's
 * *current value as the default*, pressing enter on a null must not write the
 * preset's value into the file as though the file had chosen it.
 */
export async function readRecipeKey(
  project: string,
  path: readonly (string | number)[],
  options?: { home?: string; files?: RecipeFiles },
): Promise<unknown | null> {
  const files = options?.files ?? diskFiles
  const recipeFilePath = recipePath(project, options?.home)
  const text = await files.read(recipeFilePath)
  if (text === null) return null
  const value = parseDocument(text).getIn(path)
  return value === undefined ? null : isNode(value) ? value.toJSON() : value
}
