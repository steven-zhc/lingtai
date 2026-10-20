/**
 * The Run aggregate: `pass-{ulid}`, alive for hours, noisy.
 *
 * This is where the old loop's telemetry went to die. Guard blocks went to
 * stderr inside a log nobody parsed — 132 of them across 56 of 73 runs, 77% of
 * runs tripping the guard, and not one of them ever seen. Cost records went to a
 * `.jsonl` that also contained raw `pnpm build` output, so 9,555 of its 42,147
 * lines were not JSON and the file would not parse. Every number this reducer
 * exposes is a number that existed before and could not be read.
 *
 * The load-bearing subtlety is `onSha`. A gate verdict is about **a diff**, not
 * about a ticket. In the old system approval was a label, and a label survives
 * any amount of rewriting — so a force-push inherited its own approval. Here a
 * verdict records the sha it was made against, and `stepsOn(state)` returns only
 * the verdicts that match the current head. Nothing has to remember to
 * invalidate anything; a new head simply has no verdicts yet.
 */
import type { Action } from './action.ts'
import type { Envelope } from './envelope.ts'
import type { Invocation, PayloadOf, RunFailureKind, RuntimeId, Severity } from './events.ts'

/**
 * `never-ran` is not a verdict about the diff, and is here because the absence
 * of one has to be readable ([0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md)
 * §1, one layer up). The gate's agent never started — a quota, a signed-out
 * runtime — so nothing was judged. Folding it into `failed` is what `#133` is
 * about; folding it into `passed` would be worse.
 *
 * `did-not-finish` is the neighbouring absence
 * ([0057](../../../doc/decisions-archive/0057-a-gate-that-did-not-finish.md) §1): the
 * agent *started* and ended with no receipt. Nothing was judged there either,
 * and it is its own value rather than `never-ran`'s because the two cost
 * opposite things — one stands the conductor down for an account-wide wall,
 * and the other is local and retried once.
 *
 * `asked` is the third absence and the only one with a question in it (`#296`,
 * 0058 §3c): the agent stopped and asked something, so nothing was judged here
 * either. Beside `did-not-finish` rather than inside it because the two are
 * opposite things to a person — one is a question and the other is broken
 * machinery — and for a fortnight the difference was a substring of a `because`.
 */
export type StepVerdict =
  | 'requested'
  | 'running'
  | 'passed'
  | 'failed'
  | 'never-ran'
  | 'did-not-finish'
  | 'asked'
  | 'waived'

export interface StepFinding {
  file: string
  line: number | null
  claim: string
  /** No failure scenario, no finding. An observation without one is an opinion. */
  failureScenario: string
  /** The ladder is `SEVERITIES` in `./events.ts` and is not restated here. */
  severity: Severity
}

export interface StepState {
  step: string
  verdict: StepVerdict
  /** The commit this verdict is about. A verdict on any other sha is stale. */
  onSha: string
  evidence: string | null
  findings: readonly StepFinding[]
  /** Set for a waiver, and for an approval. A waiver is recorded, never silent. */
  by: string | null
  reason: string | null
}

export type RunLifecycle =
  | { status: 'pending' }
  /** The worktree is being made workable. No agent has started. */
  | { status: 'running' }
  | { status: 'awaiting-input'; prompt: string }
  | { status: 'gating'; headSha: string }
  | { status: 'awaiting-approval'; step: string; onSha: string; question: string }
  | { status: 'finished'; exitCode: number; turns: number; durationMs: number }
  /**
   * `prepare-failed` has no matching `RunFailed` kind, and that is on purpose.
   * The lifecycle is a reading of several events, and a prepare step that
   * refused is not a run that failed — it is a run that never began. Emitting
   * `RunFailed` for it would put "the agent broke it" on a card where no agent
   * ever ran.
   */
  | {
      status: 'failed'
      /**
       * Every `RunFailed.kind`, and the one the lifecycle adds. Read off the
       * catalogue rather than written out again, so a kind gained there — as
       * `never-started` was (0031 §1) — is a kind a card can already be in.
       */
      kind: RunFailureKind | 'prepare-failed'
      detail: string
    }

export type RunStatus = RunLifecycle['status']

export interface RunState {
  lifecycle: RunLifecycle

  ticketId: string | null
  runtime: RuntimeId | null
  model: string | null
  promptVersion: string | null
  baseSha: string | null
  /** Hash of the recipe as read from `origin/<base>`, never from the agent's branch. */
  configHash: string | null
  worktree: string | null
  /**
   * How the runtime was actually invoked: the command, the argv, the tier and
   * the limits as applied. Null for a v1 `RunStarted`, and for a runtime that
   * cannot describe its own invocation (#88).
   */
  invocation: Invocation | null

  /** Current head of the agent's branch. Changes invalidate gate verdicts. */
  headSha: string | null
  branch: string | null
  diff: { files: number; insertions: number; deletions: number } | null

