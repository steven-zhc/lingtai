/**
 * The queue action: **the ticket a pass is about, taken — as a plugin rather
 * than as a step's body**
 * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §2, `#269`).
 *
 * `queuePlugin` had been in the closed set since the twelve were named and
 * nothing read it: four fields, an `at` of `{}`, and a `CALLED_DIRECTLY` entry
 * saying *the queue asks GitHub itself, before a pass exists to have steps*. Half
 * of that is still true — `selectRunnable` in `packages/conductor/src/queue.ts`
 * is what decides which issue a run is pointed at, and no step is involved — and
 * the half this file removes is *no step reads it*: `claim` re-reads the offer for
 * that one issue and appends the claim, and this is the action that does it.
 *
 * **It is the last of 0061 §3's five names to become a key, and the one that can
 * be quietly wrong.** A broken `build` goes red and a broken `admit` starts
 * nothing; a broken `claim` takes the wrong ticket, or takes none and reads
 * exactly like a machine with nothing to do. So the four values are read off the
 * action and **never off the recipe on the far side of `deps.take`** — `queueOf`
 * in `@lingtai/recipe` is what a caller with only a recipe asks, and `defaultsAt`
 * in `conduct.ts` is where it asks it, so *the default take* and *a pasted block
 * that says what the default did* select over the same four values.
 *
 * **It runs before there is a work item**, which is what makes it unlike every
 * other kind: `ActionContext.onSha` is the base the pass came in on, `cwd` is a
 * directory nothing has cut yet, and there is no item for `evidence` to be about
 * until this action has one. Nothing here reads any of them.
 *
 * **It cannot refuse**, and 0058 §2 is why rather than an omission: a refusal
 * buys a fix round, holds the work item and reaches a person, and a `claim` that
 * took nothing is holding nothing and has no diff to fix. `claim` is not one of
 * `REFUSING_STEPS`, so the `failed` verdict the three declines carry is read by
 * `endingOf` as a `did-not-finish` — no round bought, no route, and the pass
 * stops. What travels with it is `because`, for the reason the merge lane's does:
 * the three are unlike outcomes that the caller must tell apart by reading a
 * field rather than a sentence (0031 §1), and `conduct.ts` gives back an item it
 * *may* hold on exactly one of them.
 *
 * **It wraps and does not reimplement.** The selection is `runnableNow` and
 * `considerIssue`'s, in `packages/conductor/src/discover.ts`, and the taking is
 * `claimWorkItem`'s append at an expected version, which is the whole of the
 * mutual exclusion (`claim.ts`); the caller hands both over as
 * `QueueActionDeps.take` for the reason `worktree:` is handed the cut — only a
 * caller with a GitHub client and a store under it can build one, and an action
 * built without one is refused by name rather than quietly claiming nothing
 * (`from-recipe.ts`).
 */
import type { QueueSettings } from '@lingtai/recipe'

import type { Action, ActionContext, ActionResult } from './action.ts'

/**
 * What the take answered — four branches, and the fourth is why there are not
 * three.
 *
 * `claimWorkItem` appends at an expected version and answers a `ConcurrencyError`
 * with `lost-race`; every other failure of that append **throws**, and an append
 * that committed and then lost its connection throws the same way. So there is a
 * state in which the item is held by this run and the take has no result to show
 * for it, and the only honest answer is to name the item: `mayHold` is that, and
 * the caller gives back something this run may be holding.
 */
export type TakeAnswer =
  /** Taken — the stream it was claimed on, and which kind the recipe matched it as. */
  | { readonly taken: { readonly workItemId: string; readonly kind: string } }
  /**
   * GitHub is no longer offering it, with `considerIssue`'s own reason —
   * `excluded-label`, `blocked-by`, `assigned-elsewhere`. Asked rather than
   * looked up, because nothing was appended when the issue was first seen
   * ([0012](../../../doc/decisions-archive/0012-one-task-view.md)) and a label edit takes
   * effect through this read or through nothing.
   */
  | { readonly passedOver: string }
  /**
   * Somebody else holds it, or this append lost the race — `ClaimRefusal`, and
   * losing is an ordinary outcome of two schedulers reading one queue.
   */
  | { readonly notClaimed: string }
  /** The append may have committed. Named, so the caller can give it back. */
  | { readonly mayHold: { readonly workItemId: string; readonly detail: string } }

/**
 * The take, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `WorktreeActionDeps` and `MergeActionDeps` and a reader meets one convention.
 */
export interface QueueActionDeps {
  /**
   * The four values are an argument and not something the far side re-reads.
   *
   * `backoff` is on the block and is not read at `claim`: how long a failed
   * attempt keeps its own ticket out of the queue is the queue pass's question,
   * and the queue pass runs before any pass exists (0028, `selectRunnable`). It
   * travels because the four answer one question and the block is the unit
   * (0063 §3) — a `queue:` that could be written with three fields at the step
   * and a fourth somewhere else would be the second home that rule removed.
   */
  take(spec: QueueSettings): Promise<TakeAnswer>
}

export interface QueueActionSpec extends QueueSettings {
  name: string
}

export function createQueueAction(spec: QueueActionSpec, deps: QueueActionDeps): Action {
  const { name, ...queue } = spec
  return {
    name,
    kind: 'queue',

    async run(_context: ActionContext): Promise<ActionResult> {
      const answer = await deps.take(queue)
      if ('taken' in answer) {
        return {
          verdict: 'passed',
          evidence: `${answer.taken.workItemId} claimed as a ${answer.taken.kind}`,
          findings: [],
        }
      }
      if ('mayHold' in answer) {
        return {
          verdict: 'failed',
          // The item by name, because the caller has to be able to give back
          // something this run may be holding, and `detail` one layer up is this.
          evidence: `${answer.mayHold.workItemId} may be claimed by this run: ${answer.mayHold.detail}`,
          findings: [],
          because: 'claim-unconfirmed',
        }
      }
      // Two tokens rather than one, because they clear differently: an issue
      // GitHub passed over comes back when a label or a blocker changes, and one
      // somebody else holds comes back when that run ends.
      return 'passedOver' in answer
        ? { verdict: 'failed', evidence: answer.passedOver, findings: [], because: 'passed-over' }
        : { verdict: 'failed', evidence: answer.notClaimed, findings: [], because: 'not-claimed' }
    },
  }
}
