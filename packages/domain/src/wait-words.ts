/**
 * What `task_view`, the board and every other reader of a wait folded before
 * 0118's `WaitReason` existed — rebuilt from the `WaitReason` directly now
 * that `Hold` is gone (#502, 0120 phase 2).
 *
 * This translation once went through `Hold`, with a conductor adapter doing the other half,
 * `WaitReason -> Hold`, as a temporary translation layer. The switch deletes
 * `Hold` itself, so this is now the one function that goes straight from a
 * `WaitStarted.reason` to the sentence a card and a GitHub comment show —
 * the adapters' own per-variant text, carried over onto
 * `WaitReason`'s twelve tags (thirteen counting `ProposedEscalated`'s own
 * proposal) rather than onto `Hold`'s ten.
 *
 * **Not everything that `Hold` carried survives.** `RunRef.repairOf` (the
 * pre-#143 repair-purchase bookkeeping) has no field on 0118's `RunRef`, so
 * the `done: "a repair for ... produced this diff"` sentence it fed is gone
 * too — accepted, the same way a few other small differences from before
 * 0118 already were (see the retained note below on 400-character clipping).
 */
import { diagnoseRefusal } from './attribution.ts'
import type { BlockDiagnosis, BlockRecommendation } from './events.ts'
import type { Proposal } from './proposal.ts'
import type { Finding, RefusalReason } from './vocabulary.ts'
import type { EscalationBecause, RunRef, WaitReason } from './wait.ts'

/**
 * The sentence a wait prints and the facts needed to describe the hold.
 * One function owns every per-variant sentence (#443).
 */
export interface WaitWords {
  line: string
  needs: 'judgement' | 'acknowledgement'
  diagnosis: BlockDiagnosis | null
}

const APPROVE_EVERY_STEP_PASSED: BlockRecommendation = {
  action: 'approve',
  why: 'every step passed on this diff; approving merges what this run produced',
}

function unpushedSuffix(run: RunRef): string {
  return run.unpushed === undefined ? '' : ` (and ${run.unpushed.branch} was not pushed: ${run.unpushed.said})`
}

/** `the \`${step}\` step ${word}: ${text}` — today's card line, rebuilt. */
function stepLine(step: string, word: string, text: string): string {
  return `the \`${step}\` step ${word}: ${text}`
}

/**
 * `${branch} into ${base}`, or just `${branch}` where `base` is not known.
 *
 * `cardFactOf`/`boardFactOf`/`ticket.ts` each call `waitWords` off one event
 * (or, for `ticket.ts`, off an
 * aggregate with no run stream to read), and none of the three has a
 * projection of the recipe's own `base` —
 * only `conduct.ts`, composing the GitHub comment, does. `branch` they can
 * still supply (the ticket id's issue number makes it, deterministically);
 * dropping `base` rather than printing it blank is the difference between
 * "agent/473 is waiting on you" and "agent/473 into  is waiting on you".
 */
function subjectOf(pass: { branch: string; base: string }): string {
  return pass.base === '' ? pass.branch : `${pass.branch} into ${pass.base}`
}

/**
 * `hold-of.ts`'s own `said`, carried over: whitespace-normalise, trim, and
 * clip to `n` characters with an ellipsis, so a `why` a card renders as one
 * sentence never carries a raw multi-line agent or command answer verbatim.
 */
