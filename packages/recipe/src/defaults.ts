import type { Step } from '@lingtai/domain'

/**
 * The name of the action each step runs where the recipe declares nothing
 * (0065 §2: *a default replaces what would have run*). `conduct.ts`'s
 * `defaultsAt` builds the action under this name; the board reads the same
 * table to draw the plan, so the two cannot drift.
 *
 * Imported by the board as `@lingtai/recipe/defaults`, never from the package
 * root: this file imports a type and nothing else, so a client component that
 * reaches it does not drag `@lingtai/env` and its `node:fs` along (#164).
 */
export const DEFAULT_ACTION = {
  claim: 'take the ticket',
  admit: 'cut the branch',
  implement: 'write the change',
  merge: 'land the branch',
} as const satisfies Partial<Record<Step, string>>

/**
 * The action names a step will run: what the recipe declared, or — where it
 * declared nothing and the step has a default — that default's name.
 */
export function plannedAt(step: Step, declared: readonly string[]): readonly string[] {
  if (declared.length > 0) return declared
  const fallback = (DEFAULT_ACTION as Partial<Record<Step, string>>)[step]
  return fallback === undefined ? [] : [fallback]
}
