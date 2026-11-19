/**
 * Ending a wait — the single entry point 0118 §11 asks for (#465).
 *
 * **The only writer of `WaitResolved`.** Before this there were three:
 * `approve.ts` wrote it twice (granting an approval, and absorbing a
 * requeue) and `ask.ts` wrote it once (answering a question asked before any
 * run). All three now call `resolveWait`, which does the one thing every one
 * of them did separately and inconsistently — check the wait is current,
 * check the resolution is offered, and for `Approve` only, check the sha is
 * not stale — before the append.
 *
 * **`allowedResolutions` is enforced here for every caller at once**, which
 * is `#443`'s first half: before this, `approve.ts`'s own `approveHolding`
 * never consulted `wait.ts`'s table at all (`wait-handlers-answer-as-today
 * .test.ts`'s own pinned disagreement, now resolved in the table's favour).
 * `#443`'s other half — dropping `blocked`/`asked`/`needs`/`diagnosis` off a
 * resolved wait — is a different rebuild and stays untouched here.
 *
 * **Not the continuation itself.** An `Approve` here only appends
 * `WaitResolved{Approve}` — 0118 §11, §6's own reading of 0120: whichever
 * process holds the conductor lock takes the continuation up from there
 * (`WAIT_EVENTS`, `@lingtai/daemon`'s completion events). That caller is not
 * built by this file; `continuationOf` (`@lingtai/domain/wait`) is what tells
 * it where to continue and what to waive once it does.
 */
import {
  CONTROL_STREAM,
  matchHead,
  parsePayload,
  parseTicketStream,
  type PayloadOf,
  type BlockedLifecycle,
  type ResolveRefusal,
  type TicketState,
  attemptReducer,
  triageAnswersText,
  triageFactsFromState,
  type AttemptState,
  rerunHeadOf,
  savedHeadOf,
  type ToAppend,
  type WaitId,
} from '@lingtai/domain'
import {
  describeSplitProblem,
  splitPlanProblems,
  triageCauseOf,
  type Resolution,
  type WaitReason,
} from '@lingtai/domain/wait'
import { type EventStore, eventStore, log, readThroughSnapshot, type SnapshotReadOptions } from '@lingtai/event-store'
import { Effect } from 'effect'

import { diffBaseShaOf } from './attempts.ts'
import { agentBranch } from './branches.ts'
import { decidingEffect } from './deciding.ts'
import { asFailure } from './port-face.ts'
import type { IssueChannel } from './tell.ts'
import { type PreparedResolve, resolveTicketWaitEffect } from './ticket/commands.ts'
import { writeSectionEffect } from './write-section.ts'

/**
 * The gates still refusing the sha an approval is about, by `point:action`.
 *
 * **Read off the run, never named by a caller** (#150). The Waive button took
 * a gate from the card, and the home board's card sent the literal `"build"`
 * — so a waived `review` went on the log as a waived `build`. Nothing a
 * person clicks names a gate any more; the run says which ones refused.
 *
 * `failed`, `never-ran`, `did-not-finish` and `asked` alike: a gate whose
 * agent never started, started and produced no receipt, or stopped to ask
 * something, did not pass either, and resolving over one is resolving past a
 * point nobody judged. A verdict on any other sha is not about this diff and
 * is left out, as `stepsOn` does.
 *
 * `asked` is the newest of the four and belongs here for the reason the
 * other three do rather than for a new one (`#296`): *there is a question
 * about this diff and nobody answered it* is not a judgement of it.
 *
 * **Excludes the signoff this approval is itself answering** (#502). Since
 * `StepEnded` carries every action's own result, a `signoff` still asking for
 * approval reduces onto `run.steps` as `verdict: 'asked'` too (`stepStateOf`'s
 * `signoff` case, `run.ts`) — the same tag a design agent's own clarifying
 * question gets, because neither is a judgement of the diff. But the point
 * this function exists to answer is *what else* is unjudged, and the signoff
 * `run.lifecycle.step` names is the thing being approved, not a second
 * refusal to waive: every approval would otherwise demand a reason for
 * answering its own question.
 */
