/**
 * The built-in judges' predicate. The list itself is a leaf in `@lingtai/domain/judges`, the one import here.
 *
 * `settings.ts` is read by the board's wizard, which is a client component, and
 * a value imported from `recipe.ts` drags `@lingtai/env` and its `node:fs` into
 * the browser bundle — the release build failed on exactly that. `recipe.ts`
 * re-exports all of this, so nothing importing it from there changes.
 */

import { BUILT_IN_JUDGES, type BuiltInJudge } from '@lingtai/domain/judges'

export { BUILT_IN_JUDGES, type BuiltInJudge }

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
