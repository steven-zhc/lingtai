import type { BlockDiagnosis, BlockRecommendation } from './events.ts'
/**
 * What `task_view`, the board and every other reader of a wait reduced before
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
 * **Not everything that `Hold` carried survives.** `AttemptRef.repairOf` (the
 * pre-#143 repair-purchase bookkeeping) has no field on 0118's `AttemptRef`, so
 * the `done: "a repair for ... produced this diff"` sentence it fed is gone
 * too — accepted, the same way a few other small differences from before
 * 0118 already were (see the retained note below on 400-character clipping).
 */
import { diagnoseRefusal } from './failure/explain.ts'
import type { Proposal } from './proposal.ts'
import { askedText } from './triage.ts'
import type { Finding, RefusalReason } from './vocabulary.ts'
import type { EscalationBecause, AttemptRef, Resolution, TriageResult, WaitReason } from './wait.ts'

/**
 * The sentence a wait prints and the facts needed to describe the hold.
 * One function owns every per-variant sentence (#443).
 */
export interface WaitWords {
  line: string
  /** The two-or-three words a card can lead with; `null` where the reason has no short name. */
  short: string | null
  needs: 'judgement' | 'acknowledgement'
  diagnosis: BlockDiagnosis | null
}

/** The one thing the setup's own hold says, quoted into the recipe. */
export const SETUP_HOLD_TEXT = "Land this? The setup was answered 'hold'."

const APPROVE_EVERY_ATTEMPT = 'the recipe asks you to approve each attempt'

const APPROVE_EVERY_STEP_PASSED: BlockRecommendation = {
  action: 'approve',
  why: 'every step passed on this diff; approving merges what this run produced',
}

function unpushedSuffix(run: AttemptRef): string {
  return run.unpushed === undefined ? '' : ` (and ${run.unpushed.branch} was not pushed: ${run.unpushed.said})`
}

/** `the \`${step}\` step ${word}: ${text}` — today's card line, rebuilt. */
function stepLine(step: string, word: string, text: string): string {
  return `the \`${step}\` step ${word}: ${text}`
}

/**
 * `${branch} into ${base}`, or just `${branch}` where `base` is not known.
 *
 * `task-view.ts`/`boardFactOf`/`ticket.ts` each call `waitWords` off one event
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
  run: AttemptRef,
  raw: string | null,
  recommendation: BlockRecommendation | null = null,
): WaitWords {
  return {
    line: question,
    short: null,
    needs: 'judgement',
    diagnosis: { what: question + unpushedSuffix(run), done: null, raw, recommendation },
  }
}

function acknowledgement(question: string, run: AttemptRef, raw: string | null): WaitWords {
  return {
    line: question,
    short: null,
    needs: 'acknowledgement',
    diagnosis: { what: question + unpushedSuffix(run), done: null, raw, recommendation: null },
  }
}

function mergeRefusedColumns(
  run: AttemptRef,
  reason: RefusalReason,
  raw: string,
  pass: { branch: string; base: string },
  landedAgain?: { times: number; minutes: number },
): WaitWords {
  const reading = diagnoseRefusal({ reason, detail: raw, branch: pass.branch, base: pass.base, landedAgain })
  const question = `${reason}: ${raw}`.slice(0, 400)
  return {
    line: question,
    short: null,
    needs: 'acknowledgement',
    diagnosis: {
      what: reading.what + unpushedSuffix(run),
      done: reading.done,
      raw,
      // `allowedResolutions` removes Approve for a run with an unpushed head
      // (`wait.ts`), so a card must not recommend the move it cannot offer.
      recommendation: run.unpushed && reading.recommendation?.action === 'approve' ? null : reading.recommendation,
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

function budgetExhaustedColumns(run: AttemptRef, cause: 'out-of-turns' | 'out-of-usd', detail: string): WaitWords {
  const question = `${cause}: ${detail}`
  const what =
    cause === 'out-of-usd'
      ? `the run reached the recipe's dollar ceiling and was stopped: ${detail}. The limit is a ` +
        'scope alarm — the ticket asks for more than one run should cost.'
      : `the run reached the recipe's turn limit and was stopped: ${detail}. The limit is a scope ` +
        'alarm — the ticket asks for more than one run should do.'
  return {
    line: question,
    short: null,
    needs: 'acknowledgement',
    diagnosis: {
      what: what + unpushedSuffix(run),
      done: null,
      raw: detail,
      recommendation: {
        action: 'requeue',
        why:
          cause === 'out-of-usd'
            ? 'narrow or split the ticket first, or raise runtime.limits.run.usd; started again as written, ' +
              'it buys another run to the same limit'
            : 'narrow or split the ticket first; started again as written, it buys another run to the same limit',
      },
    },
  }
}

/** **One sentence for a base that is red** (#744), shared by the card and the run's `PassRouted.why`. */
export function baseRedText(because: { command: string; base: string; baseSha: string }): string {
  return (
    `base is red: \`${because.command}\` fails on ${because.base} at ${because.baseSha.slice(0, 7)} before any ` +
    `change, so a refusal fix would not be about this diff — make ${because.base} pass it, or drop it from ` +
    `build, then lingtai start-new-attempt`
  )
}