const UNPASSED = new Set(['failed', 'never-ran', 'did-not-finish', 'asked'])

export function refusingOn(run: AttemptState, onSha: string): string[] {
  const awaiting = run.lifecycle.status === 'awaiting-approval' ? run.lifecycle.step : null
  return Object.values(run.steps)
    .filter((g) => g.onSha === onSha && UNPASSED.has(g.verdict) && g.step !== awaiting)
    .map((g) => g.step)
}

/** `SignoffRequired`, or `ProposedEscalated{BuildRed}` — a wait reason, in the words a refusal names it by. */
export function describeReason(reason: WaitReason): string {
  return reason._tag === 'ProposedEscalated' ? `ProposedEscalated{${reason.proposal._tag}}` : reason._tag
}

export interface ResolveWaitOptions extends SnapshotReadOptions {
  ticketId: string
  /**
   * The GitHub issue number — read only for `Approve`'s branch check
   * (`agentBranch`). A caller resolving anything else never needs one.
   */
  issue?: number
  waitId: WaitId
  resolution: Resolution
  /** The exact text `editBodyAndRequeue` handed `writeSection`; read only for `EditBodyAndStartNewAttempt`. */
  writtenSection?: string
  /** Recorded on the resolution. A waiver, a close, an answer — none of them is anonymous. */
  by: string
  /** The system's split only (0118 §12): recorded as the conductor's, releasing the claim without spending a new attempt. */
  system?: boolean
  /** Why. Required only where `Approve` is waiving a refusal still standing on the sha — see `refusingOn`. */
  note?: string
  /**
   * Events appended after `WaitResolved`, in the same append — `close()`'s
   * `TicketClosed` and its `end` plan, kept in one transaction with the wait
   * it resolves (`close.ts`'s own rule, carried over rather than relaxed).
   */
  with?: readonly ToAppend[]
  /**
   * Only read for `Approve` — the branch's current head on origin, checked
   * against the sha the approval names. Omitted by a caller with no GitHub
   * to reach; the sha-vs-run check below still runs either way.
   */
  client?: { refSha(ref: string): Promise<string | null> }
  /**
   * The recipe's `source.kinds` — read only for `Split`, whose children each
   * need one of them or the queue never sees the child.
   */
  kinds?: readonly string[]
  /**
   * Only read for `Split`: the `TicketSplit` payload `splitTicket` built once
   * every GitHub write was read back. It is appended in the same transaction,
   * ahead of `WaitResolved` (0118 §12), so a split with no children written
   * cannot resolve the wait.
   */
  split?: unknown
  /**
   * Where the wait's triage answers are written (#921) — read only for
   * `FixRefusal` and `StartNewAttempt` on a wait whose triage asked questions.
   */
  github?: IssueChannel
  /** A question's index in `triageQuestionsOf`'s order → the answer id picked. A missing index takes the recommended answer. */
  picks?: Readonly<Record<number, string>>
  store?: EventStore
}

export type ResolveWaitResult =
  | {
      ok: true
      ticketId: string
      /**
       * Set only when the `ContinueRequested` append below exhausted its
       * retries — the approval still happened, but nothing is yet waiting
       * to take the continuation up. The last error's own message, so a
       * caller can say why rather than just that. See the append's own
       * comment for what makes this never a reason to answer `ok: false`.
       */
      unscheduled?: string
    }
  | {
      ok: false
      ticketId: string
      reason: string
      detail: string
      /** Set when the triage answers were written into the body before this refused. */
      written?: boolean
    }

export function resolveWait(options: ResolveWaitOptions): Promise<ResolveWaitResult> {
  return Effect.runPromise(resolveWaitEffect(options))
}