function said(detail: string, n = 300): string {
  const one = detail.replace(/\s+/g, ' ').trim()
  if (one === '') return 'no detail was recorded'
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function judgement(
  question: string,
  run: RunRef,
  raw: string | null,
  recommendation: BlockRecommendation | null = null,
): WaitWords {
  return {
    line: question,
    needs: 'judgement',
    diagnosis: { what: question + unpushedSuffix(run), done: null, raw, recommendation },
  }
}

function acknowledgement(question: string, run: RunRef, raw: string | null): WaitWords {
  return {
    line: question,
    needs: 'acknowledgement',
    diagnosis: { what: question + unpushedSuffix(run), done: null, raw, recommendation: null },
  }
}

function mergeRefusedColumns(
  run: RunRef,
  reason: RefusalReason,
  raw: string,
  pass: { branch: string; base: string },
): WaitWords {
  const reading = diagnoseRefusal({ reason, detail: raw, branch: pass.branch, base: pass.base })
  const question = `${reason}: ${raw}`.slice(0, 400)
  return {
    line: question,
    needs: 'acknowledgement',
    diagnosis: {
      what: reading.what + unpushedSuffix(run),
      done: reading.done,
      raw,
      recommendation: reading.recommendation,
    },
  }
}

/** What a `BaseMoved` proposal says in place of the lane's `output`, which it does not carry. */
function baseMovedText(proposal: { paths: readonly string[] | null; fromSha: string | null; toSha: string | null }) {
  const paths =
    proposal.paths === null || proposal.paths.length === 0 ? 'files the branch changed' : proposal.paths.join(', ')
  const range =
    proposal.fromSha === null || proposal.toSha === null
      ? ''
      : ` (${proposal.fromSha.slice(0, 7)}..${proposal.toSha.slice(0, 7)})`
  return `the base changed ${paths} since the branch was reviewed${range}`
}

function budgetExhaustedColumns(run: RunRef, cause: 'out-of-turns' | 'out-of-usd', detail: string): WaitWords {
  const question = `${cause}: ${detail}`
  const what =
    cause === 'out-of-usd'
      ? `the run reached the recipe's dollar ceiling and was stopped: ${detail}. The limit is a ` +
        'scope alarm — the ticket asks for more than one run should cost.'
      : `the run reached the recipe's turn limit and was stopped: ${detail}. The limit is a scope ` +
        'alarm — the ticket asks for more than one run should do.'
  return {
    line: question,
    needs: 'acknowledgement',
    diagnosis: {
      what: what + unpushedSuffix(run),
      done: null,
      raw: detail,
      recommendation: {
        action: 'requeue',
        why:
          cause === 'out-of-usd'
            ? 'narrow or split the ticket first, or raise runtime.limits.usd; requeued as written, ' +
              'it buys another run to the same limit'
            : 'narrow or split the ticket first; requeued as written, it buys another run to the same limit',
      },
    },
  }
}

/**
 * A line for `because` (0120 §3's `EscalationBecause`) to fold into an
 * escalated wait's `why` — `''` where the router has nothing to add beyond
 * the proposal itself.
 */
function reasonTextOf(because: EscalationBecause): string {
  switch (because._tag) {
    case 'NotAsked':
      return ''
    case 'JudgeHandedOver':
      return because.why
    case 'UnreadableReply':
      return `the judge's answer could not be read: ${because.raw}`
    case 'UnknownCandidate':
      return `the judge named "${because.candidate}", which was not offered`
    case 'CandidateUnavailable':
      return because.excluded.because._tag === 'CeilingReached'
        ? `the judge chose \`${because.excluded.id}\`, and \`${because.excluded.because.ceiling}\` is spent`
        : `the judge chose \`${because.excluded.id}\`, which nothing holds it to`
  }
}

function reviewFindingsOwnText(proposal: { findings: readonly Finding[] }): string | null {
  return proposal.findings.length === 0 ? null : proposal.findings.map((f) => f.claim).join('; ')
}

/** `MergeConflict`/`VerifyRed` read through `diagnoseRefusal`, the same way `MergeRefused` carries for the same reason. */
function routedRefusalColumns(
  reason: 'conflict' | 'verify-failed',
  raw: string,
  run: RunRef,
  pass: { branch: string; base: string },
  question: string,
): WaitWords {
  const reading = diagnoseRefusal({ reason, detail: raw, branch: pass.branch, base: pass.base })
  return {
    line: question,
    needs: 'judgement',
    diagnosis: {
      what: question + unpushedSuffix(run),
      done: reading.done,
      raw,
      recommendation: reading.recommendation,
    },
  }
}

function escalatedColumns(
  run: RunRef,
  proposal: Proposal,
  because: EscalationBecause,
  pass: { branch: string; base: string; findings: readonly Finding[] },
): WaitWords {
  if (proposal._tag === 'InputNeeded') {
    return judgement(stepLine(proposal.from, 'asked', proposal.question), run, proposal.question)
  }

  const reasonText = reasonTextOf(because)
  const why = (detail: string) =>
    detail === ''
      ? `${subjectOf(pass)} is waiting on you.`
      : `${subjectOf(pass)} is waiting on you. ${said(detail, 400)}`

  switch (proposal._tag) {
    case 'BuildRed': {
      const question = why(reasonText !== '' ? reasonText : proposal.output)
      return judgement(question, run, proposal.output)
    }
    // `conflict` and `verify-failed` are also `RefusalReason`s, and the same
    // function `MergeRefused` reads below must answer them the same way here
    // — the owner sentence and the move, which a plain `judgement()` cannot
    // carry on its own.
    case 'VerifyRed':
      return routedRefusalColumns(
        'verify-failed',
        proposal.output,
        run,
        pass,
        why(reasonText !== '' ? reasonText : proposal.output),
      )
    case 'MergeConflict':
      return routedRefusalColumns(
        'conflict',
        proposal.output,
        run,
        pass,
        why(reasonText !== '' ? reasonText : proposal.output),
      )
    case 'ReviewFindings': {
      const detail = reasonText !== '' ? reasonText : reviewFindingsOwnText(proposal)
      const question = why(detail ?? '')
      const recommendation = proposal.findings.length === 0 ? APPROVE_EVERY_STEP_PASSED : null
      return judgement(question, run, detail, recommendation)
    }
    case 'ReviewEmpty': {
      const question = why(reasonText !== '' ? reasonText : proposal.said)
      return judgement(question, run, proposal.said, APPROVE_EVERY_STEP_PASSED)
    }
    case 'SetupRefused':
      return acknowledgement(stepLine(proposal.from, 'refused', proposal.output), run, proposal.output)
    case 'CheckRefused':
      return acknowledgement(stepLine(proposal.from, 'refused', proposal.output), run, proposal.output)
    case 'AnswerUnreadable': {
      if (proposal.from === 'review' || proposal.from === 'proposed') {
        const prefix =
          proposal.from === 'review'
            ? "`review`'s findings could not be read at all: "
            : "the `proposed` step's own judge answer could not be read at all: "
        const question = `${subjectOf(pass)} is waiting on you. ${said(prefix + proposal.raw, 400)}`
        return judgement(question, run, proposal.raw)
      }
      if (proposal.from === 'merge')
        return acknowledgement(stepLine('merge', 'refused', proposal.raw), run, proposal.raw)
      return acknowledgement(stepLine(proposal.from, 'did-not-finish', proposal.raw), run, proposal.raw)
    }
    case 'NothingProduced':
      return acknowledgement(
        stepLine('implement', 'did-not-finish', proposal.said ?? 'the agent produced no commits'),
        run,
        proposal.said,
      )
    case 'FixerDisagrees':
      return judgement(
        stepLine('implement', 'declined', proposal.said ?? 'the fixing agent committed nothing'),
        run,
        proposal.said,
      )
    case 'MergeRefused':
      return mergeRefusedColumns(run, proposal.reason, proposal.output, pass)
    case 'BaseMoved':
      return mergeRefusedColumns(run, 'base-moved', baseMovedText(proposal), pass)
    case 'BudgetExhausted':
      return budgetExhaustedColumns(run, proposal.kind, proposal.detail)
  }
}

/**
 * The sentence, `needs` and `diagnosis` a fold wrote before 0118, read off
 * the `WaitReason` a `WaitStarted` carries. `pass` is the three facts that
 * live on the pass rather than on the wait — `branch`/`base` open a
 * `ProposedEscalated`'s own composed sentence, and `findings` rides on every
 * `SignoffRequired` the same way it used to ride on `Hold.Human`.
 */
export function waitWords(
  reason: WaitReason,
  pass: { branch: string; base: string; findings: readonly Finding[] } = { branch: '', base: '', findings: [] },
): WaitWords {
  switch (reason._tag) {
    case 'OwnQuestion':
      return { line: reason.question, needs: 'judgement', diagnosis: null }

    case 'AgentQuestion':
      return judgement(stepLine(reason.step, 'asked', reason.question), reason.run, reason.question)

    case 'SignoffRequired': {
      const question = stepLine(reason.step, 'held', reason.question)
      const recommendation = reason.step === 'merge' && pass.findings.length === 0 ? APPROVE_EVERY_STEP_PASSED : null
      return judgement(question, reason.run, reason.question, recommendation)
    }

    case 'FixerDisagrees':
      return judgement(
        stepLine('implement', 'declined', reason.said ?? 'the fixing agent committed nothing'),
        reason.run,
        reason.said,
      )

    case 'NothingProduced':
      return acknowledgement(
        stepLine('implement', 'did-not-finish', reason.said ?? 'the agent produced no commits'),
        reason.run,
        reason.said,
      )

    case 'ProposedEscalated':
      return escalatedColumns(reason.run, reason.proposal, reason.because, pass)

    case 'CheckRefused':
      return acknowledgement(stepLine(reason.step, 'refused', reason.evidence), reason.run, reason.evidence)

    case 'MergeRefused':
      return mergeRefusedColumns(reason.run, reason.reason, reason.raw, pass)

    case 'BudgetExhausted':
      return budgetExhaustedColumns(reason.run, reason.cause, reason.detail)

    case 'AgentCrashed':
      return acknowledgement(
        stepLine(reason.step, 'did-not-finish', reason.detail),
        reason.run,
        reason.standing === undefined
          ? reason.detail
          : `${reason.detail} It changed nothing: what was offered before this round still stands.`,
      )

    case 'SetupRefused':
      return acknowledgement(stepLine(reason.step, 'refused', reason.why), reason.run, reason.why)

    case 'AnswerUnreadable': {
      if (reason.step === 'review' || reason.step === 'proposed') {
        const prefix =
          reason.step === 'review'
            ? "`review`'s findings could not be read at all: "
            : "the `proposed` step's own judge answer could not be read at all: "
        const question = `${subjectOf(pass)} is waiting on you. ${said(prefix + reason.raw, 400)}`
        return judgement(question, reason.run, reason.raw)
      }
      if (reason.step === 'merge')
        return acknowledgement(stepLine('merge', 'refused', reason.raw), reason.run, reason.raw)
      return acknowledgement(stepLine(reason.step, 'did-not-finish', reason.raw), reason.run, reason.raw)
    }
  }
}