/**
 * A line for `because` (0120 §3's `EscalationBecause`) to reduce into an
 * escalated wait's `why` — `''` where the router has nothing to add beyond
 * the proposal itself.
 */
function reasonTextOf(because: EscalationBecause): string {
  switch (because._tag) {
    case 'NotAsked':
      return ''
    case 'JudgeHandedOver':
      return because.why
    case 'BaseRed':
      return baseRedText(because)
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
  run: AttemptRef,
  pass: { branch: string; base: string },
  question: string,
): WaitWords {
  const reading = diagnoseRefusal({ reason, detail: raw, branch: pass.branch, base: pass.base })
  return {
    line: question,
    short: null,
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
  run: AttemptRef,
  proposal: Proposal,
  because: EscalationBecause,
  pass: { branch: string; base: string; findings: readonly Finding[] },
): WaitWords {
  if (proposal._tag === 'InputNeeded') {
    const asked = askedText(proposal)
    return judgement(stepLine(proposal.from, 'asked', asked), run, asked)
  }

  const reasonText = reasonTextOf(because)
  const why = (detail: string) =>
    detail === ''
      ? `${subjectOf(pass)} is waiting on you.`
      : `${subjectOf(pass)} is waiting on you. ${said(detail, 400)}`

  switch (proposal._tag) {
    case 'BuildRed': {
      const question = why(reasonText !== '' ? reasonText : proposal.output)
      return judgement(question, run, because._tag === 'BaseRed' ? because.evidence : proposal.output)
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
    case 'AlreadyDone': {
      const detail = proposal.items.map((i) => `${i.item}: ${i.evidence}`).join('\n')
      return judgement(
        why(reasonText !== '' ? reasonText : `declared already done at ${proposal.baseSha.slice(0, 7)}`),
        run,
        detail,
      )
    }
    case 'SetupRefused':
      return acknowledgement(stepLine(proposal.from, 'refused', proposal.output), run, proposal.output)
    case 'CheckRefused':
      return acknowledgement(stepLine(proposal.from, 'refused', proposal.output), run, proposal.output)
    case 'SandboxRefused': {
      // The full *Waiting on you* text is S9's (#1157); this is the plain sentence.
      const detail =
        proposal.cause === 'unavailable'
          ? `sandbox unavailable on this host: ${proposal.said ?? ''}`
          : `the sandbox refused a connection to ${proposal.hosts.join(', ')}`
      return acknowledgement(stepLine(proposal.from, 'refused', detail), run, proposal.output)
    }
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
    case 'DiffTooLarge': {
      // The unit is the clip's own (`diff.length`, UTF-16 code units), so the
      // two numbers are comparable with the recipe's `runtime.budget.diff`.
      const detail =
        `the diff is ${proposal.size} characters and the reviewer reads ${proposal.limit}, ` +
        `so the \`${proposal.from}\` reviewer was not run and no refusal fix is offered`
      return judgement(`${subjectOf(pass)} is waiting on you. ${said(detail, 400)}`, run, detail)
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
      return mergeRefusedColumns(run, proposal.reason, proposal.output, pass, proposal.landedAgain)
    case 'BaseMoved':
      return mergeRefusedColumns(run, 'base-moved', baseMovedText(proposal), pass)
    case 'BudgetExhausted':
      return budgetExhaustedColumns(run, proposal.kind, proposal.detail)
  }
}

/**
 * The sentence, `needs` and `diagnosis` a reducer wrote before 0118, read off
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
      return { line: reason.question, short: null, needs: 'judgement', diagnosis: null }

    case 'AgentQuestion': {
      const asked = askedText(reason)
      return judgement(stepLine(reason.step, 'asked', asked), reason.run, asked)
    }

    case 'SignoffRequired': {
      const asked = reason.question === SETUP_HOLD_TEXT ? APPROVE_EVERY_ATTEMPT : reason.question.trim()
      const question = asked === '' ? 'ready to land' : `ready to land — ${asked}`
      const recommendation = reason.step === 'merge' && pass.findings.length === 0 ? APPROVE_EVERY_STEP_PASSED : null
      return { ...judgement(question, reason.run, reason.question, recommendation), short: 'ready to land' }
    }

    case 'SatisfiedUnconfirmed':
      return {
        ...judgement(
          `already satisfied on ${reason.baseSha.slice(0, 7)} — confirm to end it, or send it round again. ${said(reason.reading, 400)}`,
          reason.run,
          reason.reading,
          null,
        ),
        short: 'already satisfied',
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
        stepLine(reason.step, 'did-not-finish', reason.detail) +
          (reason.standing === undefined
            ? ''
            : ' It changed nothing: what was offered before this round still stands.'),
        reason.run,
        reason.detail,
      )

    case 'SetupRefused':
      return acknowledgement(stepLine(reason.step, 'refused', reason.why), reason.run, reason.why)

    case 'AskLimit': {
      // 0108 §22: the five stops are spent, so a person decides and nothing continues on its own.
      const used = `This ticket has stopped to ask a person ${reason.used} of ${reason.allowed} times (\`${reason.bound}\`), so it will not ask again.`
      const asked =
        reason.asked._tag === 'AgentQuestion'
          ? askedText(reason.asked)
          : reason.asked._tag === 'ProposedEscalated' && reason.asked.proposal._tag === 'InputNeeded'
            ? askedText(reason.asked.proposal)
            : waitWords(reason.asked, pass).line
      return {
        line: `${used} It wanted to ask: ${said(asked, 400)}`,
        short: null,
        needs: 'judgement',
        diagnosis: null,
      }
    }

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

/** What a judge's cause says in words, for the route line (0108 §6): the three a judge may answer, and the rest by name. */
export function judgeCauseWords(cause: { readonly _tag: string }): string {
  switch (cause._tag) {
    case 'FixableLines':
      return 'the judge read lines to fix'
    case 'WrongApproach':
      return 'the judge read the approach as wrong'
    case 'UndecidedQuestion':
      return 'the judge read a question only a person can answer'
    default:
      return `the judge read ${cause._tag}`
  }
}

// ------------------------------------------------------------ systemLine ----

/** What one reading of a system resolution says, in parts so each place can lay it out (#1259). */
export interface SystemLine {
  /** What the system did, present tense: *the step is being redone*. */
  readonly action: string
  /** *Triage read <cause>*, or null where the `WaitTriaged` was not found — a cause is never made up. */
  readonly because: string | null
  /** *2 of 3 redos used*, *bound unknown* when it could not be read, null when there is no action to bound. */
  readonly bound: string | null
}

/** The bounds a triage resolution can spend, as the recipe's numbers a reader joins them with. */
export type SystemLimits = {
  readonly refusalFixes: number
  readonly conflictResolutions: number
  readonly newAttempts: number
} | null

/** What a cause says in words, past tense — a statement of what triage read, not an instruction to a person. */
const CAUSE_READ: Record<Extract<TriageResult, { _tag: 'TriageAnswered' }>['cause']['_tag'], string> = {
  UndecidedQuestion: 'a question only a person can answer',
  FixableLines: 'lines to fix',
  WrongApproach: 'the approach as wrong',
  ConflictingHunks: 'conflicting hunks',
  TicketTooBig: 'the ticket as too big',
  SetupBroken: 'the setup as broken',
  Unfinished: 'only unfinished',
}

type SystemResolved = {
  readonly resolution: Resolution
  readonly by: string
  /** The resolution's note: all a missing `WaitTriaged` leaves to say. */
  readonly note?: string
  readonly spent?: { readonly bound: 'refusalFixes' | 'conflictResolutions' | 'stepRedos'; readonly n: number }
}

/**
 * **One sentence for a wait the system resolved** (#1259): the action, the cause's words, and the bound used.
 * `counter` is read at render by the caller (`systemBoundOf`), null where it could not be — then the bound says so,
 * never `0 of N`. `triage` null, or not an answer, gives no cause.
 */
export function systemLine(
  resolved: SystemResolved,
  triage: TriageResult | null,
  counter: { readonly used: number; readonly allowed: number } | null,
): SystemLine {
  const cause = triage !== null && triage._tag === 'TriageAnswered' ? triage.cause : null
  // No cause found: the note is the evidence that is left, and no cause is made up (#1259).
  const note = (resolved.note ?? '').trim()
  const bare: SystemLine = {
    action:
      note === '' ? 'resolved by triage' : `resolved by triage: ${note.length > 160 ? `${note.slice(0, 159)}…` : note}`,
    because: null,
    bound: null,
  }
  const resolution = resolved.resolution
  let action: string
  let noun: string
  switch (resolution._tag) {
    case 'FixRefusal': {
      const conflict =
        resolved.spent !== undefined
          ? resolved.spent.bound === 'conflictResolutions'
          : cause !== null && cause._tag === 'ConflictingHunks'
      action = conflict ? 'the conflict is being resolved' : 'the lines are being fixed'
      noun = conflict ? 'conflict resolutions' : 'fix rounds'
      break
    }
    case 'RedoStep':
      action = 'the step is being redone'
      noun = 'redos'
      break
    case 'StartNewAttempt':
      action = 'a new attempt is being started'
      noun = 'new attempts'
      break
    case 'Approve':
    case 'AnswerQuestions':
    case 'EditBodyAndStartNewAttempt':
    case 'AnswerQuestion':
    case 'ConfirmSatisfied':
    case 'Split':
    case 'Close':
      return bare
  }
  if (cause === null) return bare
  return {
    action,
    because: `Triage read ${CAUSE_READ[cause._tag]}`,
    bound: counter === null ? 'bound unknown' : `${counter.used} of ${counter.allowed} ${noun} used`,
  }
}

const HELD_NOUN = {
  refusalFixes: 'fix rounds',
  newAttempts: 'new attempts',
  ticketSplits: 'splits',
  stepRedos: 'redos',
  conflictResolutions: 'conflict resolutions',
  personAsks: 'questions',
} as const

/**
 * **The line for a wait the system read and then left to a person** (#1260): a bound spent (*3 of 3 redos used*, named by
 * its own key) or an environment that stopped the action (the write's detail). Null where the answer carries no decision.
 */
export function heldLine(triage: TriageResult | null): SystemLine | null {
  if (triage === null || triage._tag !== 'TriageAnswered' || triage.held === undefined) return null
  const because = `Triage read ${CAUSE_READ[triage.cause._tag]}`
  const held = triage.held
  return held._tag === 'limit'
    ? {
        action: `${held.bound} is spent, so a person is asked`,
        because,
        bound: `${held.used} of ${held.allowed} ${HELD_NOUN[held.bound]} used`,
      }
    : { action: `a person is asked: ${held.detail}`, because, bound: null }
}

/**
 * **What a card or `status` says where the ticket's log could not be read** (#1259): a failed read is not "triage
 * resolved nothing", so the line says what it could not tell, and that the bound is unknown with it.
 */
export const SYSTEM_LINE_UNREAD: SystemLine = {
  action: 'whether triage resolved a wait could not be read',
  because: null,
  bound: 'bound unknown',
}

/** The line as one sentence: *Triage read only unfinished; the step is being redone — 2 of 3 redos used*. */
export function systemLineText(line: SystemLine): string {
  const head = line.because === null ? line.action : `${line.because}; ${line.action}`
  return line.bound === null ? head : `${head} — ${line.bound}`
}