export function resolveWaitEffect(options: ResolveWaitOptions): Effect.Effect<ResolveWaitResult, unknown> {
  const ticketId = options.ticketId
  return decidingEffect<ResolveWaitResult, unknown, never>(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      reason: 'busy',
      detail: `${ticketId} is being decided by someone else right now. Nothing was resolved — reload and read it again.`,
    }),
    resolveWaitHoldingEffect(
      { ...options, snapshots: options.snapshots ?? (options.store === undefined ? log.snapshots : undefined) },
      ticketId,
    ),
  )
}

export function resolveWaitHoldingEffect(
  options: ResolveWaitOptions,
  ticketId: string,
): Effect.Effect<ResolveWaitResult, unknown> {
  return Effect.gen(function* () {
    const store = options.store ?? eventStore
    const note = options.note?.trim() ?? ''

    // **A confirmation ends the ticket, so it is not a plain resolution** (#1251): `TicketSatisfied` and the recipe's
    // `satisfied` end plan ride in the same append (`confirmSatisfiedEffect`), and a generic resolve would answer the
    // wait and leave the ticket open. Refused by name here; the caller that offers the button is #1252's.
    if (options.resolution._tag === 'ConfirmSatisfied')
      return {
        ok: false,
        ticketId,
        reason: 'confirm-satisfied',
        detail: `confirming ${ticketId} as satisfied ends it, and is not a plain resolution — nothing was resolved.`,
      }

    if (
      options.resolution._tag === 'FixRefusal' &&
      options.resolution.onSha &&
      matchHead(options.resolution.onSha, '') === 'bad-sha'
    )
      return {
        ok: false,
        ticketId,
        reason: 'bad-sha',
        detail: `--if-head needs a commit SHA of at least 7 hex characters, not ${options.resolution.onSha} — nothing was resolved.`,
      }

    // **The way out of a continuation this call could not schedule**: a second
    // `Approve` naming the very same wait and sha is not a second resolution, so
    // the owner appends nothing and answers `repeat` (#465). `WaitResolved{Approve}`
    // already committed the first time, but the retried `ContinueRequested` append
    // below may have exhausted its retries and left no row for a conductor to
    // act on — this asks only for the row the first one was owed.
    const outcome = yield* resolveTicketWaitEffect<ResolveWaitResult>(ticketId, {
      store,
      snapshots: options.snapshots,
      writer: options.writer,
      waitId: options.waitId,
      resolution: options.resolution,
      by: options.by,
      note,
      ...(options.system ? { system: true } : {}),
      split: options.split,
      with: options.with,
      prepare: (item, block) => prepare(options, store, ticketId, note, item, block),
    })
    if (!outcome.ok) {
      if ('refused' in outcome) return outcome.refused
      if ('refusal' in outcome) {
        return outcome.refusal.reason === 'not-blocked' && outcome.written
          ? {
              ok: false,
              ticketId,
              reason: 'not-blocked',
              detail: `${ticketId} is not waiting on ${options.waitId} any more — the answers were written into the body, nothing was resolved.`,
              written: true,
            }
          : resolveRefusal(ticketId, outcome.refusal)
      }
      return staleResult(ticketId, outcome.written)
    }
    if (outcome.kind === 'repeat') {
      const parsed = parseTicketStream(ticketId)!
      const unscheduled = yield* requestContinuation(store, options.by, parsed.project, parsed.issue, outcome.runId)
      return unscheduled === null ? { ok: true, ticketId } : { ok: true, ticketId, unscheduled }
    }
    const { resolution, runId } = outcome

    // **What tells the next pass which issue to look at, not what wakes it**
    // (`ContinueRequested`'s own header, #465) — `WaitResolved` above is
    // already in `WAIT_EVENTS`, which wakes the work loop on its own. A
    // separate append, on the control stream rather than the ticket's, so a
    // store that refuses it costs this approval nothing: `conductWork` re-reads
    // the ticket stream before acting on a row here and refuses the stale ones
    // on its own (`continueTicket`), so a request this append loses is simply
    // never offered rather than acted on wrongly.
    //
    // **For that to be true, this must never throw.** `WaitResolved` above has
    // already committed — this is a second, separate operation, and a caller
    // that reported the approval failed because *this* one lost a race would
    // be reporting something false. Retried on *any* error, never only a
    // `ConcurrencyError`: a dropped connection is as transient as a lost
    // version race (`CLAUDE.md`'s own notes on the pooler record it as
    // routine), and both the read and the append below can hit one. The bound
    // is still five attempts, the same `recordStart`/
    // `requestShutdownUnlessStanding` (`@lingtai/daemon`'s own `CONTROL_STREAM`
    // writers) use. Never rethrown even once the retries run out: a
    // continuation this call could not schedule is a gap for something else to
    // notice (`unscheduled`, below, and `approve()`'s own "way out" above), not
    // a reason to say the approval itself did not happen.
    let unscheduled: string | undefined
    if (
      resolution._tag === 'Approve' ||
      resolution._tag === 'FixRefusal' ||
      resolution._tag === 'RedoStep' ||
      resolution._tag === 'AnswerQuestions'
    ) {
      const parsed = parseTicketStream(ticketId)
      if (parsed !== null) {
        unscheduled = (yield* requestContinuation(store, options.by, parsed.project, parsed.issue, runId!)) ?? undefined
      }
    }

    return unscheduled === undefined ? { ok: true, ticketId } : { ok: true, ticketId, unscheduled }
  })
}

