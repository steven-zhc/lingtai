import { passCeiling } from "@lingtai/conductor";
import { LIMIT_DEFAULTS, parseDuration } from "@lingtai/recipe";

/**
 * What a drain may cost, said before the waiting starts.
 *
 * Not read from a recipe: the drain belongs to the installation and the limit
 * belongs to whichever project happens to be running — so this names where the
 * numbers live and what the schema defaults to, rather than a number that would
 * be wrong for every project but one.
 *
 * **Computed rather than written down** ([0039](../../../doc/decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3).
 * This sentence used to say `runtime.limits.wall (2h by default)`, which was
 * true when it was written and false once a pass could buy more than one agent
 * run — a sentence in `apps/cli` chasing a number in `packages/recipe`, with
 * nothing between them to notice. It is now made out of `LIMIT_DEFAULTS`, so the
 * only way to make it wrong is to change the schema and the sentence together.
 *
 * Its own module because two commands wait on the same drain — `lingtai
 * shutdown` says how long it may take, and `lingtai restart` waits it out
 * ([0042](../../../doc/decisions/0042-the-restart-is-a-command.md)) — and two
 * sentences about one limit are one sentence too many.
 */
export const WALL_LIMIT = `the recipe's runtime.limits — by default, ${passCeiling({
  ...LIMIT_DEFAULTS,
  wallMs: parseDuration(LIMIT_DEFAULTS.wall),
})}`;
