/**
 * Resolving a recipe: parse it, validate it, hash it.
 *
 * **Where the text comes from is not this file's any more.** A run is governed
 * by `~/.lingtai/<project>/recipe.yml`, read by `resolveLocalRecipe` in
 * `local.ts` through `resolveSource` below
 * ([0046](../../../doc/decisions-archive/0046-lingtai-is-personal.md) §3, #180). Nothing
 * reads `.lingtai/config.yaml` from a managed repository to run anything, so
 * editing or merging that file changes no run, and `tamper` has nothing there
 * to catch.
 *
 * `resolveRecipe` and `ReadAtRef` remain for the readers that still have a
 * file at a ref in hand: the task page proving a run recorded before the move
 * against its base commit, the wizard checking the bytes it is about to write,
 * and tests. 0005's rule — *read from the base branch, never the branch being
 * judged* — was what made a recipe inside the repository safe; it now holds by
 * location, because an agent's worktree does not contain `~/.lingtai/`.
 */
import { createHash } from 'node:crypto'

import { Effect } from 'effect'
import { parse as parseYaml } from 'yaml'

import { branchNameRefusal } from './branch-name.ts'
import type { RecipeChange } from './emit.ts'
import { failed, plainWhen } from './files.ts'
import type { Plugin } from './plugin.ts'
import { applyPreset } from './presets.ts'
import { DiscussAgent, PLUGINS, Recipe, discloseSteps } from './recipe.ts'
import { assigneeOf, branchKeyOf, branchOf, modeOf, ticketSourceOf } from './settings.ts'

/** Where a project's recipe lives, by convention and without exception. */
export const RECIPE_PATH = '.lingtai/config.yaml'

/** Reads a path at a ref. Returns null when the file is not there. */
export type ReadAtRef = (path: string, ref: string) => Promise<string | null>

export class RecipeMissingError extends Error {
  override readonly name = 'RecipeMissingError'
  readonly ref: string

  constructor(ref: string, message?: string) {
    super(
      message ??
        `no ${RECIPE_PATH} on ${ref}. Add one and commit it to that branch — ` +
          "a recipe on the agent's branch is not read, by design.",
    )
    this.ref = ref
  }
}

export class RecipeInvalidError extends Error {
  // Widened from the literal so `RecipeRefusedError` can carry a name of its own.
  override readonly name: string = 'RecipeInvalidError'
  /** Each problem as `path: message`, so a fix does not need a schema reading. */
  readonly problems: readonly string[]

  constructor(ref: string, problems: readonly string[], where = `${RECIPE_PATH} on ${ref}`) {
    super(`${where} is not valid:\n  ${problems.join('\n  ')}`)
    this.problems = problems
  }
}

/**
 * A recipe **refused on its meaning** — it parsed, and says something the
 * system will not do (0130 §2, §3). A reader tells this from *could not be
 * parsed*, which stays a plain `RecipeInvalidError`, by `_tag` and never by the
 * sentence. Still an `instanceof RecipeInvalidError`, so every existing catch
 * takes both.
 */
export class RecipeRefusedError extends RecipeInvalidError {
  override readonly name: string = 'RecipeRefusedError'
  readonly _tag = 'RecipeRefused' as const

  constructor(ref: string, problems: readonly string[], where = `${RECIPE_PATH} on ${ref}`) {
    super(ref, problems, where)
  }
}

/**
 * A recipe refused for writing an old spelling of the base or of `take: both`
 * (#1308, 0130 §2–3). Carries what it found, so `lingtai doctor` names and
 * `--fix` rewrites the same keys without reading the file again.
 */
export class OldSpellingRefusedError extends RecipeRefusedError {
  override readonly name: string = 'OldSpellingRefusedError'
  readonly spellings: readonly OldSpelling[]

  constructor(ref: string, spellings: readonly OldSpelling[], where = `${RECIPE_PATH} on ${ref}`) {
    super(
      ref,
      spellings.map((s) => s.sentence),
      where,
    )
    this.spellings = spellings
  }
}