type Refused = { ok: false; ticketId: string; reason: string; detail: string; written?: boolean }

/**
 * What the ticket's state cannot say: the split plan against the recipe, the saved head and the remote ref, `Approve`'s
 * checks and the wait's triage answers written into the body. Run by the owner between its read and its append, against
 * that same read, so no check here refuses on a ticket the append would not have been made against.
 */
function prepare(
  options: ResolveWaitOptions,
  store: EventStore,
  ticketId: string,
  note: string,
  item: TicketState,
  block: BlockedLifecycle,
): Effect.Effect<{ ok: true; prepared: PreparedResolve } | { ok: false; refused: Refused }, unknown> {
  return Effect.gen(function* () {
    const refuse = (refused: Refused) => ({ ok: false, refused }) as const
    // **A split is checked, and resolves only with its written children (#561,
    // #562, #601).** Every refusal returns before any append.
    if (options.resolution._tag === 'Split') {
      if (options.kinds === undefined)
        return refuse({
          ok: false,
          ticketId,
          reason: 'no-kinds',
          detail:
            "a split needs the recipe's kinds to check each child is visible to the queue — nothing was resolved.",
        })
      const problems = splitPlanProblems(options.resolution, { kinds: options.kinds })
      if (problems.length > 0)
        return refuse({
          ok: false,
          ticketId,
          reason: 'invalid-split',
          detail: `the split plan is refused — nothing was created or resolved: ${problems.map(describeSplitProblem).join('; ')}.`,
        })
    }

    let resolution = options.resolution
    if (resolution._tag === 'FixRefusal') {
      const saved = yield* savedHead(store, ticketId, block.runId, {
        snapshots: options.snapshots,
        writer: options.writer,
      })
      if (!saved.ok) return refuse(saved)
      const { head, ref } = saved
      if (resolution.onSha && matchHead(resolution.onSha, head) !== 'match') {
        return refuse({
          ok: false,
          ticketId,
          reason: 'stale',
          detail: `The saved head is ${head}, not the displayed ${resolution.onSha}. Reload this wait before granting a round.`,
        })
      }
      if (options.client === undefined)
        return refuse({
          ok: false,
          ticketId,
          reason: 'no-client',
          detail: 'A remote ref check is required before granting a fix round.',
        })
      const remote = yield* refShaOrNull(options.client, `heads/${ref}`)
      if (remote !== head) {
        return refuse({
          ok: false,
          ticketId,
          reason: 'stale',
          detail: `${ref} is ${remote ?? 'missing'}, not the saved ${head}. Restore that ref to the saved head or requeue for a fresh attempt.`,
        })
      }
      resolution = { _tag: 'FixRefusal', onSha: head, ref }
    }

    if (resolution._tag === 'RedoStep' || resolution._tag === 'AnswerQuestions') {
      // **The saved head a rerun continues from** (#1218): `rerunHeadOf`'s own table, the one the re-cut reads, so
      // what this accepts is exactly what the next pass can cut. Every refusal is before any append.
      if (block.runId === null)
        return refuse({ ok: false, ticketId, reason: 'no-run', detail: 'No held run has work to continue.' })
      const state = yield* readThroughSnapshot(store, attemptReducer, block.runId, 'all', {
        snapshots: options.snapshots,
        writer: options.writer,
      })
      const head = rerunHeadOf(state)
      if ('cannot' in head)
        return refuse({
          ok: false,
          ticketId,
          reason: 'no-rerun-head',
          detail: `Run ${block.runId} has no saved head a rerun can continue: ${head.cannot}. Requeue for a fresh attempt.`,
        })
      let at: string
      let atRef: string | null = null
      if ('atBase' in head) {
        const base = diffBaseShaOf(yield* Effect.promise(() => store.read(block.runId!)))
        if (base === null)
          return refuse({
            ok: false,
            ticketId,
            reason: 'no-rerun-head',
            detail: `Run ${block.runId} recorded no base commit to rerun on. Requeue for a fresh attempt.`,
          })
        at = base
      } else {
        at = head.at
        atRef = head.atRef
      }
      if (resolution.onSha && matchHead(resolution.onSha, at) !== 'match') {
        return refuse({
          ok: false,
          ticketId,
          reason: 'stale',
          detail: `The saved head is ${at}, not the displayed ${resolution.onSha}. Reload this wait before rerunning.`,
        })
      }
      if (atRef !== null) {
        if (options.client === undefined)
          return refuse({
            ok: false,
            ticketId,
            reason: 'no-client',
            detail: 'A remote ref check is required before rerunning a step on the saved head.',
          })
        const remote = yield* refShaOrNull(options.client, `heads/${atRef}`)
        if (remote !== at) {
          return refuse({
            ok: false,
            ticketId,
            reason: 'stale',
            detail: `${atRef} is ${remote ?? 'missing'}, not the saved ${at}. Restore that ref to the saved head or requeue for a fresh attempt.`,
          })
        }
      }
      resolution =
        resolution._tag === 'RedoStep'
          ? { _tag: 'RedoStep', onSha: at, ref: atRef }
          : { ...resolution, onSha: at, ref: atRef }
    }

    if (resolution._tag === 'Approve') {
      const refused = yield* checkApprove(options, store, ticketId, block.runId, resolution.onSha, note, block.reason)
      if (refused !== null) return refuse(refused as Refused)
    }

    // **The wait's triage answers go into the body before it resolves** (#921,
    // 0118 §6): every refusal above has already returned, so a body is never
    // written for a refusal it was always going to get.
    let recorded: PayloadOf<'WaitResolved'>['answers']
    let wroteBody = false
    if (resolution._tag === 'EditBodyAndStartNewAttempt' && options.writtenSection !== undefined)
      recorded = { picks: [], section: options.writtenSection }
    if (resolution._tag === 'AnswerQuestions') {
      // **The answers are written before the wait resolves** (#1254, 0118 §6), and after every refusal above — the saved
      // head is checked first, so a body is never written for a continuation that cannot run. A failed write resolves
      // nothing: the wait stays open and the page keeps the person's text.
      const wait = item.waits.findLast((w) => w.waitId === options.waitId)
      const reason = wait?.reason
      const own =
        reason === undefined
          ? []
          : reason._tag === 'AgentQuestion'
            ? reason.questions
            : reason._tag === 'ProposedEscalated' && reason.proposal._tag === 'InputNeeded'
              ? reason.proposal.questions
              : []
      // A prose-only wait has no questions of its own: triage's are the ones the person was shown (#1254).
      const triaged = triageCauseOf(wait?.triage.result)
      const asked =
        own.length > 0 ? own : triaged !== null && triaged._tag === 'UndecidedQuestion' ? triaged.questions : []
      if (asked.length === 0)
        return refuse({
          ok: false,
          ticketId,
          reason: 'not-offered',
          detail: 'There is nothing to answer on this wait — nothing was resolved.',
        })
      const picks = Object.fromEntries(Object.entries(resolution.answers).map(([index, id]) => [Number(index), id]))
      const answers = triageAnswersText({ _tag: 'UndecidedQuestion', questions: asked }, picks)
      if (!answers.ok)
        return refuse({
          ok: false,
          ticketId,
          reason: 'stale',
          detail: `${answers.detail} — nothing was written or resolved. Reload and read it again.`,
        })
      if (options.github === undefined)
        return refuse({
          ok: false,
          ticketId,
          reason: 'no-github',
          detail:
            'The answers have to be written into the body first, and there is no GitHub to write to — nothing was resolved.',
        })
      const result = yield* writeSectionEffect({
        store,
        github: options.github,
        ticketId,
        key: `${ticketId}/${options.waitId}`,
        text: answers.text,
        verified: true,
      })
      if (!result.written) return refuse({ ok: false, ticketId, reason: 'write-failed', detail: result.detail })
      wroteBody = true
      recorded = { picks: answers.picks, section: answers.text }
    }
    if (resolution._tag === 'FixRefusal' || resolution._tag === 'StartNewAttempt') {
      const triage = triageFactsFromState(item, options.waitId).result
      const triaged = triageCauseOf(triage)
      const answers = triaged !== null ? triageAnswersText(triaged, options.picks) : null
      if (answers !== null && !answers.ok)
        return refuse({
          ok: false,
          ticketId,
          reason: 'stale',
          detail: `${answers.detail} — nothing was written or resolved. Reload and read it again.`,
        })
      if (answers !== null && answers.text !== '') {
        if (options.github === undefined)
          return refuse({
            ok: false,
            ticketId,
            reason: 'no-github',
            detail:
              "the wait's triage answers have to be written into the body first, and there is no GitHub to write to — nothing was resolved.",
          })
        const result = yield* writeSectionEffect({
          store,
          github: options.github,
          ticketId,
          key: `${ticketId}/${options.waitId}`,
          text: answers.text,
        })
        if (!result.written) return refuse({ ok: false, ticketId, reason: 'write-failed', detail: result.detail })
        wroteBody = true
        recorded = { picks: answers.picks, section: answers.text }
      }
    }
    return { ok: true, prepared: { resolution, ...(recorded ? { answers: recorded } : {}), wroteBody } } as const
  })
}

