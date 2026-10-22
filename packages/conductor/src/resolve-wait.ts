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
  parsePayload,
  parseTicketStream,
  type PayloadOf,
  reduceRun,
  reduceTicket,
  type RunState,
  type ToAppend,
  type WaitId,
} from '@lingtai/domain'
import { allowedResolutions, type Resolution, type WaitReason } from '@lingtai/domain/wait'
import { createFileLocker } from '@lingtai/env/lock'
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'

import { agentBranch } from './branches.ts'

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
 * approval folds onto `run.steps` as `verdict: 'asked'` too (`stepStateOf`'s
 * `signoff` case, `run.ts`) — the same tag a design agent's own clarifying
 * question gets, because neither is a judgement of the diff. But the point
 * this function exists to answer is *what else* is unjudged, and the signoff
 * `run.lifecycle.step` names is the thing being approved, not a second
 * refusal to waive: every approval would otherwise demand a reason for
 * answering its own question.
 */
const UNPASSED = new Set(['failed', 'never-ran', 'did-not-finish', 'asked'])

export function refusingOn(run: RunState, onSha: string): string[] {
  const awaiting = run.lifecycle.status === 'awaiting-approval' ? run.lifecycle.step : null
  return Object.values(run.steps)
    .filter((g) => g.onSha === onSha && UNPASSED.has(g.verdict) && g.step !== awaiting)
    .map((g) => g.step)
}

/**
 * One decision about a work item at a time (#150) — moved here from
 * `approve.ts`, which took this for as long as it acted; `resolveWait` is now
 * the only thing that acts.
 *
 * **The log cannot serialise this on its own.** Two resolutions landing on
 * the same wait in the gap between a read and an append is exactly what the
 * store's version check already refuses — but a requeue and an approval are
 * not one append each; the file lock is what keeps a second decision from
 * starting while the first is still being checked and written.
 */
async function deciding<T>(ticketId: string, busy: () => T, act: () => Promise<T>): Promise<T> {
  const got = await createFileLocker().tryLock(`decide:${ticketId}`, 'lingtai-decide')
  if (!got.ok) return busy()
  try {
    return await act()
  } finally {
    await got.lock.release()
  }
}

/** `SignoffRequired`, or `ProposedEscalated{BuildRed}` — a wait reason, in the words a refusal names it by. */
export function describeReason(reason: WaitReason): string {
  return reason._tag === 'ProposedEscalated' ? `ProposedEscalated{${reason.proposal._tag}}` : reason._tag
}

export interface ResolveWaitOptions {
  ticketId: string
  /**
   * The GitHub issue number — read only for `Approve`'s branch check
   * (`agentBranch`). A caller resolving anything else never needs one.
   */
  issue?: number
  waitId: WaitId
  resolution: Resolution
  /** Recorded on the resolution. A waiver, a close, an answer — none of them is anonymous. */
  by: string
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
  | { ok: false; ticketId: string; reason: string; detail: string }

export async function resolveWait(options: ResolveWaitOptions): Promise<ResolveWaitResult> {
  const ticketId = options.ticketId
  return deciding<ResolveWaitResult>(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      reason: 'busy',
      detail: `${ticketId} is being decided by someone else right now. Nothing was resolved — reload and read it again.`,
    }),
    () => resolveWaitHolding(options, ticketId),
  )
}

/**
 * **Exported for the unit half alone**, the same reason `approveHolding` was
 * (`#487`): `resolveWait()` above takes `createFileLocker()`, which is the
 * filesystem, so by 0060 §1 the whole of `resolveWait()` cannot be
 * unit-tested — this function underneath it can.
 */
