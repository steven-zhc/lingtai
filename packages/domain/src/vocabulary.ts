/**
 * Leaf vocabulary: zod and nothing else.
 *
 * `events.ts` and the leaf modules both need `Step`, `RefusalReason`, the run-failure
 * kinds and `Finding` (#445). A module that imports
 * `events.ts` and is imported back by it is an ESM cycle: Node throws a
 * `ReferenceError` on load rather than resolving the two in either order. So
 * the shared pieces live here, where nothing is imported but `zod`, and both
 * `events.ts` and the leaves import from here instead of from each other.
 *
 * `events.ts` re-exports every name below, so no existing importer of it
 * changes.
 */
import { z } from 'zod'

/**
 * The ten steps a pass goes through, in the order it reaches them.
 *
 * See `events.ts`'s own doc comment on the re-exported `Step` for the full
 * history — moved here rather than duplicated, because this is the one copy.
 */
export const Step = z.enum([
  'claim',
  'admit',
  'prepared',
  'design',
  'implement',
  'build',
  'review',
  'proposed',
  'merge',
  'end',
])
export type Step = z.infer<typeof Step>

/**
 * The ten, in the order the loop reaches them.
 *
 * Exported as a tuple because "every step, in order" is a thing several places
 * need to iterate — `StepsResolved`, the board, `lingtai add` — and each writing
 * its own list is how one of them ends up missing a step and nobody notices.
 */
export const STEPS = Step.options

/**
 * Why an integration did not happen. Every one of these was a silent
 * `return 1` in the old loop's `integrate()` — no log line, no comment, no
 * label, and five re-runs of the same ticket before anyone noticed.
 *
 * See `events.ts`'s re-export for the per-value history.
 */
export const RefusalReason = z.enum([
  'conflict',
  'dirty-base',
  'unpushed-base',
  'pending-migration',
  'verify-failed',
  'no-commits',
  'push-rejected',
  'lane-busy',
  'unexpected',
  // A commit a stopped run's own conductor made, found on the branch the lane
  // is about to merge — never a judgement about the branch itself (#468).
  'wip-commit',
  // The base moved on files the branch also changed since it was reviewed, and
  // the trial merge was clean: the lane does not land, the pass merges the base
  // in itself and builds and reviews again (#593). Nothing is wrong with the branch.
  'base-moved',
  // The base branch refused the lane's direct push because it is protected —
  // a setting on the repository, which only a person can change (#662).
  'base-protected',
])
export type RefusalReason = z.infer<typeof RefusalReason>

/**
 * The subject line a WIP commit carries, and the one thing that marks it as
 * one — `conduct.ts`'s `keepUncommittedWork` writes it, and `integrate.ts`'s
 * lane guard refuses anything that starts with it (#468). One constant so the
 * two can never name it differently; `@lingtai/repo` cannot hold it because
 * `conduct.ts` imports *types* only from that package (`live.ts`).
 *
 * **A fixed literal, not built from `PASS_STREAM_PREFIX`.** A human or an
 * agent setting aside its own work with `git commit -m "wip: partial
 * refactor"` must never be caught by this, so the prefix cannot be the bare
 * `wip: ` — and it cannot follow `runId`'s own prefix either, which moved from
 * `run-` to `pass-` at #464's reset. A branch an agent cut before that reset
 * can still carry a WIP commit spelled the old way, and `integrate.ts`'s lane
 * guard must keep refusing it after the reset as surely as before — so this
 * stays `'wip: run-'` forever, independent of what a current `runId` starts
 * with.
 */
export const WIP_COMMIT_PREFIX = 'wip: run-'

/**
 * Additive to the enum. No stored event is rewritten and no version is
 * bumped — every payload a previous build wrote still parses against this.
 *
 * See `events.ts`'s re-export for the per-value history.
 */
export const RUN_FAILURE_KINDS = [
  'timeout',
  'crash',
  'no-commits',
  'aborted',
  'never-started',
  'out-of-turns',
  'no-structured-answer',
  'out-of-usd',
] as const

export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number]

/**
 * The three severities a reviewer may raise, in the order the rubric compares
 * them — *at or below the bar* is a comparison of positions in this list.
 *
 * See `events.ts`'s re-export for the full history.
 */
export const SEVERITIES = ['blocker', 'major', 'minor'] as const
export type Severity = (typeof SEVERITIES)[number]

/**
 * One finding, as a reviewer reported it.
 *
 * See `events.ts`'s re-export for the full history.
 */
export const Finding = z.object({
  file: z.string(),
  line: z.number().int().nullable(),
  claim: z.string(),
  /** No failure scenario, no finding. An observation without one is an opinion. */
  failureScenario: z.string(),
  severity: z.enum(SEVERITIES),
  /**
   * How the diff makes code it did not touch reachable (#670). Present, a
   * finding outside every hunk is not demoted to a pre-existing minor.
   */
  reachableBecause: z.string().optional(),
})
export type Finding = z.infer<typeof Finding>
