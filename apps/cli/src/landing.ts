/**
 * `lingtai add`'s setup questions (#399): land on a branch or hold every pass,
 * then the limits — refusal fixes, conflict resolutions, wall, and a spend ceiling in money.
 *
 * Asked before `add()` runs, never inside it (`onboard.ts`'s `add` has a
 * second caller, the board's Recheck, which must never ask a question), and
 * only when the project's recipe file already exists — `add()`'s own refusal
 * speaks for an absent one, and nothing here seeds a file that cannot resolve
 * on its own (#395).
 *
 * Each answer is one `setRecipe` call, written the moment it is given (#392
 * decision 1, #391 — *a Ctrl+C keeps what was answered*). The pure half of
 * each write — the answer turned into `RecipeChange[]` — is `@lingtai/recipe`'s
 * `answers.ts`, so the conductor's own test can apply the same change set and
 * prove it holds or lands a pass, not only that it resolves.
 */
import { paint } from '@lingtai/env/colour'
import { type RecipeDraft, recipePath } from '@lingtai/project'
import {
  type Recipe,
  type RecipeChange,
  type SetRecipeResult,
  baseOf,
  budgetChange,
  ceilingOf,
  holdRemovalChanges,
  landOnBranchChanges,
  landingChanges,
  parseDuration,
  resolveSource,
  conflictResolutionsChange,
  refusalFixesChange,
  wallChange,
} from '@lingtai/recipe'
import { Effect } from 'effect'

import { lift, recovering } from './exit.ts'
import { type QuestionWorld, questionEffect } from './question.ts'
import { ROUNDS_RETIRED } from './wizard-options.ts'

export interface LandingDeps {
  home?: string
  /** The recipe the answers so far have drafted. */
  draft: RecipeDraft
  /**
   * The repository's default branch — asked only when nothing else answers
   * it: no flag, and the file's own base is a blank `repo.base: ""` rather
   * than a real branch.
   */
  defaultBranch: () => Promise<string | null>
  /** `question.ts`'s `kept` — what a refusal below says is already written. */
  kept?: string
}

type Answered = { ok: true } | { refused: string }

/**
 * `setRecipe` throws — `RecipeInvalidError` on a narrowing or schema refusal,
 * or on a change it cannot carry onto the file exactly — rather than returning
 * a refusal, so every call site here must catch it and hand the message back
 * as `{refused}` the same way `question()`'s own refusals are returned. Left
 * uncaught, the answers already written stay on disk while the one that threw
 * never reaches the terminal to be asked again (#399).
 */
function setRecipeOrRefuse(
  changes: readonly RecipeChange[],
  options: { draft: RecipeDraft },
): Effect.Effect<SetRecipeResult | { refused: string }> {
  return options.draft.set(changes).pipe(recovering((err) => Effect.succeed({ refused: (err as Error).message })))
}

function resolvedFile(
  project: string,
  options: { home?: string; draft: RecipeDraft },
):
  | {
      text: string
      recipe: Recipe
      proposed: readonly Record<string, unknown>[]
      admit: readonly Record<string, unknown>[]
      base: string
      limits: ReturnType<typeof ceilingOf>
      agent: string
    }
  | { refused: string } {
  const path = recipePath(project, options.home)
  const text = options.draft.text()
  if (text === null) return { refused: `no recipe at ${path} — lingtai add reads this project's own refusal for that` }
  let resolved
  try {
    resolved = resolveSource(text, path, path)
  } catch (err) {
    return { refused: (err as Error).message }
  }
  return {
    text,
    recipe: resolved.recipe,
    proposed: resolved.recipe.steps.proposed,
    admit: resolved.recipe.steps.admit,
    base: baseOf(resolved.recipe),
    limits: ceilingOf(resolved.recipe),
    agent: resolved.recipe.runtime.agent,
  }
}

/** The recipe's `runtime.limits.run.usd` is written, but only claude-code enforces it. */
export function dollarCeilingNote(named: unknown): string {
  return typeof named === 'string'
    ? `${named} cannot hold a dollar ceiling on one run — runtime.limits.run.usd is written, and reported absent at that runtime`
    : 'only claude-code holds a dollar ceiling on one run, and this recipe names no runtime.agent — runtime.limits.run.usd is written, and holds only where claude-code is the runtime that runs'
}

const WAIT = 'wait for me to approve'
const LAND = 'land it without asking'