export async function resolveWaitHolding(options: ResolveWaitOptions, ticketId: string): Promise<ResolveWaitResult> {
  const store = options.store ?? eventStore
  const note = options.note?.trim() ?? ''

  const item = reduceTicket(await store.read(ticketId))

  // **The way out of a continuation this call could not schedule**, read
  // before the `not-blocked` refusal below rather than instead of it (#465).
  // `WaitResolved{Approve}` already committed the first time — the
  // lifecycle moved to `approved` — but the retried `ContinueRequested`
  // append further down may have exhausted its retries and left no row for
  // a conductor to act on. A second `Approve` naming the very same wait and
  // sha is not a second resolution, so it writes no second `WaitResolved`
  // — `resolveWait` stays the only writer of that event, which
  // `resolve-wait.test.ts`'s own check holds to — and asks only for the
  // row the first one was owed.
  if (
    (options.resolution._tag === 'Approve' || options.resolution._tag === 'GrantFixRound') &&
    item.lifecycle.status === 'approved' &&
    item.lifecycle.waitId === options.waitId &&
    (options.resolution._tag === 'GrantFixRound'
      ? item.lifecycle.grantRef !== undefined
      : item.lifecycle.onSha === options.resolution.onSha)
  ) {
    const parsed = parseTicketStream(ticketId)!
    const unscheduled = await requestContinuation(store, options.by, parsed.project, parsed.issue, item.lifecycle.runId)
    return unscheduled === null ? { ok: true, ticketId } : { ok: true, ticketId, unscheduled }
  }

  if (item.lifecycle.status !== 'blocked' || item.lifecycle.waitId !== options.waitId) {
    return {
      ok: false,
      ticketId,
      reason: 'not-blocked',
      detail: `${ticketId} is not waiting on ${options.waitId} — nothing was resolved. Reload and read it again.`,
    }
  }
  const block = item.lifecycle
  const reason = block.reason

  const allowed = allowedResolutions(reason)
  if (!allowed.includes(options.resolution._tag)) {
    return {
      ok: false,
      ticketId,
      reason: 'not-offered',
      detail: `${options.resolution._tag} is not offered for ${describeReason(reason)} — nothing was resolved.`,
    }
  }

  let resolution = options.resolution
  if (resolution._tag === 'GrantFixRound') {
    if (block.runId === null)
      return { ok: false, ticketId, reason: 'no-run', detail: 'No held run has work to continue.' }
    const events = await store.read(block.runId)
    const published = events.filter((e) => e.type === 'RunRefsPublished').at(-1)
    const saved = published?.data as PayloadOf<'RunRefsPublished'> | undefined
    const head = saved?.armSha ?? saved?.headSha
    const ref =
      saved?.armSha !== null && saved?.armSha !== undefined
        ? saved.arm
        : saved?.branchCarries === false || saved?.outcome === 'arm-only'
          ? saved.arm
          : saved?.branch
    if (!saved || !head || !ref || !['published', 'already-published', 'arm-only'].includes(saved.outcome)) {
      return {
        ok: false,
        ticketId,
        reason: 'no-saved-head',
        detail: `Run ${block.runId} has no published head to continue. Push the saved work to a remote ref, or requeue for a fresh pass.`,
      }
    }
    if (options.client === undefined)
      return {
        ok: false,
        ticketId,
        reason: 'no-client',
        detail: 'A remote ref check is required before granting a fix round.',
      }
    const remote = await options.client.refSha(`heads/${ref}`).catch(() => null)
    if (remote !== head) {
      return {
        ok: false,
        ticketId,
        reason: 'stale',
        detail: `${ref} is ${remote ?? 'missing'}, not the saved ${head}. Restore that ref to the saved head or requeue for a fresh pass.`,
      }
    }
    resolution = { _tag: 'GrantFixRound', onSha: head, ref }
  }

  if (resolution._tag === 'Approve') {
    const refused = await checkApprove(options, store, ticketId, block.runId, resolution.onSha, note)
    if (refused !== null) return refused
  }

  try {
    await store.append(ticketId, item.version, [
      {
        type: 'WaitResolved',
        actor: options.by,
        data: parsePayload('WaitResolved', {
          waitId: options.waitId,
          by: options.by,
          resolution,
          note,
        }),
      },
      ...(options.with ?? []),
    ])
  } catch (err) {
    if (!(err instanceof ConcurrencyError)) throw err
    return {
      ok: false,
      ticketId,
      reason: 'stale',
      detail: `${ticketId} moved while this was being resolved. Nothing was resolved — reload and read it again.`,
    }
  }

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
  if (resolution._tag === 'Approve' || resolution._tag === 'GrantFixRound') {
    const parsed = parseTicketStream(ticketId)
    if (parsed !== null) {
      unscheduled =
        (await requestContinuation(store, options.by, parsed.project, parsed.issue, block.runId!)) ?? undefined
    }
  }

  return unscheduled === undefined ? { ok: true, ticketId } : { ok: true, ticketId, unscheduled }
}

/**
 * The `ContinueRequested` append, retried on any error up to five attempts
 * — never thrown, because a caller already holds a committed `WaitResolved`
 * and must not report that as a failed approval (see the call sites' own
 * comments). `null` once it lands; otherwise the last error's message.
 */
async function requestContinuation(
  store: EventStore,
  by: string,
  project: string,
  issue: string,
  runId: string,
): Promise<string | null> {
  let lastError: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const at = (await store.read(CONTROL_STREAM)).length
      await store.append(CONTROL_STREAM, at, [
        {
          type: 'ContinueRequested',
          actor: by,
          data: parsePayload('ContinueRequested', { project, issue, runId, by }),
        },
      ])
      return null
    } catch (err) {
      lastError = err
    }
  }
  return lastError instanceof Error ? lastError.message : String(lastError)
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
async function checkApprove(
  options: ResolveWaitOptions,
  store: EventStore,
  ticketId: string,
  runId: string | null,
  onSha: string,
  note: string,
): Promise<ResolveWaitResult | null> {
  if (runId === null) {
    return {
      ok: false,
      ticketId,
      reason: 'no-run',
      detail: `${ticketId} has no run to approve — nothing was resolved.`,
    }
  }
  const run = reduceRun(await store.read(runId))

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
  const refusing = refusingOn(run, onSha)
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
  // optional on `ResolveWaitOptions` because `AnswerQuestion`/`Requeue`/`Close`
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
  const remoteHead = await options.client.refSha(`heads/${branch}`).catch(() => null)
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
}
