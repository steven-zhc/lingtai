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
 * **The card line is rebuilt, not stored.** A `Hold` carries a person's bare
 * words — `Asked.question`, `CheckRed.why` — never the step that arrived with
 * them, because the ticket's own words move a person's text into the variant
 * that owns it and nothing else. So for every variant but `Routed` (whose
 * `why` is already composed, because `branch`/`base` are not on a `Hold`) and
 * `MergeRefused`/`Ceiling` (whose own formulas predate this file), the
 * question is `` `the \`${step}\` step ${word}: ${text}` `` — the same
 * sentence `whatIsWaitingOnYou` used to write before #445, rebuilt here.
 *
 * **Not everything is reproduced exactly.** `diagnosis.what` used to open
 * with `` `${branch} is at ${sha.slice(0,7)} and ` `` and could end with
 * `` ` ${spent} of ${ceiling} rounds were spent.` `` — neither the branch's
 * head nor the round count is on a `Hold`, because 0118 §1 did not carry
 * them, and inventing a number the event never recorded would be worse than
 * the gap. `Asked.question` and `Human.question` are stored unsaid (no
 * `said(…, 400)`), so the composed line differs from today's only past 400
 * characters or where the text has runs of whitespace — accepted rather than
 * moving `said` into this package for it.
 *
 * **The unpushed parenthetical lands on `what`, never on `question`.** The
 * pre-#445 `blocked()` appended it to `diagnosis.what` and left `question`
 * alone; an earlier draft of this file put it on `question` instead, which
 * moved the sentence a person reads on the card and in the GitHub comment.
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
  return run.repairOf !== undefined ? `a repair for ${run.repairOf.reason} produced this diff` : null
}

/** `the \`${step}\` step ${word}: ${text}` — today's card line, rebuilt. */
function stepLine(step: string, word: string, text: string): string {
  return `the \`${step}\` step ${word}: ${text}`
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

    case 'Asked': {
      const question = stepLine(hold.step, 'asked', hold.question)
      return {
        question,
        runId: hold.run.runId,
        asked: false,
        needs: 'judgement',
        needsFrom: 'human',
        diagnosis: {
          what: question + unpushedSuffix(hold.run),
          done: repairDone(hold.run),
          raw: hold.question,
          recommendation: null,
        },
      }
    }

    case 'Human': {
      const question = stepLine(hold.step, 'held', hold.question)
      return {
        question,
        runId: hold.run.runId,
        asked: false,
        needs: 'judgement',
        needsFrom: 'human',
        diagnosis: {
          what: question + unpushedSuffix(hold.run),
          done: repairDone(hold.run),
          raw: hold.question,
          // The same findings veto `Routed` carries below: approving over a
          // live finding is the one judgement nothing but a person should
          // make (0058 §3b), so a `merge` hold only recommends it when review
          // raised nothing.
          recommendation:
            hold.step === 'merge' && (hold.findings?.length ?? 0) === 0 ? APPROVE_EVERY_STEP_PASSED : null,
        },
      }
    }

    case 'Routed': {
      // The one variant whose composed line is on the hold itself: `why`
      // already reads "`${branch}` into `${base}` is waiting on you. …",
      // because branch/base are not fields a `Hold` carries.
      const question = hold.why
      return {
        question,
        runId: hold.run.runId,
        asked: false,
        needs: 'judgement',
        needsFrom: 'human',
        diagnosis: {
          what: question + unpushedSuffix(hold.run),
          done: repairDone(hold.run),
          raw: hold.raw,
          recommendation: hold.when === 'findings' && hold.findings.length === 0 ? APPROVE_EVERY_STEP_PASSED : null,
        },
      }
    }

    case 'CheckRed':
    case 'DidNotFinish':
    case 'SetupRefused': {
      const word = hold._tag === 'DidNotFinish' ? 'did-not-finish' : 'refused'
      const question = stepLine(hold.step, word, hold.why)
      return {
        question,
        runId: hold.run.runId,
        asked: false,
        needs: 'acknowledgement',
        needsFrom: 'human',
        diagnosis: {
          what: question + unpushedSuffix(hold.run),
          done: repairDone(hold.run),
          raw: hold.raw,
          recommendation: null,
        },
      }
    }

    case 'MergeRefused': {
      /**
       * `done` and `recommendation` depend only on `reason` — never on
       * `branch`/`base`, which `diagnoseRefusal` uses only to compose `what`
       * (already on `hold.why`, set by the appender that had them) — so the
       * placeholders below cost nothing real.
       */
      const reading = diagnoseRefusal({ reason: hold.reason, detail: hold.raw ?? '', branch: '', base: '' })
      const question = `${hold.reason}: ${hold.raw ?? ''}`.slice(0, 400)
      return {
        question,
        runId: hold.run.runId,
        asked: false,
        needs: 'acknowledgement',
        needsFrom: 'human',
        diagnosis: {
          what: hold.why + unpushedSuffix(hold.run),
          done: reading.done,
          raw: hold.raw,
          recommendation: reading.recommendation,
        },
      }
    }

    case 'Ceiling': {
      const question = `${hold.kind}: ${hold.detail}`
      // The limit number itself (`limitsFor(recipe, 'implement').turns`/`.usd`)
      // is not on a `Hold` and is an accepted loss (this file's header); the
      // *scope alarm* sentence around it is not a number and survives.
      const what =
        hold.kind === 'out-of-usd'
          ? `the run reached the recipe's dollar ceiling and was stopped: ${hold.detail}. The limit is a ` +
            'scope alarm — the ticket asks for more than one run should cost.'
          : `the run reached the recipe's turn limit and was stopped: ${hold.detail}. The limit is a scope ` +
            'alarm — the ticket asks for more than one run should do.'
      return {
        question,
        runId: hold.run.runId,
        asked: false,
        needs: 'acknowledgement',
        needsFrom: 'human',
        diagnosis: {
          what: what + unpushedSuffix(hold.run),
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
}