/**
 * **Land on a branch, or hold every pass for a person** — `--land <branch>|hold`.
 *
 * At a terminal it is one choice — "when a pass is ready": wait for me to
 * approve / land it without asking — defaulting to *wait* when the resolved
 * recipe already carries a `human:` at `proposed`, else *land*. *Land* is on
 * the recipe's base and never changes it: only the hold is removed, and the
 * repository's default branch is asked only when the file's base is blank.
 * `--land <branch>|hold` bypasses the choice (a branch is not one of its
 * choices) and is written as `landingChanges` writes it, at `baseWrittenAt`.
 *
 * `landingChanges` is handed `steps.proposed`/`steps.admit` as the file
 * itself writes them (`readRecipeKey`), not the resolved, schema-defaulted
 * version — so an entry the file already wrote tersely is carried back
 * exactly as written, instead of pinning every field the schema would have
 * filled in for it. Only where the file writes nothing there at all (the
 * step is inherited whole from a preset) does the resolved list stand in,
 * so a step `extends:` supplies is not dropped.
 */
export const askLanding = Effect.fn('landing.askLanding')(function* (
  world: QuestionWorld,
  project: string,
  land: string | null,
  deps: LandingDeps,
): Effect.fn.Return<Answered, unknown> {
  const options = { home: deps.home, draft: deps.draft }
  const file = resolvedFile(project, options)
  if ('refused' in file) return file

  const currentlyHolds = file.proposed.some((action) => 'human' in action)
  const rawProposed = () => options.draft.get(['steps', 'proposed'])
  const rawAdmit = () => options.draft.get(['steps', 'admit'])

  let changes: ReturnType<typeof landingChanges>
  if (land !== null) {
    // A flag is run through `question()` with no `choices`: `--land main` is a
    // branch, which the two phrases below would refuse as "not one of …".
    const result = yield* questionEffect(world, {
      name: 'the landing',
      flag: '--land <branch>|hold',
      given: land,
      prompt: 'land this on which branch, or "hold" to hold every attempt for a person',
      current: null,
      detected: null,
      validate: (answer) => Effect.succeed(answer.trim() === '' ? 'needs a branch name, or "hold"' : null),
      kept: deps.kept,
    })
    if ('refused' in result) return result
    const proposed = rawProposed()
    const admit = rawAdmit()
    changes = landingChanges(
      { land: result.answer },
      Array.isArray(proposed) ? proposed : file.proposed,
      Array.isArray(admit) ? admit : file.admit,
    )
  } else {
    const result = yield* questionEffect(world, {
      name: 'the landing',
      flag: '--land hold (wait for me to approve) or --land <branch> (land on that branch)',
      given: null,
      prompt: 'when an attempt is ready',
      choices: [WAIT, LAND],
      current: currentlyHolds ? WAIT : LAND,
      detected: null,
      kept: deps.kept,
    })
    if ('refused' in result) return result
    const proposed = rawProposed()
    const admit = rawAdmit()
    const rawP = Array.isArray(proposed) ? proposed : file.proposed
    const rawA = Array.isArray(admit) ? admit : file.admit
    if (result.answer === WAIT) {
      changes = landingChanges({ land: 'hold' }, rawP, rawA)
    } else if (file.base !== '') {
      // Landing on the base the recipe resolves must not pin it: keep only the
      // hold's removal, never a `repo.base` the file did not say.
      changes = holdRemovalChanges(rawP)
    } else {
      const base = yield* lift(() => deps.defaultBranch())
      if (base === null) {
        return {
          refused: `no base branch to land on — pass --land <branch>. ${deps.kept ?? 'Nothing was written'}`,
        }
      }
      changes = landOnBranchChanges(base, rawP, rawA)
    }
  }
  const hadSteps = options.draft.get(['steps']) !== null
  const written = yield* setRecipeOrRefuse(changes, options)
  if ('refused' in written) return written
  if (written.written && !hadSteps && changes.some((c) => c.path[0] === 'steps')) {
    world.log(
      paint.muted(
        `${recipePath(project, deps.home)} had no steps: of its own — writing steps.proposed pins every other ` +
          'step this file was inheriting from its preset, in the file, alongside it',
      ),
    )
  }
  return { ok: true }
})

/** `--budget`'s "none", parsed the way the question accepts `5`, `5.00` and `$5`. */
function parseBudget(answer: string): number | null | string {
  if (answer.trim().toLowerCase() === 'none') return null
  const n = Number(answer.trim().replace(/^\$/, ''))
  if (!Number.isFinite(n) || n <= 0) {
    return 'that is not a dollar amount — write a positive number like 5 or 5.00, or "none" for no ceiling'
  }
  return n
}

export interface LimitsFlags {
  /** Refused by name: it became two bounds (0108 §8). */
  rounds?: string
  refusalFixes?: string
  conflictResolutions?: string
  wall?: string
  budget?: string
}

