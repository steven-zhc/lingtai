/**
 * Turning a setup answer into `RecipeChange[]` (#399, `emit.ts:64`).
 *
 * Pure — no terminal, no file — so `@lingtai/conductor`'s own test can apply a
 * change set with `setRecipe` and run a pass against it, pinning the claim
 * that what the CLI writes actually holds (or lands) a pass, and not only
 * that it resolves. `apps/cli/src/landing.ts` asks the questions and calls
 * `setRecipe`; this is the one place both of those tests import.
 */
import type { RecipeChange } from './emit.ts'

function isHumanEntry(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && 'human' in entry
}

function isWorktreeEntry(entry: unknown): entry is Record<string, unknown> & { worktree: Record<string, unknown> } {
  return typeof entry === 'object' && entry !== null && 'worktree' in entry
}

/** The one thing the setup's own hold says, quoted into the recipe. */
export const SETUP_HOLD_TEXT = "Land this? The setup was answered 'hold'."

/** `--land hold`, or `--land <branch>` (#392's seam). */
export type LandingAnswer = { land: 'hold' } | { land: string }

/**
 * The changes `--land` writes, from the answer and `currentProposed`/
 * `currentAdmit` — this function does not care whether either list is what
 * the file literally writes (`readRecipeKey`) or the resolved, schema-filled
 * version, only that it is a step neither of those is lost: the caller picks
 * the raw list where the file writes one of its own, and the resolved list
 * where it does not (a step inherited whole from a preset), so that an entry
 * already in the file is carried back exactly as written rather than pinned
 * with every schema default filled in (`apps/cli/src/landing.ts`). `null`
 * means `[]`.
 *
 * **`hold` never writes `steps.merge`, empty or otherwise.** An absent or
 * empty `merge:` still runs the default lane (`conduct.ts`'s `defaultsAt`),
 * and `humanPlugin` has not been legal there since `#270` — 0058 §3b gives
 * `merge` three ways out and only `proposed` may send one to a person. So a
 * hold is one entry appended to `steps.proposed`, and if one is there
 * already — the setup's own or a person's — nothing is added: a second hold
 * beside the first would be a second question about the same thing, and the
 * empty change set here is what makes `setRecipe` report `written: false`.
 *
 * **`<branch>` removes every `human:` entry at `steps.proposed`**, not only
 * the one this function would have written — a hand-written hold left behind
 * is still a hold every pass meets. `judge:` and `watch:` entries at the same
 * step are untouched.
 *
 * **`<branch>` writes the base where `baseWrittenAt` says it is read, not
 * always `repo.base`.** When one of `currentAdmit`'s actions carries a
 * `worktree:`, that is the entry `baseOf`/`baseWrittenAt`
 * (`settings.ts:222-245`) read the base from, and writing `repo.base`
 * instead would land on a key the conductor does not read. Absent that, the
 * base is `repo.base` as always.
 */
export function landingChanges(
  answer: LandingAnswer,
  currentProposed: readonly unknown[] | null,
  currentAdmit?: readonly unknown[] | null,
): RecipeChange[] {
  const proposed = currentProposed ?? []
  if (answer.land === 'hold') {
    if (proposed.some(isHumanEntry)) return []
    return [{ path: ['steps', 'proposed'], value: [...proposed, { name: 'hold every pass', human: SETUP_HOLD_TEXT }] }]
  }
  const withoutHold = proposed.filter((entry) => !isHumanEntry(entry))
  const admit = currentAdmit ?? []
  const worktreeIndex = admit.findIndex(isWorktreeEntry)
  const changes: RecipeChange[] =
    worktreeIndex === -1
      ? [{ path: ['repo', 'base'], value: answer.land }]
      : [
          {
            path: ['steps', 'admit'],
            value: admit.map((entry, i) =>
              i === worktreeIndex && isWorktreeEntry(entry)
                ? { ...entry, worktree: { ...entry.worktree, base: answer.land } }
                : entry,
            ),
          },
        ]
  if (withoutHold.length !== proposed.length) changes.push({ path: ['steps', 'proposed'], value: withoutHold })
  return changes
}

/** `runtime.limits.rounds` — how many times a pass sends the agent back. */
export function roundsChange(rounds: number): RecipeChange {
  return { path: ['runtime', 'limits', 'rounds'], value: rounds }
}

/** `runtime.limits.wall` — what one agent run may take. */
export function wallChange(wall: string): RecipeChange {
  return { path: ['runtime', 'limits', 'wall'], value: wall }
}

/**
 * `runtime.limits.usd` — never `runtime.budget`, which is 0029's prompt
 * budget (characters of evidence quoted), a different key this flag does not
 * touch (`recipe.ts:3194`). `null` removes the key — `value: undefined` is
 * `editRecipe`'s own spelling for that (`emit.ts:128`) — which is the write
 * `--budget none` makes: absent means no dollar ceiling, said rather than
 * assumed (`recipe.ts:3144-3146`).
 */
export function budgetChange(usd: number | null): RecipeChange {
  return { path: ['runtime', 'limits', 'usd'], value: usd === null ? undefined : usd }
}
