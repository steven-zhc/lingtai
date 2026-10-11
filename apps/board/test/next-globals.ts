/**
 * #454: puts the whole `@lingtai/actions` barrel into a program that also has
 * Next's globals, on purpose. `tsconfig.json`'s `include` picks this up but no
 * vitest glob ever runs it as a test (`vitest.config.ts:72`), so it costs
 * nothing except the type check this file exists to force. A type-only
 * re-export has no runtime cost and nothing reaches the Next bundle.
 *
 * Without it, whether `command.ts` is in this program depends on whichever
 * other file happens to reach the barrel today — which is how this bug hid
 * three times (#454).
 */
export type { RunCommandOptions } from '@lingtai/actions'