export interface ResolvedRecipe {
  recipe: Recipe
  /**
   * Hash of the *resolved* recipe, canonically serialised.
   *
   * Of the resolved form rather than the file's bytes: two files that differ
   * only in comments or key order describe the same run, and a replay comparing
   * "did results change after I edited the pipeline?" should say no. Recorded in
   * `ProjectConfigured` and in every `RunStarted`.
   */
  configHash: string
  /** The ref it was read from — always a base branch, never an agent branch. */
  ref: string
  /** The raw file, kept so a diff against a later version is possible. */
  source: string
  /** Which preset it extended, if any. Provenance; not part of the hash. */
  preset: string | null
  /**
   * Where each value a person might ask about came from — the recipe file, the
   * machine file, detection or a default — keyed by its path in the recipe.
   * Only a recipe read from this machine has one (`resolveLocalRecipe`).
   */
  provenance?: Readonly<Record<string, string>>
}

/** Stable JSON: keys sorted at every level, so the hash does not depend on order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

/**
 * The five steps [0058](../../../doc/decisions-archive/0058-lingtai-is-a-development-pipeline.md)
 * §3 added on 2026-09-23, left out of the canonical form while they are empty.
 *
 * **A hash cannot be upcast, which is the whole of why this is here.** A
 * `configHash` is the identity of a document
 * ([0047](../../../doc/decisions-archive/0047-the-recipe-a-run-got-is-on-the-log.md) §2:
 * *two documents with one hash are one document*), and the log is full of
 * hashes taken when `gates` had five keys. Widening `StepMap` to ten put five
 * more always-empty keys inside `canonical`, so the identical `recipe.yml`
 * hashed to something new — and there is no step from an old digest to a new
 * one the way `StepsResolved`'s `3 → 4` has one for a stored plan. The task
 * page proves an attempt's recipe by comparing its recorded hash to the file
 * at the run's base commit (`apps/board/src/lib/recipe.ts`), so every attempt
 * already in the record would fail that comparison and be told, in a refusal,
 * that the recipe at its base differs — about bytes that never changed.
 *
 * **Nothing is lost by leaving them out.** No plugin declares itself at any of
 * the five, so a resolving recipe's list at one of them is *always* `[]` — the
 * canonical form is dropping a field that carries no information. The day
 * 0058's plan builds one and a recipe configures it, the list is non-empty, it
 * is in the hash, and the hash changes because the configuration did.
 *
 * It dies where the nine upcasters die: [0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md)
 * §7's reset ([the-pipeline](../../../doc/design/the-pipeline.md)'s T5) leaves
 * no stored hash to keep faith with, and this list comes down with them.
 */
const NOT_YET_IN_THE_HASH = ['claim', 'design', 'implement', 'build', 'review'] as const

/**
 * The recipe as it is hashed: the five steps above dropped where they are
 * empty, which today is always.
 *
 * Both `canonicalRecipe` and `hashRecipe` go through it, because the body on
 * the event and the digest beside it have to be the same document — 0047 §2's
 * *a reader can verify the body without trusting the writer* is `hashRecipe`
 * of the recorded body equalling the recorded hash, and a strip on one side
 * only would break it.
 *
 * **Idempotent, and that is what makes the verification work.** The reader in
 * `conductor/unit/recorded-recipe.test.ts` hands `hashRecipe` the body off the
 * event, which has already been through here, so the five keys are gone rather
 * than empty — a missing one is *also* nothing configured there, and must be
 * left alone rather than read for a length it does not have.
 */
function forHash(recipe: Recipe, plugins: readonly Plugin[]): Record<string, unknown> {
  // **Every `no_log` value comes out here**, so the body on the event and the
  // digest beside it are both of a document with no secret in it
  // ([0061](../../../doc/decisions-archive/0061-the-recipe-is-the-pipeline.md) §9).
  // The *field* stays, carrying `withheld`'s digest of what was there, because
  // the digest beside the body is the document's identity (0047 §2) and a
  // deleted field would make a recipe and the same recipe with the credential
  // rotated one document. Above the drop below rather than under it, because
  // the two answer different questions and only this one is about what may be
  // written down.
  const steps: Record<string, unknown> = { ...discloseSteps(recipe.steps, plugins) }
  for (const step of NOT_YET_IN_THE_HASH) {
    if ((steps[step] as readonly unknown[] | undefined)?.length === 0) delete steps[step]
  }
  // `runtime.tier` left the recipe (#1158) and is written back here as the
  // default it used to carry. **A hash cannot be upcast** (see above): the
  // defaulted `tier: 'guarded'` was inside every recorded `configHash`, and a
  // recipe that resolves now is one that never wrote another value (`sandboxed`
  // and `open` are refused), so putting it back keeps every recipe's hash. Set
  // unconditionally so it stays idempotent over a body already through here.
  return { ...recipe, runtime: { ...recipe.runtime, tier: 'guarded' }, steps }
}

