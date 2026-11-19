/** See `JudgeName` in `recipe.ts` for what the list means and why it is this short. */
export const BUILT_IN_JUDGES = ['same-worktree', 'merge-the-base', 'check-the-evidence'] as const
export type BuiltInJudge = (typeof BUILT_IN_JUDGES)[number]
