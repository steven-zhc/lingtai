/**
 * Which of Lingtai's own labels an issue should carry, given a work item's
 * state.
 *
 * This is the whole definition of what GitHub ought to look like, which is what
 * makes it worth its own file: `reconcile` converges against it, and a
 * converger with no statement of the target is just a retry loop with better
 * manners.
 *
 * It is a **decision** — state in, label set out, no I/O — which is why it
 * lives here and not in `@lingtai/github`
 * ([0022](../../../doc/decisions-archive/0022-the-seams.md)). The impure half is over
 * there: taking the union with whatever labels somebody else put on the issue
 * needs GitHub's current state, and a decision must not.
 *
 * Two labels, deliberately. They say what *Lingtai* is doing. Lingtai owns the
 * labels it computes (`OWN_LABELS`); any other label, `lingtai:`-prefixed or
 * not, is somebody else's and is left alone.
 */

import { LABEL_STATES, type LabelState } from '@lingtai/domain'

/** The prefix of Lingtai's own label names — and of the ones a person sets to steer it, which are not Lingtai's to drop. */
export const LINGTAI_LABEL_PREFIX = 'lingtai:'

/** The label a person sets to keep agents off a ticket — also what Lingtai writes on an accepted finding. Not in `OWN_LABELS`: it is never computed. */
export const HOLD_LABEL = `${LINGTAI_LABEL_PREFIX}hold`

/** The label an agent opens out-of-scope work under. Not in `OWN_LABELS`. */
export const FOLLOWUP_LABEL = `${LINGTAI_LABEL_PREFIX}followup`

/**
 * The label set a task's state implies.
 *
 * Computed, so it cannot contradict itself. `--add-label` is set *union* rather
 * than a transition, which is how #35 came to carry `agent:blocked` and
 * `agent:review` at the same time with nothing able to notice; a state that is
 * computed and then assigned whole cannot hold two contradictory values.
 */
export function labelsFor(state: LabelState): string[] {
  switch (state) {
    case 'running':
    case 'verifying':
    case 'approved':
      return [`${LINGTAI_LABEL_PREFIX}working`]
    case 'waiting':
      return [`${LINGTAI_LABEL_PREFIX}waiting`]
    default:
      return []
  }
}

/** Every label `labelsFor` can produce, derived so it cannot drift from it. */
export const OWN_LABELS: ReadonlySet<string> = new Set(LABEL_STATES.flatMap((s) => labelsFor(s)))

/** Somebody else's labels — anything not in `OWN_LABELS` — which a whole-set write must not drop. */
export function foreignLabels(current: readonly string[]): string[] {
  return current.filter((l) => !OWN_LABELS.has(l))
}
