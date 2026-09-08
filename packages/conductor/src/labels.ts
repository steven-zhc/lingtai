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
 * ([0022](../../../doc/decisions/0022-the-seams.md)). The impure half is over
 * there: taking the union with whatever labels somebody else put on the issue
 * needs GitHub's current state, and a decision must not.
 *
 * Two labels, deliberately. They say what *Lingtai* is doing; everything else
 * on an issue is somebody else's and is left alone.
 */

import type { LabelState } from "@lingtai/domain";

/** Every label Lingtai owns starts with this. Everything else is somebody else's. */
export const LINGTAI_LABEL_PREFIX = "lingtai:";

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
    case "running":
    case "gates":
      return [`${LINGTAI_LABEL_PREFIX}working`];
    case "waiting":
      return [`${LINGTAI_LABEL_PREFIX}waiting`];
    default:
      return [];
  }
}

/** Somebody else's labels, which a whole-set write must not drop. */
export function foreignLabels(current: readonly string[]): string[] {
  return current.filter((l) => !l.startsWith(LINGTAI_LABEL_PREFIX));
}
