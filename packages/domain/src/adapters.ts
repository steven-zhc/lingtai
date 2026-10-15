import type { Action, StepOutcome } from './action.ts'
/**
 * The writer-side half of `@lingtai/conductor`'s `adapters.ts` (`#466`),
 * moved here by `#473` so `packages/domain/test/events.ts`'s builders can
 * call the same two functions a real pass does, rather than a second
 * transcription of them.
 *
 * `eventOf` turns a `StepOutcome` (0120 §1, `action.ts`) back into the
 * `StepEvent`s `runActionPipeline` would itself have emitted for it, and
 * `holdOf` turns a `WaitReason` (0118 §1, `wait.ts`) into the `Hold` a
 * blocked pass still writes today. Everything else that file declares —
 * `actionOf`, `outcomeOf` and the result builders they are made of — reads
 * `@lingtai/actions`' own `ActionResult`, so it stays in `@lingtai/conductor`
 * and that file now re-exports these two under the same names.
 *
 * **Only `eventOf` and `holdOf` are exported.** Every helper below is the
 * conductor file's own, unchanged, and none of it is any file outside this
 * one's to call directly — a second caller of `said` or `escalatedHold`
 * would be a second place those rules have to stay in sync.
 *
 * **No cycle inside domain.** This file imports `action.ts`, `attribution.ts`
 * and `wait.ts`, and none of those import it back (`wait.ts:33-35`,
 * `hold.ts:15-19`).
 *
 * Imports `./wait.ts` directly rather than through `./index.ts`'s subpath:
 * both live in this package, and the subpath exists only for callers outside
 * it (`wait.ts`'s own header explains the name collisions that keep
 * `WaitReason` there until #464).
 */
import { diagnoseRefusal } from './attribution.ts'
import type { PayloadOf } from './events.ts'
import type { CeilingKind, Hold } from './hold.ts'
import type { Finding, RefusalReason, Step } from './vocabulary.ts'
import type { EscalationBecause, RunRef, WaitReason } from './wait.ts'

/**
 * `@lingtai/actions`' own `ActionEvent`, declared again here because this
 * package has no dependency on that one (0101 §4) — structurally identical,
 * so every caller on the other side of the package boundary can hand this
 * back without a cast.
 */
export type StepEvent =
  | { type: 'StepRequested'; data: PayloadOf<'StepRequested'> }
  | { type: 'StepStarted'; data: PayloadOf<'StepStarted'> }
  | { type: 'StepPassed'; data: PayloadOf<'StepPassed'> }
  | { type: 'StepFailed'; data: PayloadOf<'StepFailed'> }
  | { type: 'StepNeverRan'; data: PayloadOf<'StepNeverRan'> }
  | { type: 'StepDidNotFinish'; data: PayloadOf<'StepDidNotFinish'> }
  | { type: 'StepAsked'; data: PayloadOf<'StepAsked'> }
  | { type: 'ApprovalRequested'; data: PayloadOf<'ApprovalRequested'> }

/** One `Action` narrowed to a single `yields`, the way each helper below takes it. */
type OfYields<Y extends Action['yields']> = Extract<Action, { yields: Y }>

// ---------------------------------------------------------------- eventOf ----

type Base = { readonly step: Step; readonly action: string; readonly runId: string; readonly onSha: string }

/**
 * The `StepEvent`s `runActionPipeline` would itself have appended for this
 * `StepOutcome` — `StepRequested` and `StepStarted` for every action that is
 * not `NotReached`, then the terminal event; nothing for one that is.
 *
 * **Reads `plugin`** — see the header for the cell that still needs it and
 * the one place `nextOf` reads it too.
 */
export function eventOf(outcome: StepOutcome, runId: string): StepEvent[] {
  const events: StepEvent[] = []
  for (const action of outcome.actions) {
    if (action.result._tag === 'NotReached') continue
    const base: Base = { step: outcome.step, action: action.name, runId, onSha: action.onSha }
    events.push({ type: 'StepRequested', data: base })
    events.push({ type: 'StepStarted', data: base })
    events.push(terminalEventOf(action, base))
  }
  return events
}