/**
 * The recipe as `hashRecipe` sees it, as an object rather than a string: what
 * `StepsResolved` records beside the hash (0047 §2). The body and its hash on
 * one event is what lets a reader verify the body without trusting the writer —
 * `hashRecipe` of this is the `configHash` of the recipe it came from.
 */
export function canonicalRecipe(recipe: Recipe, plugins: readonly Plugin[] = PLUGINS): Record<string, unknown> {
  return JSON.parse(canonical(forHash(recipe, plugins))) as Record<string, unknown>
}

/**
 * `plugins` is the closed set and a caller has no reason to pass another — it
 * is there so `unit/plugin.test.ts` can prove the `no_log` substitution over a
 * plugin that declares a secret field, which none of the six does today.
 *
 * **A withheld value is still in the hash, as a digest of itself.** Two recipes
 * that differ only in a credential are two documents and hash as two, which is
 * what the task page's *same document as head* reading rests on (0047 §2); what
 * they are not is two documents a reader of either can tell the credential of.
 */
export function hashRecipe(recipe: Recipe, plugins: readonly Plugin[] = PLUGINS): string {
  return createHash('sha256')
    .update(canonical(forHash(recipe, plugins)))
    .digest('hex')
}

/**
 * Reads and validates the recipe at a ref.
 *
 * Throws rather than returning a result type: every caller's correct response to
 * an unreadable recipe is to stop, and a project that cannot be configured must
 * not be silently run with a default.
 */
export const resolveRecipeEffect = Effect.fn('recipe.resolve-at-ref')(function* (read: ReadAtRef, ref: string) {
  const source = yield* Effect.tryPromise({ try: () => read(RECIPE_PATH, ref), catch: failed('read-at-ref') })
  if (source === null) return yield* Effect.fail(new RecipeMissingError(ref))
  return yield* plainWhen(
    () => resolveSource(source, ref, `${RECIPE_PATH} on ${ref}`),
    (e): e is RecipeInvalidError => e instanceof RecipeInvalidError,
  )
})

export function resolveRecipe(read: ReadAtRef, ref: string) {
  return Effect.runPromise(resolveRecipeEffect(read, ref))
}

/**
 * The half of `resolveRecipe` that does not care where the text came from.
 *
 * `where` is how a refusal names the file; `shape` runs on the parsed YAML
 * before the preset and may refuse keys by name or fill fields in — which is
 * how `resolveLocalRecipe` puts the machine's `runtime.agent` and
 * `runtime.limits` into a recipe that may not carry them itself.
 */