/** What the ticket's own refusal is called to the person, in the words it always was. */
export function resolveRefusal(ticketId: string, refusal: ResolveRefusal): Refused {
  switch (refusal.reason) {
    case 'not-blocked':
      return {
        ok: false,
        ticketId,
        reason: 'not-blocked',
        detail: `${ticketId} is not waiting on ${refusal.waitId} — nothing was resolved. Reload and read it again.`,
      }
    case 'not-offered':
      return {
        ok: false,
        ticketId,
        reason: 'not-offered',
        detail: `${refusal.resolution} is not offered for ${describeReason(refusal.waitReason)} — nothing was resolved.`,
      }
    case 'split-not-written':
      return {
        ok: false,
        ticketId,
        reason: 'split-not-written',
        detail: "the split's children have not been written to GitHub — nothing was resolved.",
      }
  }
}

/** The append lost to another writer: nothing was resolved, and it is never retried here. */
export function staleResult(ticketId: string, written: boolean): Refused & { written?: boolean } {
  return {
    ok: false,
    ticketId,
    reason: 'stale',
    detail: `${ticketId} moved while this was being resolved. Nothing was resolved — reload and read it again.`,
    ...(written ? { written } : {}),
  }
}

/**
 * The clean head a held run published and a fix can continue from.
 */