function terminalEventOf(action: Action, base: Base): StepEvent {
  switch (action.yields) {
    case 'verdict':
      return verdictEventOf(action, base)
    case 'signoff':
      return signoffEventOf(action, base)
    case 'commit':
      return commitEventOf(action, base)
    case 'design':
      return designEventOf(action, base)
    case 'worktree':
      return worktreeEventOf(action, base)
    case 'merge':
      return mergeEventOf(action, base)
    case 'nothing':
      return nothingEventOf(action, base)
  }
}

/** Reached only when `eventOf`'s own filter let a `NotReached` action through — a bug in this file, not a pass. */
function unreachable(base: Base): StepEvent {
  return { type: 'StepDidNotFinish', data: { ...base, detail: 'adapters.ts: a NotReached action reached eventOf' } }
}

function verdictEventOf(action: OfYields<'verdict'>, base: Base): StepEvent {
  const result = action.result
  switch (result._tag) {
    case 'Completed':
      return result.assessment.verdict === 'accepted'
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: result.assessment.findings } }
        : { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: result.assessment.findings } }
    case 'AnswerUnreadable':
      return { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [], unreadable: true } }
    case 'Interrupted':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NeverStarted':
      return { type: 'StepNeverRan', data: { ...base, detail: action.evidence } }
    case 'Waived':
      // Never produced by any action today (0120 §6's own person-only path).
      // It clears, so the nearest event is an ordinary pass.
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function signoffEventOf(action: OfYields<'signoff'>, base: Base): StepEvent {
  switch (action.result._tag) {
    case 'Completed':
      return action.result.requested === null
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'ApprovalRequested', data: { ...base, question: action.result.requested.question, artifacts: [] } }
    case 'Waived':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotDone':
      // Every reachable `signoff` `NotDone` is `runActionPipeline`'s catch —
      // `watch:`'s `then: 'request-approval'` and `human:` never return
      // `failed`, `did-not-finish` or `never-ran` from their own code
      // (`signoffResultOf`'s own comment) — always `verdict: 'failed'`, and
      // the real pipeline always answers that with `StepFailed` (`#466`).
      return { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function commitEventOf(action: OfYields<'commit'>, base: Base): StepEvent {
  const result = action.result
  switch (result._tag) {
    case 'Completed':
      if (result.question !== null) return { type: 'StepAsked', data: { ...base, detail: result.question } }
      if (result.head !== null)
        return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
      // `head: null, question: null` is a kept `run:` that found nothing to
      // commit (`StepPassed`, `plugin: 'run'`) or the work action's own
      // "produced no commits" (`StepDidNotFinish`, `plugin: 'agent'`) — the
      // header's first cell.
      return action.plugin === 'run'
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'Interrupted':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NotDone':
      // Three real causes share this tag: a kept `run:`'s own clean failure
      // (`plugin: 'run'`, `StepFailed`), the work action's own setup that
      // broke before it ran (`plugin: 'agent'`, `StepDidNotFinish`), and any
      // commit-yielding action's dependency throwing, on either plugin — the
      // real pipeline always answers `StepFailed` for a throw regardless of
      // plugin, so `threwRatherThanAnswered` overrides the plugin guess
      // rather than the guess overriding it (`#466` fix round).
      return action.plugin === 'run' || threwRatherThanAnswered(action)
        ? { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NeverStarted':
      return { type: 'StepNeverRan', data: { ...base, detail: action.evidence } }
    case 'Waived':
      // Never produced by any action today (0120 §6's own person-only path),
      // the same as `verdict`'s/`signoff`'s own `Waived` arm above — it
      // clears, so the nearest event is an ordinary pass.
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function designEventOf(action: OfYields<'design'>, base: Base): StepEvent {
  switch (action.result._tag) {
    case 'Drafted':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'Asked':
      return { type: 'StepAsked', data: { ...base, detail: action.result.question } }
    case 'AnswerUnreadable':
      return { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [], unreadable: true } }
    case 'Interrupted':
    case 'NotDone':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'NeverStarted':
      return { type: 'StepNeverRan', data: { ...base, detail: action.evidence } }
    case 'Waived':
      // Same as `commit`'s own `Waived` arm above.
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function worktreeEventOf(action: OfYields<'worktree'>, base: Base): StepEvent {
  switch (action.result._tag) {
    case 'Completed':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotDone':
      return { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'Waived':
      // Same as `commit`'s own `Waived` arm above.
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

function mergeEventOf(action: OfYields<'merge'>, base: Base): StepEvent {
  switch (action.result._tag) {
    case 'Completed':
      return action.result.integration._tag === 'Integrated'
        ? { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'Waived':
      // Same as `commit`'s own `Waived` arm above — a person overruling the
      // merge lane's own refusal (`approve.ts:313`, `#473`'s own major finding).
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

/**
 * **Whether `runActionPipeline`'s own catch produced this result, not the
 * action itself** (`#466`). The catch writes `evidence` as exactly `` `the
 * ${name} action threw: ...` `` in one place (`action.ts:733`) and no action's
 * own code writes that prefix, so matching it reads the pipeline's own
 * deterministic wrapper rather than a judgement 0031 §1 reserves for a token.
 * The one place this is needed: `nothing`'s `NotDone` has no spare arm the
 * way `commit`'s `Interrupted` does, so a throw on a `file-brief:` and its
 * own `did-not-finish` collapse onto the same tag and `plugin` alone cannot
 * tell them apart.
 */
function threwRatherThanAnswered(action: { name: string; evidence: string }): boolean {
  return action.evidence.startsWith(`the ${action.name} action threw: `)
}

function nothingEventOf(action: OfYields<'nothing'>, base: Base): StepEvent {
  switch (action.result._tag) {
    case 'Completed':
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotDone':
      // `claim`'s own `queue:` decline is always `verdict: 'failed'`
      // (`queue-action.ts`), so its `NotDone` is always `StepFailed` — and so
      // is any `nothing`-yielding action's dependency throwing, since
      // `runActionPipeline`'s catch never answers `did-not-finish`.
      // `implement`'s `file-brief:` is `StepDidNotFinish` for its own three
      // `did-not-finish`s, and `StepFailed` for a throw on the same plugin.
      return action.plugin === 'queue' || threwRatherThanAnswered(action)
        ? { type: 'StepFailed', data: { ...base, evidence: action.evidence, findings: [] } }
        : { type: 'StepDidNotFinish', data: { ...base, detail: action.evidence } }
    case 'Waived':
      // Same as `commit`'s own `Waived` arm above.
      return { type: 'StepPassed', data: { ...base, evidence: action.evidence, findings: [] } }
    case 'NotReached':
      return unreachable(base)
  }
}

// ----------------------------------------------------------------- holdOf ----

/**
 * `hold-of.ts`'s own `said`, mirrored rather than imported (see this file's
 * header): whitespace-normalise, trim, and clip to `n` characters with an
 * ellipsis, so a `why` a card renders as one sentence never carries a raw
 * multi-line agent or command answer verbatim. `raw` is never passed through
 * this — it keeps the original, uncapped, for whatever reads deeper.
 */
function said(detail: string, n = 300): string {
  const one = detail.replace(/\s+/g, ' ').trim()
  if (one === '') return 'no detail was recorded'
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/**
 * **One builder per cell `holdOf` and `escalatedHold` both need** (`#471`),
 * so that `holdOf(ProposedEscalated{proposal: X})` equals `holdOf(X's direct
 * WaitReason)` by construction rather than by two call sites staying in
 * sync. Each takes the run and the facts its direct `WaitReason` carries —
 * never the reason or the proposal itself, so neither caller passes the
 * other's shape.
 */
function ceilingHold(
  run: RunRef,
  kind: CeilingKind,
  detail: string,
  turns: number | null,
  costUsd: number | null,
): Hold {
  return { _tag: 'Ceiling', run, kind, detail: said(detail), turns, costUsd }
}

function setupRefusedHold(run: RunRef, step: Step, why: string): Hold {
  // `prepared` alone lifts by a person; every other step's setup failure is
  // an ordinary `DidNotFinish` today (`hold-of.ts:221-227`).
  return step === 'prepared'
    ? { _tag: 'SetupRefused', run, step, lifts: 'person', why: said(why, 400), raw: why }
    : { _tag: 'DidNotFinish', run, step, why: said(why, 400), raw: why }
}

function checkRedHold(run: RunRef, step: Step, evidence: string): Hold {
  return { _tag: 'CheckRed', run, step, why: said(evidence, 400), raw: evidence }
}

function mergeRefusedHold(
  run: RunRef,
  reason: RefusalReason,
  raw: string,
  pass: { branch: string; base: string },
  conflictFields?: { paths: string[] | null; baseSha: string | null; headSha: string | null },
): Hold {
  return {
    _tag: 'MergeRefused',
    run,
    reason,
    // `holdOfPass` reads this cell's `why` from `diagnoseRefusal`
    // (`hold-of.ts:143-155`), not from the lane's own raw detail.
    why: diagnoseRefusal({ reason, detail: raw, branch: pass.branch, base: pass.base }).what,
    paths: conflictFields?.paths ?? null,
    baseSha: conflictFields?.baseSha ?? null,
    headSha: conflictFields?.headSha ?? null,
    raw,
    afterApproval: false,
  }
}

function declinedHold(run: RunRef, step: Step, saidText: string | null): Hold {
  return { _tag: 'Declined', run, step, said: saidText }
}

function nothingProducedHold(run: RunRef, saidText: string | null): Hold {
  // No `Hold` today — the nearest is a `DidNotFinish` at `implement`, the
  // step `nextOf`'s `Propose{NothingProduced}` names for it (0120 §4).
  return {
    _tag: 'DidNotFinish',
    run,
    step: 'implement',
    why: said(saidText ?? 'the agent produced no commits', 400),
    raw: saidText,
  }
}

/**
 * The `Hold` a `WaitReason` would become — 0118 §1's model, through today's
 * spelling. `pass` carries the three facts that live on the pass rather than
 * on the wait: `branch`/`base` open a `Routed.why`, and `findings` rides on
 * every `Human` and `Routed` the way `holdOfPass` already carries it
 * (`hold-of.ts:124,197`).
 */
export function holdOf(reason: WaitReason, pass: { branch: string; base: string; findings: readonly Finding[] }): Hold {
  switch (reason._tag) {
    case 'OwnQuestion':
      return { _tag: 'Question', question: reason.question, by: reason.by }
    case 'AgentQuestion':
      return { _tag: 'Asked', run: reason.run, step: reason.step, question: reason.question }
    case 'SignoffRequired':
      return {
        _tag: 'Human',
        run: reason.run,
        step: reason.step,
        source: reason.step === 'merge' ? 'injected' : 'declared',
        question: reason.question,
        findings: [...pass.findings],
      }
    case 'FixerDisagrees':
      return declinedHold(reason.run, 'implement', reason.said)
    case 'NothingProduced':
      return nothingProducedHold(reason.run, reason.said)
    case 'ProposedEscalated':
      return escalatedHold(reason, pass)
    case 'CheckRefused':
      return checkRedHold(reason.run, reason.step, reason.evidence)
    case 'MergeRefused':
      return mergeRefusedHold(reason.run, reason.reason, reason.raw, pass, {
        paths: reason.paths ?? null,
        baseSha: reason.baseSha ?? null,
        headSha: reason.headSha ?? null,
      })
    case 'BudgetExhausted':
      // 0118 §3's rule: `null` rather than an invented zero. `#455`'s receipt
      // is what would fill `turns`/`costUsd`, and nothing mints one yet.
      return ceilingHold(reason.run, reason.cause, reason.detail, null, null)
    case 'AgentCrashed':
      return {
        _tag: 'DidNotFinish',
        run: reason.run,
        step: reason.step,
        why: said(reason.detail, 400),
        raw: reason.detail,
      }
    case 'SetupRefused':
      return setupRefusedHold(reason.run, reason.step, reason.why)
    case 'AnswerUnreadable':
      return answerUnreadableHold(reason.run, reason.step, reason.raw, pass)
  }
}

/**
 * A line for `reason.because` (0120 §3's `EscalationBecause`) to fold into
 * `escalatedHold`'s `why` — the same role `lastRoute.why` plays for
 * `holdOfPass` (`hold-of.ts:119`), read off the structured reason rather
 * than off a sentence `conduct.ts` built for a different caller. `''` where
 * the router has nothing to add beyond the proposal itself: `NotAsked` means
 * no judge even ran, so there is no extra reason to give.
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

/**
 * `ReviewFindings` carries no text of its own, only `findings` — the fallback
 * `escalatedHold` reaches for when `reasonTextOf` has nothing either, so a
 * `judge:`-less escalation still names the claims rather than leaving `raw`
 * null. `MergeConflict` needed the same fallback before `#466` gave it its
 * own `output`; it reaches for `output` directly now.
 */
function reviewFindingsOwnText(proposal: { findings: readonly Finding[] }): string | null {
  return proposal.findings.length === 0 ? null : proposal.findings.map((f) => f.claim).join('; ')
}

function escalatedHold(
  reason: Extract<WaitReason, { _tag: 'ProposedEscalated' }>,
  pass: { branch: string; base: string; findings: readonly Finding[] },
): Hold {
  const { proposal } = reason
  // `hold-of.ts:196-200`'s own exception: an `InputNeeded` is never
  // `Routed{when: 'needs-input'}` — it carries the agent's own question in a
  // field `Routed` has none for.
  if (proposal._tag === 'InputNeeded') {
    return { _tag: 'Asked', run: reason.run, step: proposal.from, question: proposal.question }
  }

  // `reason.because` is why the router escalated rather than selecting a
  // candidate — dropped entirely before this fix, which is how a card for an
  // escalation with the rounds spent read no differently from one with
  // nothing to say at all.
  const reasonText = reasonTextOf(reason.because)
  const why = (detail: string) =>
    detail === ''
      ? `${pass.branch} into ${pass.base} is waiting on you.`
      : `${pass.branch} into ${pass.base} is waiting on you. ${said(detail, 400)}`

  switch (proposal._tag) {
    case 'BuildRed':
      // Same fallback as `MergeConflict`/`ReviewFindings`/`ReviewEmpty`: with
      // no judge declared (`NotAsked`, the default), `reasonText` is `''` and
      // `why` must not settle for the bare branch sentence when `output`
      // carries the tsc failure itself.
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'red',
        why: why(reasonText !== '' ? reasonText : proposal.output),
        raw: proposal.output,
        findings: [...pass.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
    case 'VerifyRed':
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'verify-failed',
        why: why(reasonText !== '' ? reasonText : proposal.output),
        raw: proposal.output,
        findings: [...pass.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
    case 'MergeConflict':
      // `proposal.output` is the lane's own text (`#466`, `mergeCompletedRefused`
      // in `pass-next.ts`) — the same shape `BuildRed`/`VerifyRed` already had,
      // so `raw` matches `holdOfPass` (`hold-of.ts:118-126`, `raw: why`) rather
      // than falling back to an invented sentence.
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'conflict',
        why: why(reasonText !== '' ? reasonText : proposal.output),
        raw: proposal.output,
        findings: [...pass.findings],
        paths: proposal.paths,
        baseSha: proposal.baseSha,
        headSha: proposal.headSha,
      }
    case 'ReviewFindings': {
      // Same fallback as `MergeConflict`, off `findings` rather than `paths`
      // — `findings` is the proposal's own evidence here.
      const detail = reasonText !== '' ? reasonText : reviewFindingsOwnText(proposal)
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'findings',
        why: why(detail ?? ''),
        raw: detail,
        findings: [...proposal.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
    }
    case 'ReviewEmpty':
      // `said` is the review's own evidence (`Proposal.ReviewEmpty.said`,
      // required and never null) — the same fallback `MergeConflict` and
      // `ReviewFindings` reach for off `paths`/`findings`, missing here before
      // this fix: with no judge declared (`NotAsked`, the default), `why` fell
      // back to the bare branch sentence even though `raw` already carried
      // `said` whole.
      return {
        _tag: 'Routed',
        run: reason.run,
        when: 'findings',
        why: why(reasonText !== '' ? reasonText : proposal.said),
        raw: proposal.said,
        findings: [...proposal.findings],
        paths: null,
        baseSha: null,
        headSha: null,
      }
    // `#471`'s seven: none of their direct `Hold`s has a field for
    // `reason.because` (the Watch out's own rule), so these call the same
    // builder the direct `WaitReason` case above does, off the proposal's
    // own facts, and never read `reasonText`/`why` above.
    case 'SetupRefused':
      return setupRefusedHold(reason.run, proposal.from, proposal.output)
    case 'CheckRefused':
      return checkRedHold(reason.run, proposal.from, proposal.output)
    case 'AnswerUnreadable':
      return answerUnreadableHold(reason.run, proposal.from, proposal.raw, pass)
    case 'NothingProduced':
      return nothingProducedHold(reason.run, proposal.said)
    case 'FixerDisagrees':
      return declinedHold(reason.run, 'implement', proposal.said)
    case 'MergeRefused':
      return mergeRefusedHold(reason.run, proposal.reason, proposal.output, pass)
    case 'BudgetExhausted':
      // An escalated `BudgetExhausted` passes the proposal's own
      // `turns`/`costUsd` through — the direct path always writes `null`
      // there (nothing mints a receipt for it yet), and the proposal is the
      // only place those two numbers are known at this point.
      return ceilingHold(reason.run, proposal.kind, proposal.detail, proposal.turns, proposal.costUsd)
  }
}

function answerUnreadableHold(
  run: RunRef,
  step: Step,
  raw: string,
  pass: { branch: string; base: string; findings: readonly Finding[] },
): Hold {
  // No `Hold` today. `review`/`proposed` go through the router
  // (`Routed{when: 'findings'}`, as an unrouted `review` refusal does);
  // `merge` reads as the lane's own `CheckRed`; `design` has nothing but an
  // ordinary `DidNotFinish`.
  if (step === 'review' || step === 'proposed') {
    // The prefix is a short form of `pass.ts`'s own deleted sentence
    // (`pendingUnreadableReview`, `#472`), ahead of `raw` inside the same
    // `said(…, 400)` so it survives clipping where `raw` alone would not.
    // `review`'s own cold reviewer and a judge declared at `proposed` are
    // different actors, so the prefix names whichever one actually failed
    // to parse rather than always naming the reviewer's findings.
    const prefix =
      step === 'review'
        ? "`review`'s findings could not be read at all: "
        : "the `proposed` step's own judge answer could not be read at all: "
    return {
      _tag: 'Routed',
      run,
      when: 'findings',
      why: `${pass.branch} into ${pass.base} is waiting on you. ${said(prefix + raw, 400)}`,
      raw,
      findings: [...pass.findings],
      paths: null,
      baseSha: null,
      headSha: null,
    }
  }
  if (step === 'merge') {
    return { _tag: 'CheckRed', run, step: 'merge', why: said(raw, 400), raw }
  }
  return { _tag: 'DidNotFinish', run, step, why: said(raw, 400), raw }
}