export function resolveSource(
  source: string,
  ref: string,
  where: string,
  shape: (raw: Record<string, unknown>) => string[] = () => [],
): ResolvedRecipe {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    throw new RecipeInvalidError(ref, [`could not be parsed as YAML: ${(err as Error).message}`], where)
  }

  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const refused = shape(raw as Record<string, unknown>)
    if (refused.length > 0) throw new RecipeInvalidError(ref, refused, where)
  }

  // Preset first, then validation: a preset can satisfy a required field the
  // recipe omits, which is the point of having one.
  let applied: ReturnType<typeof applyPreset>
  try {
    applied = applyPreset(raw)
  } catch (err) {
    throw new RecipeInvalidError(ref, [`extends: ${(err as Error).message}`], where)
  }

  const old = oldSpellingsIn(applied.recipe)
  if (old.length > 0) throw new OldSpellingRefusedError(ref, old, where)

  const unknown = unknownKeys(applied.recipe)
  if (unknown.length > 0) throw new RecipeInvalidError(ref, unknown, where)

  const retired = [...retiredTier(applied.recipe), ...retiredLimits(applied.recipe)]
  if (retired.length > 0) throw new RecipeInvalidError(ref, retired, where)

  // A recipe may write no `runtime:` at all — its agent on each step or
  // detected (#372), and every field inside defaulted — so an absent one is
  // the schema's, as `emitRecipe` already reads it.
  const withRuntime =
    applied.recipe !== null &&
    typeof applied.recipe === 'object' &&
    (applied.recipe as Record<string, unknown>)['runtime'] == null
      ? { ...applied.recipe, runtime: {} }
      : applied.recipe
  const parsed = Recipe.safeParse(withRuntime)
  if (!parsed.success) {
    throw new RecipeInvalidError(
      ref,
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      where,
    )
  }

  const refusedOnMeaning = refuseOnMeaning(parsed.data, true, applied.recipe)
  if (refusedOnMeaning.length > 0) throw new RecipeRefusedError(ref, refusedOnMeaning, where)

  // The resolved form is what gets hashed, so the preset is inside the hash and
  // a preset change is a configuration change.
  return {
    recipe: parsed.data,
    configHash: hashRecipe(parsed.data),
    ref,
    source,
    preset: applied.preset,
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** One old spelling a file wrote: where, the sentence that refuses it, and the edit that ends it. */
export interface OldSpelling {
  /** `repo.base`, `steps.admit[0].worktree.base`, `runtime.assignee.take: both`. */
  readonly at: string
  /** The refusal's sentence, naming the key, the fix and `lingtai doctor --fix`. */
  readonly sentence: string
  /** What `editRecipe` applies to end it. A base spelling carries the `branch.main` write. */
  readonly changes: readonly RecipeChange[]
}

const DOCTOR_FIX = 'or run `lingtai doctor --fix`'

/**
 * The old spellings a raw recipe writes (#1308, 0130 §2–3), found on the raw
 * object **before the parse**, like `retiredLimits`, so the `Recipe` type never
 * holds the old names:
 *
 * - `repo.base` and `steps.admit[*].worktree.base` → `branch.main`;
 * - `take: both` at `runtime.assignee` or `steps.claim[*].queue.assignee` → `all`.
 *
 * Pure. `[]` for a file in the new spelling or one that is not a mapping. The one
 * reader the refusal, `lingtai doctor`'s row and `--fix` all stand on, so the
 * three name exactly the same keys. A base spelling's change writes the file's
 * own `branch.main` where it has one (a file with two homes), else admit's
 * `worktree.base`, then `repo.base` — the precedence the old accessor had.
 */
export function oldSpellingsIn(raw: unknown): OldSpelling[] {
  if (!isRecord(raw)) return []
  const out: OldSpelling[] = []
  const bases: { at: string; sentence: string }[] = []
  let main: unknown
  let wroteMain = false
  if (isRecord(raw['branch']) && 'main' in raw['branch']) {
    main = raw['branch']['main']
    wroteMain = true
  }

  const steps = isRecord(raw['steps']) ? raw['steps'] : null
  if (steps !== null && Array.isArray(steps['admit'])) {
    ;(steps['admit'] as unknown[]).forEach((action, i) => {
      if (!isRecord(action) || !isRecord(action['worktree']) || !('base' in action['worktree'])) return
      if (!wroteMain) {
        main = action['worktree']['base']
        wroteMain = true
      }
      const at = `steps.admit[${i}].worktree.base`
      bases.push({
        at,
        sentence: `${at}: move the branch to \`branch.main\`; \`worktree:\` carries \`submodules\` only (0104 §5), ${DOCTOR_FIX}`,
      })
    })
  }
  if (isRecord(raw['repo']) && 'base' in raw['repo']) {
    if (!wroteMain) {
      main = raw['repo']['base']
      wroteMain = true
    }
    bases.push({
      at: 'repo.base',
      sentence: `repo.base: write \`branch: { main: <value> }\` (0130 §2), ${DOCTOR_FIX}`,
    })
  }
  for (const b of bases) out.push({ ...b, changes: [{ path: ['branch', 'main'], value: main }] })

  const takeBoth = (holder: unknown, at: string, path: (string | number)[]) => {
    if (isRecord(holder) && isRecord(holder['assignee']) && holder['assignee']['take'] === 'both') {
      const where = `${at}.assignee.take: both`
      out.push({
        at: where,
        sentence: `${where}: write \`take: all\` (0130 §3), ${DOCTOR_FIX}`,
        changes: [{ path: [...path, 'assignee', 'take'], value: 'all' }],
      })
    }
  }
  takeBoth(raw['runtime'], 'runtime', ['runtime'])
  if (steps !== null && Array.isArray(steps['claim'])) {
    ;(steps['claim'] as unknown[]).forEach((action, i) => {
      if (isRecord(action)) {
        takeBoth(action['queue'], `steps.claim[${i}].queue`, ['steps', 'claim', i, 'queue'])
      }
    })
  }
  return out
}

/**
 * The two places a recipe can write `assignee`, as the file wrote them — `runtime.assignee` and each
 * `steps.claim[i].queue.assignee` — with the parsed rule beside it.
 */
function assigneeHolders(raw: unknown): { at: string; assignee: Record<string, unknown> }[] {
  const out: { at: string; assignee: Record<string, unknown> }[] = []
  if (!isRecord(raw)) return out
  const runtime = raw['runtime']
  if (isRecord(runtime) && isRecord(runtime['assignee'])) {
    out.push({ at: 'runtime.assignee', assignee: runtime['assignee'] })
  }
  const steps = raw['steps']
  if (isRecord(steps) && Array.isArray(steps['claim'])) {
    steps['claim'].forEach((action: unknown, i: number) => {
      if (isRecord(action) && isRecord(action['queue']) && isRecord(action['queue']['assignee'])) {
        out.push({ at: `steps.claim[${i}].queue.assignee`, assignee: action['queue']['assignee'] })
      }
    })
  }
  return out
}

/**
 * Whose tickets a recipe may take, refused on its meaning (0130 §3, #1310).
 *
 * **Read from the raw mapping, not the parse**: `take` defaults to `all`, so afterwards a written
 * `take: all` and an absent one are the same value, and only the first is refused in team mode. A
 * `mine` needs no raw reading — it is never a default, so a parsed one was written.
 */
function assigneeRefusals(recipe: Recipe, raw: unknown): string[] {
  const out: string[] = []
  const team = modeOf(recipe) === 'team'
  const github = ticketSourceOf(recipe) === 'github'
  if (team) {
    for (const { at, assignee } of assigneeHolders(raw)) {
      const take = assignee['take']
      if (take === 'all' || take === 'unassigned') {
        out.push(
          `${at}.take: ${take} — mode: team takes your own tickets; take: ${take} would take ${
            take === 'all' ? "everyone's" : "nobody's"
          }. Remove take, or use mode: solo.`,
        )
      }
    }
    if (github && assigneeOf(recipe)?.login === undefined) {
      out.push(
        "queue.assignee.login: mode: team on GitHub takes the issues assigned to this machine's login; write `runtime.assignee.login`",
      )
    }
    return out
  }
  if (github) {
    const { runtime } = recipe
    const rules: { at: string; login: string | undefined; take: string }[] = [
      { at: 'runtime.assignee', login: runtime.assignee?.login, take: runtime.assignee?.take ?? 'all' },
    ]
    recipe.steps.claim.forEach((action, i) => {
      if ('queue' in action) {
        rules.push({
          at: `steps.claim[${i}].queue.assignee`,
          login: action.queue.assignee.login,
          take: action.queue.assignee.take,
        })
      }
    })
    for (const r of rules) {
      if (r.take === 'mine' && r.login === undefined) {
        out.push(`${r.at}.login: take: mine needs a login — the GitHub login this machine's issues are assigned to`)
      }
    }
  }
  return out
}

/**
 * The refusals a recipe earns **on its meaning** once it has parsed (0130 §2,
 * §3), each naming the key and the fix. Pure and synchronous: the branch-name
 * check is `branchNameRefusal`, a copy of git's rules, never a process.
 *
 * `wroteAgent` is whether `runtime.agent` is the file's own: `checkDeclared`
 * fills an absent one with a probe, and a probe must not decide a refusal.
 */
export function refuseOnMeaning(recipe: Recipe, wroteAgent: boolean, raw: unknown): string[] {
  const out: string[] = []
  const team = modeOf(recipe) === 'team'
  out.push(...assigneeRefusals(recipe, raw))
  const personal = recipe.branch.personal
  if (team && personal === undefined) {
    out.push('branch.personal: `mode: team` lands on a personal branch; write `branch.personal`, or use `mode: solo`')
  }
  if (!team && personal !== undefined) {
    out.push('branch.personal: is read only in team mode; delete it, or write `mode: team`')
  }
  if (personal !== undefined) {
    const why = branchNameRefusal(personal)
    if (why !== null)
      out.push(`branch.personal: ${JSON.stringify(personal)} is not a branch name git accepts: it ${why}`)
    else if (personal.toLowerCase() === recipe.branch.main.toLowerCase()) {
      out.push(
        `branch.personal: ${JSON.stringify(personal)} is the same branch as branch.main, ignoring case; name a different one`,
      )
    }
  }
  if (recipe.pr !== undefined && !team) {
    out.push('pr: `pr:` is read only in team mode; delete it, or write `mode: team`')
  }
  if (team && wroteAgent && recipe.pr?.agent === undefined && !DiscussAgent.safeParse(recipe.runtime.agent).success) {
    out.push('pr.agent: `pr:` needs an agent that can run with no tools; name a `pr.agent`')
  }
  return out
}

/**
 * `runtime.tier` left the recipe (#1158, ADR 0127 §10), and is refused **before
 * the parse**: `runtime` is a plain `z.object`, so once the schema stops
 * declaring `tier` zod would drop it without a word, and a recipe that wrote
 * `tier: sandboxed` would run uncontained while its file said otherwise.
 *
 * The sentence is for the value, never only *delete the field*: `sandboxed`
 * asked for containment, and dropping it falls to no sandbox. Lingtai does not
 * rewrite the recipe.
 */
export function retiredTier(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const runtime = (raw as Record<string, unknown>)['runtime']
  if (typeof runtime !== 'object' || runtime === null || !('tier' in runtime)) return []
  const tier = (runtime as Record<string, unknown>)['tier']
  if (tier === 'sandboxed') {
    return [
      'runtime.tier: replace `runtime.tier: sandboxed` with `sandbox: { enabled: true, required: true }`: the same promise, contained or nothing runs',
    ]
  }
  if (tier === 'guarded') return ['runtime.tier: delete `runtime.tier`: failing closed is now always required']
  if (tier === 'open') {
    return ['runtime.tier: delete `runtime.tier`; a runtime that cannot fail closed is now refused rather than allowed']
  }
  return [
    'runtime.tier: delete `runtime.tier`: containment is the `sandbox` block, and failing closed is always required',
  ]
}

/**
 * `runtime.limits` is grouped as `run`, `attempt` and `ticket` (#1240, 0108 §8),
 * and the flat keys are refused **by name before the parse**, each sentence
 * naming where it went. Checked on the raw file rather than in the schema so the
 * old names never appear in the `Recipe` type: a reader still writing
 * `limits.rounds` fails typecheck instead of compiling against `undefined`.
 * Lingtai does not rewrite the file: `rounds` became two numbers, and only the
 * repository can say what it meant.
 */
export function retiredLimits(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const runtime = (raw as Record<string, unknown>)['runtime']
  if (typeof runtime !== 'object' || runtime === null) return []
  const limits = (runtime as Record<string, unknown>)['limits']
  if (typeof limits !== 'object' || limits === null) return []
  const out: string[] = []
  if ('rounds' in limits) {
    out.push(
      'runtime.limits.rounds: write `runtime.limits.attempt.refusalFixes` and ' +
        '`runtime.limits.attempt.conflictResolutions` (0108 §8): they are two bounds now',
    )
  }
  if ('restarts' in limits) {
    out.push('runtime.limits.restarts: write `runtime.limits.ticket.newAttempts` (0108 §8)')
  }
  for (const key of ['turns', 'wall', 'usd']) {
    if (key in limits) {
      out.push(`runtime.limits.${key}: write \`runtime.limits.run.${key}\` (0108 §8): the run's bounds are grouped`)
    }
  }
  return out
}

/**
 * Every top-level key `Recipe` does not declare, refused **by its own name**.
 *
 * `Recipe` is `z.object` and not `z.strictObject`, so a key it does not know is
 * **silently dropped** — and a repository that wrote `repair.maxAttempts: 3`
 * would go on running with `rounds`' default while its own file said otherwise.
 * That is the failure this project keeps finding under another name: a setting
 * present, believed, and not connected to anything (0016 §4).
 *
 * **The rule is the shape's and no longer a list** (`#247`). It was two cases,
 * `repair:` and `gates:`, each written out — and `gates:` is one of the four
 * retired words, so a list that spells it is a row in `doc/reference.md`'s
 * allowlist and the last thing standing between that table and empty. Reading
 * the keys off `Recipe.shape` refuses the same file and more: the name in the
 * message comes from the file rather than from this source, so `gate:`,
 * `gatess:` and every typo nobody thought of are named too.
 *
 * `repair:` keeps a sentence of its own because a name alone does not say where
 * `repair.maxAttempts` went. Refusing rather than migrating is deliberate: the
 * two old numbers do not add up to the new one (0039 §3), so only the
 * repository can say what it meant. A key with no sentence is told what a
 * recipe does declare, which is the answer for `gates:` as well: 0061 §1 says
 * `steps:` replaced it rather than renaming it, and promoting a block that held
 * five of the ten would leave the other five configured by nobody.
 */
export function unknownKeys(raw: unknown): string[] {
  if (typeof raw !== 'object' || raw === null) return []
  const declared = Object.keys(Recipe.shape)
  return Object.keys(raw)
    .filter((key) => !declared.includes(key))
    .map((key) =>
      key === 'repair'
        ? 'repair: retired by ADR 0039 — `repair.maxAttempts`, `repair.fix` and `repair.on` ' +
          'are now `runtime.limits.attempt.refusalFixes`, beside `run.turns` and `run.wall`. ' +
          '`repair.on: false` is `refusalFixes: 0`. Delete the `repair` block and say what this ' +
          'repository wants an attempt to spend; the two old ceilings do not add up to the new one, ' +
          'so Lingtai will not guess'
        : `${key}: a recipe has no such key, and nothing read it — a recipe declares ` +
          `${declared.join(', ')}. Nothing here was applied; move the block under the key ` +
          'that does run it, or delete it',
    )
}

/**
 * The comparison nothing was making: does the recipe read from a ref name that
 * same ref as the branch it governs?
 *
 * Two different branches were both called "the base". `resolveRecipe` reads from
 * one — the branch recorded at `lingtai add` — and `branchOf` inside the file
 * it returns names another, which is what the worktree is cut from and what the
 * merge goes back into. When they disagree the run is right about everything
 * except the rules: it merges into `branchOf`'s branch under steps read from somewhere
 * else. A `human:` action at `merge` declared on one branch and not the other is
 * then a control that is declared and does not run.
 *
 * No audit after the fact can see that. `StepsResolved` is written from the same
 * recipe the run obeyed and carries that recipe's hash, so plan and execution
 * agree perfectly; it is the plan's *origin* that is wrong. Only this comparison,
 * made before anything is claimed, catches it — see
 * doc/decisions-archive/0005-config-in-target-repo.md, which assumed one base.
 *
 * Returns the refusal rather than throwing, and never repairs: every caller says
 * it in its own vocabulary — a refused run stage, a failed onboarding, a red
 * doctor check — and none of them may pick a winner between the two branches.
 */
export function baseDivergence(resolved: ResolvedRecipe, slug: string): string | null {
  const declared = branchOf(resolved.recipe)
  if (declared === resolved.ref) return null
  return (
    // The key `branchOf` reads, by mode: `branch.personal` in team, `branch.main` in solo.
    `recipe read from ${resolved.ref} declares ${branchKeyOf(resolved.recipe)}: ${declared} — ` +
    'the rules and the merge target are different branches. ' +
    `Re-register: lingtai add ${slug} --main ${declared}`
  )
}