/**
 * **The limits: refusal fixes, conflict resolutions, wall and a spend ceiling, each narrowed only when the
 * answer differs from what the recipe resolves to now** — pressing enter on
 * an inherited default must not pin it into the file (`write.ts`'s
 * `readRecipeKey` comment, #392).
 */
export const askLimits = Effect.fn('landing.askLimits')(function* (
  world: QuestionWorld,
  project: string,
  flags: LimitsFlags,
  options: { home?: string; draft: RecipeDraft; kept?: string },
): Effect.fn.Return<Answered, unknown> {
  const file = resolvedFile(project, options)
  if ('refused' in file) return file
  const { limits } = file

  if (flags.rounds !== undefined) {
    return {
      refused: ROUNDS_RETIRED,
    }
  }

  const refusalFixes = yield* questionEffect(world, {
    name: 'refusal fixes',
    flag: '--refusal-fixes <n>',
    given: flags.refusalFixes ?? null,
    prompt:
      'how many times an attempt sends the agent back after a build or review refuses it — ' +
      '0 buys no fix in the same worktree (a failed build then goes straight to you)',
    current: String(limits.attempt.refusalFixes),
    validate: (answer) => Effect.succeed(/^\d+$/.test(answer) ? null : 'that is not a whole number 0 or greater'),
    kept: options.kept,
  })
  if ('refused' in refusalFixes) return refusalFixes
  const refusalFixesValue = Number(refusalFixes.answer)
  if (refusalFixesValue !== limits.attempt.refusalFixes) {
    const written = yield* setRecipeOrRefuse([refusalFixesChange(refusalFixesValue)], options)
    if ('refused' in written) return written
  }

  const conflictResolutions = yield* questionEffect(world, {
    name: 'conflict resolutions',
    flag: '--conflict-resolutions <n>',
    given: flags.conflictResolutions ?? null,
    prompt:
      'how many times an attempt sends the agent back to resolve a merge conflict — ' +
      '0 buys no conflict resolution (a merge conflict then goes straight to you)',
    current: String(limits.attempt.conflictResolutions),
    validate: (answer) => Effect.succeed(/^\d+$/.test(answer) ? null : 'that is not a whole number 0 or greater'),
    kept: options.kept,
  })
  if ('refused' in conflictResolutions) return conflictResolutions
  const conflictResolutionsValue = Number(conflictResolutions.answer)
  if (conflictResolutionsValue !== limits.attempt.conflictResolutions) {
    const written = yield* setRecipeOrRefuse([conflictResolutionsChange(conflictResolutionsValue)], options)
    if ('refused' in written) return written
  }

  const wall = yield* questionEffect(world, {
    name: 'wall',
    flag: '--wall <duration>',
    given: flags.wall ?? null,
    prompt: 'what one agent run may take, like 30m or 2h',
    current: limits.run.wall,
    validate: (answer) =>
      Effect.sync(() => {
        try {
          return parseDuration(answer) > 0 ? null : 'must be a positive duration, like 30m'
        } catch {
          return 'that is not a duration like 30s, 15m or 2h'
        }
      }),
    kept: options.kept,
  })
  if ('refused' in wall) return wall
  if (wall.answer !== limits.run.wall) {
    const written = yield* setRecipeOrRefuse([wallChange(wall.answer)], options)
    if ('refused' in written) return written
  }

  const budget = yield* questionEffect(world, {
    name: 'the spend ceiling',
    flag: '--budget <dollars>|none',
    given: flags.budget ?? null,
    prompt: 'a dollar ceiling per agent run, like $5, or "none" for no ceiling',
    current: limits.run.usd === undefined ? 'none' : String(limits.run.usd),
    show: (value) => (value === 'none' ? 'none' : `$${Number(value).toFixed(2)}`),
    validate: (answer) => {
      const parsed = parseBudget(answer)
      return Effect.succeed(typeof parsed === 'string' ? parsed : null)
    },
    kept: options.kept,
  })
  if ('refused' in budget) return budget

  const usdValue =
    budget.answer.trim().toLowerCase() === 'none' ? null : Number(budget.answer.trim().replace(/^\$/, ''))
  if ((usdValue ?? null) !== (limits.run.usd ?? null)) {
    const written = yield* setRecipeOrRefuse([budgetChange(usdValue)], options)
    if ('refused' in written) return written
  }

  const after = resolvedFile(project, options)
  if ('refused' in after) return after
  // The runtime the file names, not `resolveSource`'s schema default: a recipe
  // naming none runs whichever runtime this machine detects (local.ts), which
  // may not be claude-code.
  const named = options.draft.get(['runtime', 'agent'])
  if (after.limits.run.usd !== undefined && named !== 'claude-code') {
    world.log(paint.muted(dollarCeilingNote(named)))
  }
  return { ok: true }
})