function savedHead(
  store: EventStore,
  ticketId: string,
  runId: string | null,
  read: SnapshotReadOptions = {},
): Effect.Effect<Refused | { ok: true; head: string; ref: string }, unknown> {
  return Effect.gen(function* () {
    if (runId === null) return { ok: false, ticketId, reason: 'no-run', detail: 'No held run has work to continue.' }
    const saved = savedHeadOf(yield* readThroughSnapshot(store, attemptReducer, runId, 'all', read))
    switch (saved._tag) {
      case 'Saved':
        return { ok: true, head: saved.head, ref: saved.ref }
      case 'WipHead':
        return {
          ok: false,
          ticketId,
          reason: saved.recorded ? 'wip-head' : 'unrecorded-wip',
          detail: saved.recorded
            ? `Run ${runId} saved uncommitted work as ${saved.armSha} on ${saved.arm}. Recover that work as a clean commit without the WIP commit in its ancestry, then requeue for a fresh attempt.`
            : `Run ${runId} names a WIP head on ${saved.arm} but has no matching saved-work record. Restore a recorded remote head or requeue for a fresh attempt.`,
        }
      case 'BranchDiverged':
        return {
          ok: false,
          ticketId,
          reason: 'branch-diverged',
          detail: `${saved.arm} holds the saved work, but ${saved.branch} rejected its push and may have diverged. Reconcile those refs before continuing; a fix grant cannot overwrite the issue branch.`,
        }
      case 'NoSavedHead':
        return {
          ok: false,
          ticketId,
          reason: 'no-saved-head',
          detail: `Run ${runId} has no published head to continue. Push the saved work to a remote ref, or requeue for a fresh attempt.`,
        }
    }
  })
}