  /** Files the agent wrote, in order, so the card can show them live. */
  touched: readonly { path: string; op: 'edit' | 'write' | 'delete' }[]
  /**
   * Turns at which the context was compacted. Compaction means the work item was
   * scoped too large — a metric, not noise.
   */
  compactedAtTurns: readonly number[]
  prompts: number
  /**
   * The prompt as handed over, which is the one input to a run that is
   * otherwise unrecoverable (#88).
   *
   * Last one wins, and an unattended run submits exactly one — `claude -p` is a
   * single prompt and the follow-ups only exist where a person is typing. Null
   * until something records one, and null for a v1 `RunPrompted`, which carried
   * only a length.
   */
  prompt: string | null

  /** Latest verdict per gate name, each carrying the sha it was made against. */
  steps: Readonly<Record<string, StepState>>

  receipt: { exitCode: number; turns: number; durationMs: number } | null

  version: number
  lastSeq: bigint | null
}

export const emptyRun: RunState = {
  lifecycle: { status: 'pending' },
  ticketId: null,
  runtime: null,
  model: null,
  promptVersion: null,
  baseSha: null,
  configHash: null,
  worktree: null,
  invocation: null,
  headSha: null,
  branch: null,
  diff: null,
  touched: [],
  compactedAtTurns: [],
  prompts: 0,
  prompt: null,
  steps: {},
  receipt: null,
  version: 0,
  lastSeq: null,
}

/**
 * The gate verdicts that are actually about the current head.
 *
 * A force-push moves `headSha`, and every verdict made against the old one stops
 * counting here without anything having to revoke it. That is the whole reason
 * `onSha` is on the event.
 */
export function stepsOn(state: RunState): StepState[] {
  if (state.headSha === null) return []
  return Object.values(state.steps).filter((g) => g.onSha === state.headSha)
}

function withStep(state: RunState, step: StepState): Readonly<Record<string, StepState>> {
  return { ...state.steps, [step.step]: step }
}

/**
 * One action's `Action` (0120 §1), read as the `StepState` this aggregate
 * has always kept — the nine-string ladder `StepVerdict` names, `evidence`
 * for a person, `findings` for a program, and `by`/`reason` for a waiver.
 */
function stepStateOf(key: string, action: Action): StepState {
  const base = { step: key, onSha: action.onSha, by: null, reason: null }
  switch (action.yields) {
    case 'verdict':
      switch (action.result._tag) {
        case 'Completed':
          return {
            ...base,
            verdict: action.result.assessment.verdict === 'accepted' ? 'passed' : 'failed',
            evidence: action.evidence,
            findings: action.result.assessment.findings,
          }
        case 'AnswerUnreadable':
          return { ...base, verdict: 'failed', evidence: action.evidence, findings: [] }
        case 'Interrupted':
          return { ...base, verdict: 'did-not-finish', evidence: action.evidence, findings: [] }
        case 'NeverStarted':
          return { ...base, verdict: 'never-ran', evidence: action.evidence, findings: [] }
        case 'Waived':
          return { ...base, verdict: 'waived', evidence: null, findings: [] }
      }
      break
    case 'commit':
      switch (action.result._tag) {
        case 'Completed':
          return {
            ...base,
            verdict: action.result.question !== null ? 'asked' : 'passed',
            evidence: action.result.question ?? action.evidence,
            findings: [],
          }
        case 'Interrupted':
          return { ...base, verdict: 'did-not-finish', evidence: action.evidence, findings: [] }
        case 'NotDone':
          return { ...base, verdict: 'failed', evidence: action.evidence, findings: [] }
        case 'NeverStarted':
          return { ...base, verdict: 'never-ran', evidence: action.evidence, findings: [] }
        case 'Waived':
          return { ...base, verdict: 'waived', evidence: null, findings: [] }
      }
      break
    case 'design':
      switch (action.result._tag) {
        case 'Drafted':
          return { ...base, verdict: 'passed', evidence: action.evidence, findings: [] }
        case 'Asked':
          return { ...base, verdict: 'asked', evidence: action.result.question, findings: [] }
        case 'AnswerUnreadable':
          return { ...base, verdict: 'failed', evidence: action.evidence, findings: [] }
        case 'Interrupted':
        case 'NotDone':
          return { ...base, verdict: 'did-not-finish', evidence: action.evidence, findings: [] }
        case 'NeverStarted':
          return { ...base, verdict: 'never-ran', evidence: action.evidence, findings: [] }
        case 'Waived':
          return { ...base, verdict: 'waived', evidence: null, findings: [] }
      }
      break
    case 'signoff':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.requested === null
            ? { ...base, verdict: 'passed', evidence: action.evidence, findings: [] }
            : { ...base, verdict: 'asked', evidence: action.result.requested.question, findings: [] }
        case 'NotDone':
          return { ...base, verdict: 'failed', evidence: action.evidence, findings: [] }
        case 'Waived':
          return { ...base, verdict: 'waived', evidence: null, findings: [] }
      }
      break
    case 'merge':
      switch (action.result._tag) {
        case 'Completed':
          return {
            ...base,
            verdict: action.result.integration._tag === 'Integrated' ? 'passed' : 'failed',
            evidence: action.evidence,
            findings: [],
          }
        case 'Waived':
          return { ...base, verdict: 'waived', evidence: null, findings: [] }
      }
      break
    case 'worktree':
      switch (action.result._tag) {
        case 'Completed':
          return { ...base, verdict: 'passed', evidence: action.evidence, findings: [] }
        case 'NotDone':
          return { ...base, verdict: 'failed', evidence: action.evidence, findings: [] }
        case 'Waived':
          return { ...base, verdict: 'waived', evidence: null, findings: [] }
      }
      break
    case 'nothing':
      switch (action.result._tag) {
        case 'Completed':
          return { ...base, verdict: 'passed', evidence: action.evidence, findings: [] }
        case 'NotDone':
          return { ...base, verdict: 'failed', evidence: action.evidence, findings: [] }
        case 'Waived':
          return { ...base, verdict: 'waived', evidence: null, findings: [] }
      }
      break
  }
  return { ...base, verdict: 'failed', evidence: action.evidence, findings: [] }
}

