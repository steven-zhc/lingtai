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
import { isReached, type Reached } from './action.ts'
import type { Envelope } from './envelope.ts'
import type { Invocation, PayloadOf, RunFailureKind, RuntimeId, Severity } from './events.ts'
import { routeNext } from './routing.ts'
import type { Finding, Step } from './vocabulary.ts'

/**
 * `never-ran` is not a verdict about the diff, and is here because the absence
 * of one has to be readable ([0031](../../../doc/decisions-archive/0031-a-run-that-never-started.md)
 * §1, one layer up). The gate's agent never started — a quota, a signed-out
 * runtime — so nothing was judged. Reducing it into `failed` is what `#133` is
 * about; reducing it into `passed` would be worse.
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
export type StepVerdict = 'passed' | 'failed' | 'never-ran' | 'did-not-finish' | 'asked' | 'waived'

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

export type AttemptLifecycle =
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

export type AttemptStatus = AttemptLifecycle['status']

export interface AttemptState {
  lifecycle: AttemptLifecycle

  ticketId: string | null
  runtime: RuntimeId | null
  model: string | null
  promptVersion: string | null
  baseSha: string | null
  worktree: string | null
  /**
   * How the runtime was actually invoked: the command, the argv, the tier and
   * the limits as applied. Null for a v1 `RunStarted`, and for a runtime that
   * cannot describe its own invocation (#88).
   */
  invocation: Invocation | null

  /** Current head of the agent's branch. Changes invalidate gate verdicts. */
  headSha: string | null
  /** The last `RunProducedDiff`, whole. `headSha` has a second writer, so it is not a copy of this. */
  produced: PayloadOf<'RunProducedDiff'> | null

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
  /**
   * The last `RunPrompted`'s own version and byte count. Not `promptVersion`,
   * which is `RunStarted`'s. Kept for a v1 event too, which has no text.
   */
  promptMeta: { version: string; bytes: number } | null

  /** Latest verdict per gate name, each carrying the sha it was made against. */
  steps: Readonly<Record<string, StepState>>

  /**
   * The last step entered and not yet ended, with the round it was entered on
   * (D12). A `StepEnded` for a different step leaves it; `RunFinished` and
   * `RunFailed` do not touch it, so a run that died inside a step still says
   * which — whether the run is over is `lifecycle`'s to say.
   */
  step: { step: Step; round: number; since: Date } | null
  /** The `at` of the first event reduced, whatever its type. Set once. */
  openedAt: Date | null
  /** The `at` of the last `RunStarted`. */
  agentStartedAt: Date | null
  /** The `at` of the last `StepEnded` that set the lifecycle to awaiting-approval. Never cleared. */
  askedAt: Date | null
  /** The `at` of the last `MergeLaneWaited`. Never cleared. */
  laneWaitedAt: Date | null
  /** The last `StepsResolved`: the plan the run was given, with the hash of the recipe it came from. */
  resolved: {
    readonly configHash: string
    readonly steps: readonly { readonly step: Step; readonly actions: readonly string[] }[]
  } | null
  /**
   * The highest round an `implement` step started on or a `FixRound` route
   * reached, 0 before either. Not `step.round`, which is any step's.
   */
  implementRound: number
  /**
   * Every round a `FixRound` route opened, in log order. Nothing removes one:
   * which of them a person's grant paid for is `spend`'s to say.
   */
  roundsOpened: readonly number[]

  /** The last `RunFailed`. Never cleared: a later `RunFinished` does not undo it (D3). */
  failure: { readonly kind: RunFailureKind; readonly detail: string } | null
  /** The last refused verdict, by `step:action` key. Not cleared by a later pass or a new head. */
  refusal: { readonly key: string; readonly evidence: string; readonly findings: readonly Finding[] } | null

  receipt: { exitCode: number; turns: number; durationMs: number } | null

  /** The last `PassRouted`, as written — the raw payload, not `routeNext`'s answer. */
  route: PayloadOf<'PassRouted'> | null
  /** The last `RunRefsPublished`, whatever its outcome — a later `unrecorded` row replaces a `published` one. */
  published: PayloadOf<'RunRefsPublished'> | null
  /** Every `RunKeptUncommitted`, in order. */
  kept: readonly PayloadOf<'RunKeptUncommitted'>[]

  version: number
  lastSeq: bigint | null
}