/**
 * The `ContinueRequested` append, retried on any error up to five attempts
 * — never thrown, because a caller already holds a committed `WaitResolved`
 * and must not report that as a failed approval (see the call sites' own
 * comments). `null` once it lands; otherwise the last error's message.
 */
export function requestContinuation(
  store: EventStore,
  by: string,
  project: string,
  issue: string,
  runId: string,
): Effect.Effect<string | null> {
  const once = Effect.gen(function* () {
    const at = yield* Effect.tryPromise({ try: () => store.head(CONTROL_STREAM), catch: (e) => e })
    yield* Effect.uninterruptible(
      Effect.tryPromise({
        try: () =>
          store.append(CONTROL_STREAM, at, [
            {
              type: 'ContinueRequested',
              actor: by,
              data: parsePayload('ContinueRequested', { project, issue, runId, by }),
            },
          ]),
        catch: (e) => e,
      }),
    )
  })
  return Effect.gen(function* () {
    let lastError: unknown = null
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = yield* once.pipe(
        Effect.as(null),
        Effect.catch((err) => Effect.succeed({ err })),
      )
      if (failed === null) return null
      lastError = failed.err
    }
    return lastError instanceof Error ? lastError.message : String(lastError)
  })
}

/**
 * `Approve`'s own three checks, carried over from `approve.ts`'s
 * `approveHolding` (#150, #92) with nothing changed about what refuses or
 * what it says — only where they run from.
 *
 * `runId` is never null here: `allowedResolutions` never offers `Approve` for
 * an `OwnQuestion`, the one `WaitReason` with no `run` (`wait.ts`'s own
 * table), so a block offering `Approve` always names one.
 */