export function applyRun(state: RunState, event: Envelope): RunState {
  const at = { version: event.version, lastSeq: event.seq }

  switch (event.type) {
    case 'RunStarted': {
      const d = event.data as PayloadOf<'RunStarted'>
      return {
        ...state,
        ...at,
        lifecycle: { status: 'running' },
        ticketId: d.ticketId,
        runtime: d.runtime,
        model: d.model,
        promptVersion: d.promptVersion,
        baseSha: d.baseSha,
        configHash: d.configHash,
        worktree: d.worktree,
        invocation: d.invocation,
      }
    }

    case 'RunPrompted': {
      const d = event.data as PayloadOf<'RunPrompted'>
      // The count is what it always was; the text is what #88 added. A v1 event
      // has none, and leaving the previous one in place would be a lie about
      // which prompt this run was given.
      return { ...state, ...at, prompts: state.prompts + 1, prompt: d.prompt }
    }

    case 'RunTouchedFile': {
      const d = event.data as PayloadOf<'RunTouchedFile'>
      return { ...state, ...at, touched: [...state.touched, d] }
    }

    case 'RunContextExhausted': {
      const d = event.data as PayloadOf<'RunContextExhausted'>
      return { ...state, ...at, compactedAtTurns: [...state.compactedAtTurns, d.turn] }
    }

    case 'RunAwaitingInput': {
      const d = event.data as PayloadOf<'RunAwaitingInput'>
      // The board lights up instead of the run burning to the wall clock.
      return { ...state, ...at, lifecycle: { status: 'awaiting-input', prompt: d.prompt } }
    }

    case 'RunProducedDiff': {
      const d = event.data as PayloadOf<'RunProducedDiff'>
      return {
        ...state,
        ...at,
        branch: d.branch,
        headSha: d.headSha,
        diff: { files: d.files, insertions: d.insertions, deletions: d.deletions },
        lifecycle: state.lifecycle.status === 'awaiting-input' ? { status: 'running' } : state.lifecycle,
      }
    }

    case 'RunProposedCompletion': {
      const d = event.data as PayloadOf<'RunProposedCompletion'>
      // The moment the gate pipeline fires.
      return { ...state, ...at, headSha: d.headSha, lifecycle: { status: 'gating', headSha: d.headSha } }
    }

    case 'RunFinished': {
      const d = event.data as PayloadOf<'RunFinished'>
      return {
        ...state,
        ...at,
        receipt: d,
        lifecycle: { status: 'finished', exitCode: d.exitCode, turns: d.turns, durationMs: d.durationMs },
      }
    }

    case 'RunFailed': {
      const d = event.data as PayloadOf<'RunFailed'>
      return { ...state, ...at, lifecycle: { status: 'failed', kind: d.kind, detail: d.detail } }
    }

    // No per-action step any more (0120's own Consequences: the board loses
    // which action of a step is running). `StepStarted` is once per step, so
    // there is nothing here to key a `StepState` by — `lingtai attach`'s run
    // log is where a running step's current action is now.
    case 'StepStarted':
      return { ...state, ...at }

    case 'StepEnded': {
      const d = event.data as PayloadOf<'StepEnded'>
      let next = state
      for (const action of d.outcome.actions) {
        if (action.result._tag === 'NotReached') continue
        const key = `${d.outcome.step}:${action.name}`
        next = { ...next, steps: withStep(next, stepStateOf(key, action)) }
        if (action.yields === 'signoff' && action.result._tag === 'Completed' && action.result.requested !== null) {
          next = {
            ...next,
            lifecycle: {
              status: 'awaiting-approval',
              step: key,
              onSha: action.onSha,
              question: action.result.requested.question,
            },
          }
        }
      }
      return { ...next, ...at }
    }

    default:
      // See the note in work-item.ts: ignored, not rejected.
      return { ...state, ...at }
  }
}

export function reduceRun(events: readonly Envelope[]): RunState {
  return events.reduce(applyRun, emptyRun)
}