export const emptyAttempt: AttemptState = {
  lifecycle: { status: 'pending' },
  ticketId: null,
  runtime: null,
  model: null,
  promptVersion: null,
  baseSha: null,
  worktree: null,
  invocation: null,
  headSha: null,
  produced: null,
  failure: null,
  refusal: null,
  touched: [],
  compactedAtTurns: [],
  prompts: 0,
  prompt: null,
  promptMeta: null,
  steps: {},
  step: null,
  openedAt: null,
  agentStartedAt: null,
  askedAt: null,
  laneWaitedAt: null,
  resolved: null,
  implementRound: 0,
  roundsOpened: [],
  receipt: null,
  route: null,
  published: null,
  kept: [],
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
export function stepsOn(state: AttemptState): StepState[] {
  if (state.headSha === null) return []
  return Object.values(state.steps).filter((g) => g.onSha === state.headSha)
}

/**
 * The files the agent touched: each path once, at the position of its first
 * touch, with the op of its last.
 */
export function filesOf(state: AttemptState): { path: string; op: 'edit' | 'write' | 'delete' }[] {
  const files = new Map<string, { path: string; op: 'edit' | 'write' | 'delete' }>()
  for (const t of state.touched) files.set(t.path, { path: t.path, op: t.op })
  return [...files.values()]
}

function withStep(state: AttemptState, step: StepState): Readonly<Record<string, StepState>> {
  return { ...state.steps, [step.step]: step }
}

/**
 * The one ladder: a reached action read as the `StepVerdict` every surface
 * shows — `AttemptState.steps`, `task_view`'s cards and the board. An exhaustive
 * switch over `yields` × `result._tag`, with no default and no fallback; a
 * `NotReached` action has no verdict and cannot be passed (`isReached`).
 */
export function verdictOf(action: Reached): StepVerdict {
  switch (action.yields) {
    case 'verdict':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.assessment.verdict === 'accepted' ? 'passed' : 'failed'
        case 'AnswerUnreadable':
        case 'DiffTooLarge':
          return 'failed'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NeverStarted':
          return 'never-ran'
        case 'Waived':
          return 'waived'
      }
    // eslint-disable-next-line no-fallthrough
    case 'commit':
      switch (action.result._tag) {
        case 'Completed':
          // `question` first: an agent that asked is `asked` whether or not it
          // also committed. A `head` of `null` is *produced nothing*.
          if (action.result.question !== null) return 'asked'
          return action.result.head !== null ? 'passed' : 'did-not-finish'
        case 'Interrupted':
          return 'did-not-finish'
        case 'NotDone':
          return 'failed'
        case 'NeverStarted':
          return 'never-ran'
        case 'Waived':
          return 'waived'
      }
    // eslint-disable-next-line no-fallthrough
    case 'design':
      switch (action.result._tag) {
        case 'Drafted':
          return 'passed'
        case 'Asked':
          return 'asked'
        case 'AnswerUnreadable':
          return 'failed'
        case 'Interrupted':
        case 'NotDone':
          return 'did-not-finish'
        case 'NeverStarted':
          return 'never-ran'
        case 'Waived':
          return 'waived'
      }
    // eslint-disable-next-line no-fallthrough
    case 'signoff':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.requested === null ? 'passed' : 'asked'
        case 'NotDone':
          return 'failed'
        case 'Waived':
          return 'waived'
      }
    // eslint-disable-next-line no-fallthrough
    case 'merge':
      switch (action.result._tag) {
        case 'Completed':
          return action.result.integration._tag === 'Integrated' ? 'passed' : 'failed'
        case 'Waived':
          return 'waived'
      }
    // eslint-disable-next-line no-fallthrough
    case 'worktree':
      switch (action.result._tag) {
        case 'Completed':
          return 'passed'
        case 'NotDone':
          return 'did-not-finish'
        case 'Waived':
          return 'waived'
      }
    // eslint-disable-next-line no-fallthrough
    case 'nothing':
      switch (action.result._tag) {
        case 'Completed':
          return 'passed'
        case 'NotDone':
          return 'failed'
        case 'Waived':
          return 'waived'
      }
  }
}

/** The question a reached action carries, if it asked one — a string, not a verdict. */
function questionOf(action: Reached): string | null {
  switch (action.yields) {
    case 'commit':
      return action.result._tag === 'Completed' ? action.result.question : null
    case 'design':
      return action.result._tag === 'Asked' ? action.result.question : null
    case 'signoff':
      return action.result._tag === 'Completed' ? (action.result.requested?.question ?? null) : null
    default:
      return null
  }
}

/** One reached `Action` (0120 §1) as the `StepState` this aggregate keeps. */
function stepStateOf(key: string, action: Reached): StepState {
  const verdict = verdictOf(action)
  return {
    step: key,
    onSha: action.onSha,
    by: null,
    reason: null,
    verdict,
    evidence: verdict === 'waived' ? null : (questionOf(action) ?? action.evidence),
    findings:
      action.yields === 'verdict' && action.result._tag === 'Completed' ? action.result.assessment.findings : [],
  }
}