function checkApprove(
  options: ResolveWaitOptions,
  store: EventStore,
  ticketId: string,
  runId: string | null,
  onSha: string,
  note: string,
  reason: WaitReason,
): Effect.Effect<ResolveWaitResult | null, unknown> {
  return Effect.gen(function* () {
    if (runId === null) {
      return {
        ok: false,
        ticketId,
        reason: 'no-run',
        detail: `${ticketId} has no run to approve — nothing was resolved.`,
      }
    }
    const run = yield* readThroughSnapshot(store, attemptReducer, runId, 'all', {
      snapshots: options.snapshots,
      writer: options.writer,
    })

    const current =
      run.lifecycle.status === 'awaiting-approval' ? run.lifecycle.onSha : run.headSha !== null ? run.headSha : null
    if (current === null) {
      return {
        ok: false,
        ticketId,
        reason: 'not-awaiting-approval',
        detail: `${runId} is ${run.lifecycle.status}, not waiting for approval`,
      }
    }

    // The check that makes the approval mean anything: between the hold and
    // now, the run may have moved on — a second request on a new head — and
    // `onSha` is what this approval is about, not whatever the run is asking
    // about right now.
    if (onSha !== current) {
      return {
        ok: false,
        ticketId,
        reason: 'stale',
        detail:
          `the approval is for ${onSha.slice(0, 7)} and the run is now asking about ` +
          `${current.slice(0, 7)}. Nothing was resolved — reload and read it again.`,
      }
    }

    // **Approve absorbs the waiver** (#150). A refusal still standing on this
    // sha is waived by this same resolution, and there is no way past it
    // without saying why.
    //
    // Except where Approve waives nothing: on a `DiffTooLarge` wait it means *review
    // the clipped diff anyway* (#892), and the refusal on the sha is the very size
    // stop being approved past, so it needs no note. Any other step's refusal still does.
    const stoppedAt =
      reason._tag === 'ProposedEscalated' && reason.proposal._tag === 'DiffTooLarge' ? reason.proposal.from : null
    const refusing = refusingOn(run, onSha).filter((key) => key.split(':')[0] !== stoppedAt)
    if (refusing.length > 0 && !note) {
      return {
        ok: false,
        ticketId,
        reason: 'reason-required',
        detail:
          `${refusing.join(', ')} still ${refusing.length === 1 ? 'refuses' : 'refuse'} ${onSha.slice(0, 7)}, ` +
          `so approving waives ${refusing.length === 1 ? 'it' : 'them'} — say why. Nothing was resolved.`,
      }
    }

    // The branch may have moved since the approval was recorded — including
    // the agent, on a re-run. Continuing then would run past something nobody
    // looked at, which is exactly what the old label-based approval did.
    //
    // **Required, not skipped.** `options.client` and `options.issue` are both
    // optional on `ResolveWaitOptions` because `AnswerQuestion`/`StartNewAttempt`/`Close`
    // never need either — but every legitimate `Approve` caller has both:
    // `ApproveOptions.client` and `.issue` are themselves required fields, so a
    // caller that reaches here with an `Approve` and either one missing is a
    // defect, not a project with nothing to check. Skipping the check silently
    // is what let it pass unverified; refusing by name is what makes the gap
    // loud instead.
    if (options.client === undefined || options.issue === undefined) {
      return {
        ok: false,
        ticketId,
        reason: 'no-client',
        detail: `an approval needs a GitHub client and the issue number to check the branch — nothing was resolved.`,
      }
    }
    const branch = agentBranch(options.issue)
    const remoteHead = yield* refShaOrNull(options.client, `heads/${branch}`)
    if (remoteHead !== onSha) {
      return {
        ok: false,
        ticketId,
        reason: 'stale',
        detail:
          `the approval is for ${onSha.slice(0, 7)} and ${branch} is now ` +
          `${remoteHead?.slice(0, 7) ?? 'gone'}. Nothing was resolved.`,
      }
    }

    return null
  })
}

/**
 * A remote ref's sha, or `null` when GitHub could not be asked — never taken
 * as the ref being there, and answered by the caller as a stale branch.
 */
function refShaOrNull(
  client: { refSha(ref: string): Promise<string | null> },
  ref: string,
): Effect.Effect<string | null> {
  return Effect.tryPromise({ try: () => client.refSha(ref), catch: asFailure }).pipe(
    Effect.catch(() => Effect.succeed(null)),
  )
}
