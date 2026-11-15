/**
 * The recipe file as a person declared it (0128 §6): the text alone, before any host, machine file or preset is
 * asked. Everything here is a function of text (0128 §8).
 */
import { createHash } from 'node:crypto'

import { parse as parseYaml } from 'yaml'

import { SCHEMA_PROBE_AGENT, asRecord } from './local.ts'
import { applyPreset } from './presets.ts'
import { Recipe } from './recipe.ts'
import { RecipeInvalidError, retiredTier, unknownKeys } from './resolve.ts'
import { refFor } from './write.ts'

/** The text with every `\r\n` and `\r` made `\n`, and nothing else changed. */
export const sourceOf = (text: string): string => text.replace(/\r\n?/g, '\n')

/** sha256, hex, of the text's `sourceOf` — so CRLF and LF hash alike and a changed comment does not. */
export const sourceHashOf = (text: string): string => createHash('sha256').update(sourceOf(text), 'utf8').digest('hex')

/**
 * Throws `RecipeInvalidError` when the text is not a declaration worth recording. **The text's alone**: no host probe,
 * no signed-in runtime, no machine file and no preset (an unknown `extends:` name is the resolve's to refuse, not
 * this). Whether the recipe then resolves on this host is the attempt's question.
 */
export function checkDeclared(text: string, where: string): void {
  const ref = refFor(text, where)
  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (err) {
    throw new RecipeInvalidError(ref, [`could not be parsed as YAML: ${(err as Error).message}`], where)
  }
  const mapping = asRecord(raw)
  if (mapping === null) throw new RecipeInvalidError(ref, ['(root): expected a mapping'], where)

  // The preset first, as the resolve does: it may satisfy a field the file omits (`steps:` empty, `repo:` absent).
  // An unknown preset name is the resolve's to refuse, so the file is checked as written.
  let applied: Record<string, unknown> = mapping
  try {
    applied = asRecord(applyPreset(mapping).recipe) ?? mapping
  } catch {
    // unknown `extends:` — left to the resolve
  }

  const unknown = unknownKeys(applied)
  if (unknown.length > 0) throw new RecipeInvalidError(ref, unknown, where)
  const retired = retiredTier(applied)
  if (retired.length > 0) throw new RecipeInvalidError(ref, retired, where)

  // Only an absent or null `runtime:` is the schema's to default; any other non-mapping stays as written to be refused.
  const declaredRuntime = applied['runtime']
  const runtime = declaredRuntime == null ? {} : asRecord(declaredRuntime)
  const probe =
    runtime === null ? declaredRuntime : 'agent' in runtime ? runtime : { ...runtime, agent: SCHEMA_PROBE_AGENT }
  const parsed = Recipe.safeParse({ ...applied, runtime: probe })
  if (!parsed.success) {
    throw new RecipeInvalidError(
      ref,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      where,
    )
  }
}
