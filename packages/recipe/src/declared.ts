/**
 * The recipe file as a person declared it (0128 §6): the text alone, before any host, machine file or preset is
 * asked. Everything here is a function of text (0128 §8).
 */
import { createHash } from 'node:crypto'

import { parse as parseYaml } from 'yaml'

import { SCHEMA_PROBE_AGENT, asRecord } from './local.ts'
import { applyPreset } from './presets.ts'
import { Recipe } from './recipe.ts'
import {
  RecipeInvalidError,
  RecipeRefusedError,
  OldSpellingRefusedError,
  oldSpellingsIn,
  refuseOnMeaning,
  retiredLimits,
  retiredTier,
  unknownKeys,
} from './resolve.ts'
import { SandboxBlock } from './sandbox-block.ts'
import { refFor } from './write.ts'

/** The text with every `\r\n` and `\r` made `\n`, and nothing else changed. */
export const sourceOf = (text: string): string => text.replace(/\r\n?/g, '\n')

/** sha256, hex, of the text's `sourceOf` — so CRLF and LF hash alike and a changed comment does not. */
export const sourceHashOf = (text: string): string => createHash('sha256').update(sourceOf(text), 'utf8').digest('hex')

/**
 * The preset first, as the resolve does: it may satisfy a field the file omits (`steps:` empty, `repo:` absent). An
 * unknown preset name is the resolve's to refuse, so the file is read as written. Then the runtime probe: only an
 * absent or null `runtime:` is the schema's to default; any other non-mapping stays as written to be refused.
 */
function presetAndProbe(mapping: Record<string, unknown>): {
  applied: Record<string, unknown>
  runtime: Record<string, unknown> | null
  probe: unknown
} {
  let applied: Record<string, unknown> = mapping
  try {
    applied = asRecord(applyPreset(mapping).recipe) ?? mapping
  } catch {
    // unknown `extends:` — left to the resolve
  }
  const declaredRuntime = applied['runtime']
  const runtime = declaredRuntime == null ? {} : asRecord(declaredRuntime)
  const probe =
    runtime === null ? declaredRuntime : 'agent' in runtime ? runtime : { ...runtime, agent: SCHEMA_PROBE_AGENT }
  return { applied, runtime, probe }
}

/**
 * The recipe a source declares, from the text alone (#1489): YAML, preset, probe, schema — and none of
 * `checkDeclared`'s refusals, which are the resolve's. `null` when the text does not parse to a `Recipe`.
 */
export function parseDeclared(source: string): Recipe | null {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch {
    return null
  }
  const mapping = asRecord(raw)
  if (mapping === null) return null
  const { applied, probe } = presetAndProbe(mapping)
  const parsed = Recipe.safeParse({ ...applied, runtime: probe })
  return parsed.success ? parsed.data : null
}

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

  const { applied, runtime, probe } = presetAndProbe(mapping)

  const old = oldSpellingsIn(applied)
  if (old.length > 0) throw new OldSpellingRefusedError(ref, old, where)

  const unknown = unknownKeys(applied)
  if (unknown.length > 0) throw new RecipeInvalidError(ref, unknown, where)
  const retired = [...retiredTier(applied), ...retiredLimits(applied)]
  if (retired.length > 0) throw new RecipeInvalidError(ref, retired, where)

  const parsed = Recipe.safeParse({ ...applied, runtime: probe })
  if (!parsed.success) {
    throw new RecipeInvalidError(
      ref,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      where,
    )
  }
  // The probe agent is not the file's, so a refusal about the agent is asked only of a file that wrote one.
  const refused = refuseOnMeaning(parsed.data, runtime !== null && 'agent' in runtime, applied)
  if (refused.length > 0) throw new RecipeRefusedError(ref, refused, where)
}

/**
 * What a recorded source declares for `sandbox:` (#1163), from the text alone — no host, no resolve. An absent key
 * is `block: undefined`, which is *off by choice* (`sandboxDecision`'s rule). YAML that does not parse, a root that
 * is not a mapping, or a block the schema refuses is `unreadable`, never off. No preset carries `sandbox`, so
 * `extends:` cannot supply it and only this one key is validated.
 */
export type DeclaredSandbox =
  | { readonly kind: 'block'; readonly block: SandboxBlock | undefined }
  | { readonly kind: 'unreadable'; readonly why: string }

export function declaredSandbox(source: string): DeclaredSandbox {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    return { kind: 'unreadable', why: `could not be parsed as YAML: ${(err as Error).message}` }
  }
  const mapping = asRecord(raw)
  if (mapping === null) return { kind: 'unreadable', why: '(root): expected a mapping' }
  if (!('sandbox' in mapping) || mapping['sandbox'] === undefined) return { kind: 'block', block: undefined }
  const parsed = SandboxBlock.safeParse(mapping['sandbox'])
  if (!parsed.success) {
    return {
      kind: 'unreadable',
      why: parsed.error.issues.map((i) => `sandbox.${i.path.join('.')}: ${i.message}`).join('; '),
    }
  }
  return { kind: 'block', block: parsed.data }
}
