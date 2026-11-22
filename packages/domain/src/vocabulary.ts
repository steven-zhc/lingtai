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
  // Kept because rows on the log carry it; nothing writes it since #1243, which
  // made the lane land a branch with WIP commits on it (0108 §20).
  'wip-commit',
  // The base moved since the branch forked, and the trial merge was clean: the
  // lane does not land a tree no step ran on. The pass merges the base in itself
  // and builds again; review runs again only when the move touched files the
  // branch changed (#593, #1210). Nothing is wrong with the branch.
  'base-moved',
  // The base branch refused the lane's direct push because it is protected —
  // a setting on the repository, which only a person can change (#662).
  'base-protected',
  // The base is checked out in the local, non-bare remote the lane would push to,
  // which git refuses; held for a person before anything is fetched or pushed (0104 §15).
  'base-checked-out',
  // Git could not reach origin for the fetch or push, after the lane's own tries —
  // nothing about the branch was judged, and a rule re-runs the land first, up to
  // `landingRetries` times (#1221), before approve re-runs only the land (#1029).
  'unreachable',
  // GitHub answered the push with a 5xx and kept answering it through the lane's own
  // tries — nothing about the branch or the base was judged, and a rule re-runs the land first, up to
  // `landingRetries` times (#1221), before approve re-runs only the land (#1125).
  'remote-error',
  // The branch on origin is not the commit the steps passed on — the lane refuses before
  // merging anything, and never retries it: a person requeues from the base.
  'head-moved',
  // A `lingtai:pr-fix` landing found the PR's branch somewhere other than where Lingtai last pushed it — somebody
  // pushed to it on the code host. Refused before anything is merged or pushed, for a person (0130 §5, #1341).
  'pr-branch-moved',
])
export type RefusalReason = z.infer<typeof RefusalReason>

/**
 * The subject line a WIP commit carries — `conduct.ts`'s `keepUncommittedWork`
 * writes it (#468). It names the commit for a person reading `git log`; **code
 * tells a WIP from the agent's own by the sha on `RunKeptUncommitted`, never by
 * this message** (0108 §20), and the lane no longer reads it (#1243).
 *
 * **A fixed literal, not built from `ATTEMPT_STREAM_PREFIX`**, so a WIP made
 * before #464's reset (when `runId`'s prefix moved from `run-` to `pass-`) is
 * spelled the same as one made after — this stays `'wip: run-'` forever.
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
  /** The class of mistake, where the same one could occur elsewhere in the diff (#672). Absent on old events. */
  class: z.string().optional(),
})
export type Finding = z.infer<typeof Finding>
