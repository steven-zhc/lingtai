import type { Step } from '@lingtai/domain'

// Pure and free of server modules: the last-event line is a client component (#918).

/** What the page needs to say when the attempt last did anything, and whether it may be stuck (#918). */
export interface RunningWatch {
  runId: string
  /** The newest envelope on the attempt's stream, in the Events list's own words. */
  lastEvent: { at: string; sentence: string } | null
  /** The phase in flight: when it began and its own wall limit. Null between steps. */
  phase: { since: string; budgetMs: number | null } | null
  /** The step in flight. Null between steps. */
  step: Step | null
}

/**
 * How long an implement step or a fix round may append nothing before the page
 * says so. **A chosen default, not a measurement**: a later ticket sets it from
 * the gap between consecutive events on real attempts.
 */
export const QUIET_AFTER_MS = 20 * 60_000

/** Grace past a phase's limit: the conductor enforces the limit itself, so a little lateness is its own cleanup. */
export const OVERDUE_GRACE_MS = 60_000

export type Stuck =
  /** Nothing is writing the attempt's run log, so the conductor running it has stopped. */
  | { kind: 'unwritten' }
  /** The phase ran past its limit, which the conductor enforces. */
  | { kind: 'overdue'; overMs: number; budgetMs: number }
  /** An implement step or fix round recorded nothing. */
  | { kind: 'quiet'; quietMs: number }

/**
 * Whether the attempt may be stuck, and why. Pure, so the client can run it each
 * second: the page re-renders on an append and a stuck attempt appends nothing.
 *
 * `writing` is the run log file's holder (#132), never what the file says
 * (0111 §13). **Review, design, a judge and every command step append nothing
 * until they end**, so only an implement step can be `quiet`.
 */
export function stuckOf({
  now,
  watch,
  writing,
}: {
  now: number
  watch: RunningWatch
  writing: boolean | null
}): Stuck | null {
  if (writing === false) return { kind: 'unwritten' }
  const phase = watch.phase
  if (phase !== null && phase.budgetMs !== null) {
    const over = now - Date.parse(phase.since) - phase.budgetMs
    if (over > OVERDUE_GRACE_MS) return { kind: 'overdue', overMs: over, budgetMs: phase.budgetMs }
  }
  if (watch.step === 'implement' && watch.lastEvent !== null) {
    const quiet = now - Date.parse(watch.lastEvent.at)
    if (quiet >= QUIET_AFTER_MS) return { kind: 'quiet', quietMs: quiet }
  }
  return null
}