export function reduceAttemptEvent(state: AttemptState, event: Envelope): AttemptState {
  const at = { version: event.version, lastSeq: event.seq, openedAt: state.openedAt ?? event.at }

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
        worktree: d.worktree,
        invocation: d.invocation,
        agentStartedAt: event.at,
      }
    }

    case 'RunPrompted': {
      const d = event.data as PayloadOf<'RunPrompted'>
      // The count is what it always was; the text is what #88 added. A v1 event
      // has none, and leaving the previous one in place would be a lie about
      // which prompt this run was given.
      return {
        ...state,
        ...at,
        prompts: state.prompts + 1,
        prompt: d.prompt,
        promptMeta: { version: d.promptVersion, bytes: d.bytes },
      }
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
        produced: d,
        headSha: d.headSha,
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
      return {
        ...state,
        ...at,
        failure: { kind: d.kind, detail: d.detail },
        lifecycle: { status: 'failed', kind: d.kind, detail: d.detail },
      }
    }

    // No per-action step any more (0120's own Consequences: the board loses
    // which action of a step is running), so nothing keys a `StepState` by it.
    // `StepStarted` sets `step` and raises `implementRound` when it is an
    // `implement` start; `lingtai attach`'s run log is where a running step's
    // current action is now.
    case 'StepStarted': {
      const d = event.data as PayloadOf<'StepStarted'>
      return {
        ...state,
        ...at,
        step: { step: d.step, round: d.round, since: event.at },
        implementRound: d.step === 'implement' ? Math.max(state.implementRound, d.round) : state.implementRound,
      }
    }

    // A fix round's route reaches its round whichever step it names (`to`).
    // `routeNext` throws `ImpossibleRouteError` on a stored route it cannot
    // replay, as the projections already do; nothing here hides that.
    case 'PassRouted': {
      const d = event.data as PayloadOf<'PassRouted'>
      const next = routeNext(d.offer, d.reply, d.decision, { runId: d.runId })
      return next._tag === 'FixRound'
        ? {
            ...state,
            ...at,
            implementRound: Math.max(state.implementRound, next.round),
            roundsOpened: [...state.roundsOpened, next.round],
            route: d,
          }
        : { ...state, ...at, route: d }
    }

    case 'StepEnded': {
      const d = event.data as PayloadOf<'StepEnded'>
      let next = state
      for (const action of d.outcome.actions) {
        if (!isReached(action)) continue
        const key = `${d.outcome.step}:${action.name}`
        next = { ...next, steps: withStep(next, stepStateOf(key, action)) }
        if (
          action.yields === 'verdict' &&
          action.result._tag === 'Completed' &&
          action.result.assessment.verdict === 'refused'
        ) {
          next = {
            ...next,
            refusal: { key, evidence: action.evidence, findings: action.result.assessment.findings },
          }
        }
        if (action.yields === 'signoff' && action.result._tag === 'Completed' && action.result.requested !== null) {
          next = {
            ...next,
            askedAt: event.at,
            lifecycle: {
              status: 'awaiting-approval',
              step: key,
              onSha: action.onSha,
              question: action.result.requested.question,
            },
          }
        }
      }
      const ended = d.outcome.step
      return { ...next, ...at, step: state.step?.step === ended ? null : state.step }
    }

    case 'StepsResolved': {
      const d = event.data as PayloadOf<'StepsResolved'>
      return { ...state, ...at, resolved: { configHash: d.configHash, steps: d.steps } }
    }

    case 'MergeLaneWaited':
      return { ...state, ...at, laneWaitedAt: event.at }

    case 'RunRefsPublished':
      return { ...state, ...at, published: event.data as PayloadOf<'RunRefsPublished'> }

    case 'RunKeptUncommitted':
      return { ...state, ...at, kept: [...state.kept, event.data as PayloadOf<'RunKeptUncommitted'>] }

    default:
      // See the note in ticket.ts: ignored, not rejected.
      return { ...state, ...at }
  }
}

/**
 * Whether a held run left a clean pushed head a fix round can continue from, and
 * if not, why. The conductor's grant, `lingtai status` and the board all ask
 * this; each words the answer itself.
 */
export type SavedHead =
  | { readonly _tag: 'Saved'; readonly head: string; readonly ref: string }
  | { readonly _tag: 'WipHead'; readonly arm: string; readonly armSha: string; readonly recorded: boolean }
  | { readonly _tag: 'BranchDiverged'; readonly arm: string; readonly branch: string }
  | { readonly _tag: 'NoSavedHead' }

/**
 * The rules, in the order the grant checks them: a WIP head first, then a
 * diverged branch, then no head at all. A row without `branchCarries` is carried.
 */
export function savedHeadOf(state: AttemptState): SavedHead {
  const saved = state.published
  if (saved === null) return { _tag: 'NoSavedHead' }
  // A WIP commit on the arm does not taint the clean head already published on
  // the issue branch. Continue that head; never cut from the WIP arm.
  const cleanBranch =
    (saved.outcome === 'published' || saved.outcome === 'already-published') && saved.branchCarries !== false
  if (saved.armSha != null && !cleanBranch) {
    const armSha = saved.armSha
    return {
      _tag: 'WipHead',
      arm: saved.arm,
      armSha,
      recorded: state.kept.some((k) => k.sha === armSha && k.arm === saved.arm),
    }
  }
  if (saved.outcome === 'arm-only') return { _tag: 'BranchDiverged', arm: saved.arm, branch: saved.branch }
  if (!cleanBranch || !saved.headSha || !saved.branch) return { _tag: 'NoSavedHead' }
  return { _tag: 'Saved', head: saved.headSha, ref: saved.branch }
}

export function reduceAttempt(events: readonly Envelope[]): AttemptState {
  return events.reduce(reduceAttemptEvent, emptyAttempt)
}
