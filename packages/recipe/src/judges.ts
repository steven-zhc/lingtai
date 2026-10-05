/**
 * The built-in judges, alone in a file with nothing to import.
 *
 * `settings.ts` is read by the board's wizard, which is a client component, and
 * a value imported from `recipe.ts` drags `@lingtai/env` and its `node:fs` into
 * the browser bundle — the release build failed on exactly that. `recipe.ts`
 * re-exports all of this, so nothing importing it from there changes.
 */

/** See `JudgeName` in `recipe.ts` for what the list means and why it is this short. */
export const BUILT_IN_JUDGES = ['same-worktree'] as const
export type BuiltInJudge = (typeof BUILT_IN_JUDGES)[number]

/**
 * Which half of `JudgeName` a name is — **a function rather than a comparison
 * anybody writes twice**.
 *
 * The distinction is what decides whether answering costs money, so it is read
 * off `BUILT_IN_JUDGES` in one place: a second built-in added to that list is
 * spending nothing here on the day it is added, and a hand-written
 * `name === "same-worktree"` somewhere else would be the cell that stayed a
 * dispatch.
 */
export function isBuiltInJudge(name: string): name is BuiltInJudge {
  return (BUILT_IN_JUDGES as readonly string[]).includes(name)
}
