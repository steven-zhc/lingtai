/**
 * What `task_view`, the board and every other reader of `WorkItemBlocked`
 * folded before #445 — rebuilt from the `Hold` the event now carries, rather
 * than read off the payload directly.
 *
 * `WorkItemBlocked` stopped carrying `question`, `needsFrom`, `runId`,
 * `needs` and `diagnosis` once it carried `hold` (0118 §1), and every fold
 * that read one of those five fields would otherwise go blank or throw. This
 * is the one place that reconstructs them, so a fold calls `legacyColumns`
 * rather than growing its own reading of the union — #443 deletes this
 * function together with the columns it serves, once nothing needs them.
 *
 * **Not everything is reproduced exactly.** `diagnosis.what` used to open
 * with `` `${branch} is at ${sha.slice(0,7)} and ` `` and could end with
 * `` ` ${spent} of ${ceiling} rounds were spent.` `` — neither the branch's
 * head nor the round count is on a `Hold`, because 0118 §1 did not carry
 * them, and inventing a number the event never recorded would be worse than
 * the gap. `question` (the card's one line) is exact; `diagnosis.what` is the
 * same sentence with that prefix and suffix dropped.
 */
import { diagnoseRefusal } from './attribution.ts'
import type { BlockDiagnosis, BlockRecommendation } from './events.ts'
import type { Hold, RunRef } from './hold.ts'

export interface LegacyColumns {
  question: string
  runId: string | null
  asked: boolean
  needs: 'judgement' | 'acknowledgement'
  needsFrom: 'human' | 'external'
  diagnosis: BlockDiagnosis | null
}

const APPROVE_EVERY_STEP_PASSED: BlockRecommendation = {
  action: 'approve',
  why: 'every step passed on this diff; approving merges what this run produced',
}

function unpushedSuffix(run: RunRef): string {
  return run.unpushed === undefined ? '' : ` (and ${run.unpushed.branch} was not pushed: ${run.unpushed.said})`
}

function repairDone(run: RunRef): string | null {
  return run.repairOf !== undefined ? `a repair for ${run.repairOf} produced this diff` : null
}

/**
 * The `question`/`needs`/`diagnosis`/etc. a fold wrote before #445, read off
 * the `Hold` that replaced them.
 */
export function legacyColumns(hold: Hold): LegacyColumns {
  switch (hold._tag) {
    case 'Question':
      return {
        question: hold.question,
        runId: null,
        asked: true,
        needs: 'judgement',
        needsFrom: 'human',
        diagnosis: null,
      }

    case 'Asked':
      return {
        question: hold.question,
        runId: hold.run.runId,
        asked: false,
        needs: 'judgement',
        needsFrom: 'human',
        diagnosis: {
          what: hold.question,
          done: repairDone(hold.run),
          raw: hold.question,
          recommendation: null,
        },
      }

    case 'Human':
      return {
        question: hold.question + unpushedSuffix(hold.run),
        runId: hold.run.runId,
        asked: false,
        needs: 'judgement',
        needsFrom: 'human',
        diagnosis: {
          what: hold.question,
          done: repairDone(hold.run),
          raw: hold.question,
          // A `Human` carries no findings, unlike `Routed` — so unlike the
          // findings veto below, this cannot see one. 0118 §1's `merge` hold is
          // recommended `approve` regardless (`#445`'s design, "A `Human`
          // cannot see the findings veto; name that edge").
          recommendation: hold.step === 'merge' ? APPROVE_EVERY_STEP_PASSED : null,
        },
      }

    case 'Routed':
      return {
        question: hold.why + unpushedSuffix(hold.run),
        runId: hold.run.runId,
        asked: false,
        needs: 'judgement',
        needsFrom: 'human',
        diagnosis: {
          what: hold.why,
          done: repairDone(hold.run),
          raw: hold.raw,
          recommendation:
            hold.when === 'findings' && hold.findings.length === 0 ? APPROVE_EVERY_STEP_PASSED : null,
        },
      }

    case 'CheckRed':
    case 'DidNotFinish':
    case 'SetupRefused':
      return {
        question: hold.why + unpushedSuffix(hold.run),
        runId: hold.run.runId,
        asked: false,
        needs: 'acknowledgement',
        needsFrom: 'human',
        diagnosis: {
          what: hold.why,
          done: repairDone(hold.run),
          raw: hold.raw,
          recommendation: null,
        },
      }

    case 'MergeRefused': {
      /**
       * `done` and `recommendation` depend only on `reason` — never on
       * `branch`/`base`, which `diagnoseRefusal` uses only to compose `what`
       * (already on `hold.why`, set by the appender that had them) — so the
       * placeholders below cost nothing real.
       */
      const reading = diagnoseRefusal({ reason: hold.reason, detail: hold.raw ?? '', branch: '', base: '' })
      return {
        question: `${hold.reason}: ${hold.raw ?? ''}`.slice(0, 400) + unpushedSuffix(hold.run),
        runId: hold.run.runId,
        asked: false,
        needs: 'acknowledgement',
        needsFrom: 'human',
        diagnosis: {
          what: hold.why,
          done: reading.done,
          raw: hold.raw,
          recommendation: reading.recommendation,
        },
      }
    }

    case 'Ceiling':
      return {
        question: `${hold.kind}: ${hold.detail}` + unpushedSuffix(hold.run),
        runId: hold.run.runId,
        asked: false,
        needs: 'acknowledgement',
        needsFrom: 'human',
        diagnosis: {
          what: `${hold.kind}: ${hold.detail}`,
          done: repairDone(hold.run),
          raw: hold.detail,
          recommendation: {
            action: 'requeue',
            why:
              hold.kind === 'out-of-usd'
                ? 'narrow or split the ticket first, or raise runtime.limits.usd; requeued as written, ' +
                  'it buys another run to the same limit'
                : 'narrow or split the ticket first; requeued as written, it buys another run to the same limit',
          },
        },
      }
  }
}
