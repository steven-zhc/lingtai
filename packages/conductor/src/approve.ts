import { reduceRun, reduceTicket, stepOutcomesOf, waitsOf, type WaitId, ticketStream } from '@lingtai/domain'
import { continuationOf } from '@lingtai/domain/wait'
import { createFileLocker } from '@lingtai/env/lock'
import { type EventStore, eventStore } from '@lingtai/event-store'

import { describeReason, resolveWaitHolding } from './resolve-wait.ts'

/**
 * Granting the approval a held run is waiting for (#465).
 *
 * **No longer where the merge happens.** `--no-merge`'s whole point survives
 * unchanged — the obvious way to finish a held run, running it again without
 * the flag, starts a *new* run with a new worktree and a different diff, so
 * the thing that lands is not the thing anyone approved — but what finishes
 * it now is a continuation of the same run, not a merge called from here.
 * `resolveWaitHolding` is the only thing that appends `WaitResolved{Approve}`,
 * and whichever process holds the conductor lock takes the continuation up
 * from the log that append leaves behind (0118 §11, 0120 §6 — see
 * `resolve-wait.ts`'s own header for the four reasons that is not this file).
 *
 * This file is the CLI/board's own thin reading of what is being approved —
 * the sha, the run, where it continues — everything that has to be known
 * before `resolveWaitHolding` is called at all is still here; everything
 * about whether the sha is stale or a refusal needs a reason moved there with
 * the append (#150, #92).
 */
export async function deciding<T>(ticketId: string, busy: () => T, act: () => Promise<T>): Promise<T> {
  const got = await createFileLocker().tryLock(`decide:${ticketId}`, 'lingtai-decide')
  if (!got.ok) return busy()
  try {
    return await act()
  } finally {
    await got.lock.release()
  }
}

export interface ApproveOptions {
  project: string
  issue: number
  /** Only `refSha` is read, for the branch check `resolveWaitHolding` makes — see its own `client`. */
  client: { refSha(ref: string): Promise<string | null> }
  /** Recorded on the approval. A waiver is never anonymous, and neither is this. */
  by: string
  /**
   * The sha the caller was looking at when they decided.
   *
   * Distinct from the approval's own `onSha`, and both are checked. A board
   * card renders a commit; if the branch moved *and a new approval was
   * requested* since, the run's current question is about a different diff than
   * the one on screen, and answering it would be answering a question nobody
   * read. The CLI omits this because it has just printed the state it is acting
   * on; the board always sends it.
   */
  onSha?: string
  /**
   * Why. Optional only while every gate on the sha agrees: an approval over a
   * gate that still refuses is a waiver of it, and is refused without one
   * (#150). See `refusingOn`.
   */
  note?: string
  /**
   * The wait the caller was shown, and is resolving — checked against the
   * one currently open rather than trusted from the fold (#465, #508).
   *
   * **Required, and `'open'` is not the same as omitting it.** A board card
   * always sends the concrete id it rendered (`StandingView.waitId`), so two
   * open cards for the same item cannot resolve the wait neither was shown.
   * `'open'` is `lingtai approve`'s own value: the CLI reads and resolves
   * inside one `deciding` hold, so "the wait it was shown" and "the wait
   * now" are the same read, and there is no card for it to name. Making the
   * field optional let a board caller leave it out by accident — exactly the
   * omission `ScheduleContinuation` made (#508) — and `tsc` cannot refuse an
   * omission of an optional field. Typing `'open'` as the only other value
   * means a board caller that forgot a wait id now fails to compile instead
   * of silently resolving whatever is open.
   */
  waitId: WaitId | 'open'
  store?: EventStore
  log?: (line: string) => void
}

export type ApproveResult =
  | {
      ok: true
      ticketId: string
      runId: string
      continuesAt: string
      /** Passed through from `resolveWaitHolding` — see its own field. */
      unscheduled?: string
    }
  | { ok: false; ticketId: string; reason: string; detail: string }

export async function approve(options: ApproveOptions): Promise<ApproveResult> {
  const ticketId = ticketStream(options.project, options.issue)
  // Held through the append that grants it, so a requeue cannot put the item
  // back in the queue while this is deciding it. See `deciding`.
  return deciding<ApproveResult>(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      reason: 'busy',
      detail: `${ticketId} is being decided by someone else right now. Nothing was resolved — reload and read it again.`,
    }),
    () => approveHolding(options, ticketId),
  )
}

/**
 * **Exported for the unit half alone** (`#487`). `approve()` above takes
 * `createFileLocker()` (`deciding`), which is the filesystem, so by 0060 §1
 * the whole of `approve()` cannot be unit-tested — this function underneath
 * it can, and `index.ts` does not re-export it, so nothing outside this
 * module or a test gains a second way to grant an approval unlocked.
 */
export async function approveHolding(options: ApproveOptions, ticketId: string): Promise<ApproveResult> {
  const store = options.store ?? eventStore
  const log = options.log ?? (() => {})

  const events = await store.read(ticketId)
  const item = reduceTicket(events)

  // **The way out of a continuation `resolveWaitHolding` could not schedule**
  // (#465). `WaitResolved{Approve}` already committed — the lifecycle is
  // `approved` — but the retried `ContinueRequested` append inside it may
  // still have exhausted its retries and left no row for a conductor to act
  // on. A second `Approve` of the same wait and sha asks only for that row:
  // `resolveWaitHolding` matches this exact state before its `not-blocked`
  // refusal and appends `ContinueRequested` alone, writing no second
  // `WaitResolved` — `resolveWait` stays the only writer of that event.
  if (item.lifecycle.status === 'approved') {
    // **The wait check, before the sha check** (#508). Naming the wait first
    // means a click from a stale `approved` card is refused by the wait it
    // named rather than by whatever sha happens to differ — the sentence a
    // person reading the refusal needs is "that is not the question you were
    // shown", not an sha mismatch that reads like a branch race.
    if (options.waitId !== 'open' && options.waitId !== item.lifecycle.waitId) {
      return {
        ok: false,
        ticketId,
        reason: 'stale',
        detail:
          `the card showed wait ${options.waitId} and ${ticketId} is now approved at wait ` +
          `${item.lifecycle.waitId} — nothing was resolved. Reload and read it again.`,
      }
    }
    if (options.onSha && options.onSha !== item.lifecycle.onSha) {
      return {
        ok: false,
        ticketId,
        reason: 'stale',
        detail:
          `the card showed ${options.onSha.slice(0, 7)} and the approval on record is for ` +
          `${item.lifecycle.onSha.slice(0, 7)}. Nothing was resolved — reload and read it again.`,
      }
    }
    const resolved = await resolveWaitHolding(
      {
        ticketId,
        issue: options.issue,
        waitId: options.waitId === 'open' ? item.lifecycle.waitId : options.waitId,
        resolution: { _tag: 'Approve', onSha: item.lifecycle.onSha },
        by: options.by,
        note: options.note,
        client: options.client,
        store,
      },
      ticketId,
    )
    if (!resolved.ok) {
      return { ok: false, ticketId, reason: resolved.reason, detail: resolved.detail }
    }
    const { runId, waitId, onSha } = item.lifecycle
    const runEvents = await store.read(runId)
    // The `WaitStarted` this approval already answered is still on the
    // stream — `waitsOf` matches it by `waitId`, never by position — so the
    // continuation is read the same way the first approval read it.
    const fold = waitsOf(events).find((w) => w.waitId === waitId)!
    const continuation = continuationOf(fold.reason, stepOutcomesOf(runEvents))!
    log(`approved ${onSha.slice(0, 7)} by ${options.by} — rescheduled to continue at ${continuation.step}`)
    return { ok: true, ticketId, runId, continuesAt: continuation.step, unscheduled: resolved.unscheduled }
  }

  if (item.lifecycle.status !== 'blocked') {
    return {
      ok: false,
      ticketId,
      reason: 'not-blocked',
      detail: `${ticketId} is ${item.lifecycle.status}, not blocked — nothing was resolved`,
    }
  }
  const block = item.lifecycle
  // **The wait check, before the sha check — same reason as the `approved`
  // branch above** (#508). A continuation that stops at a *new* wait moves
  // the lifecycle straight back to `blocked` (`WaitStarted`'s own fold), so a
  // stale `approved` card's click lands here, not in the branch above — this
  // is the check the finding is actually about.
  if (options.waitId !== 'open' && options.waitId !== block.waitId) {
    return {
      ok: false,
      ticketId,
      reason: 'stale',
      detail:
        `the card showed wait ${options.waitId} and ${ticketId} is now waiting on wait ` +
        `${block.waitId} — nothing was resolved. Reload and read it again.`,
    }
  }
  const runId = block.runId
  if (runId === null) {
    // `allowedResolutions` never offers `Approve` for an `OwnQuestion`, the
    // one `WaitReason` with no run — so a block offering `Approve` always
    // names one, and this is a defensive refusal rather than a reachable row.
    return { ok: false, ticketId, reason: 'no-run', detail: `${ticketId} has no run to approve` }
  }

  const runEvents = await store.read(runId)
  const run = reduceRun(runEvents)

  /**
   * **The sha an approval is about.** `run.lifecycle.onSha` for a declared
   * `human:`/`--no-merge` signoff, and for every other wait that offers
   * `Approve`, `run.headSha` — both reach here through the same `StepEnded`
   * fold (`run.ts`).
   */
  const onSha: string | null =
    run.lifecycle.status === 'awaiting-approval' ? run.lifecycle.onSha : run.headSha !== null ? run.headSha : null
  if (onSha === null) {
    return {
      ok: false,
      ticketId,
      reason: 'not-awaiting-approval',
      detail: `${runId} is ${run.lifecycle.status}, not waiting for approval`,
    }
  }

  if (options.onSha && options.onSha !== onSha) {
    return {
      ok: false,
      ticketId,
      reason: 'stale',
      detail:
        `the card showed ${options.onSha.slice(0, 7)} and the run is now asking about ` +
        `${onSha.slice(0, 7)}. Nothing was resolved — reload and read it again.`,
    }
  }

  // Where this continues, and what it waives there — read here only to say
  // so on success (and to refuse by name before the append, rather than
  // after it, when it is not offered at all). `resolveWaitHolding` reads
  // `allowedResolutions` independently and agrees with this by construction.
  const continuation = continuationOf(block.reason, stepOutcomesOf(runEvents))
  if (continuation === null) {
    return {
      ok: false,
      ticketId,
      reason: 'not-offered',
      detail: `Approve is not offered for ${describeReason(block.reason)} — nothing was resolved.`,
    }
  }

  const resolved = await resolveWaitHolding(
    {
      ticketId,
      issue: options.issue,
      waitId: options.waitId === 'open' ? block.waitId : options.waitId,
      resolution: { _tag: 'Approve', onSha },
      by: options.by,
      note: options.note,
      client: options.client,
      store,
    },
    ticketId,
  )
  if (!resolved.ok) {
    return { ok: false, ticketId, reason: resolved.reason, detail: resolved.detail }
  }

  log(`approved ${onSha.slice(0, 7)} by ${options.by} — continues at ${continuation.step}`)
  return { ok: true, ticketId, runId, continuesAt: continuation.step, unscheduled: resolved.unscheduled }
}

/**
 * Putting a blocked item back in the queue, from any blocked card (#150).
 *
 * **A card must never offer only a control that refuses.** That is the `#84`
 * complaint stated as a rule: an item whose integration failed is `blocked`
 * with a question, its run is `gating`, and `approve()` will not touch it.
 * Before this, the board rendered Approve on it anyway and the button could not
 * work.
 *
 * **And since `#143` every refused merge ends there**, rather than some of them
 * buying a run instead — so this is the move the commonest failure in the
 * system waits on, and not the leftover it was written as.
 *
 * The move is not a new mechanism. Resolving a wait has been in the
 * catalogue since the beginning and means exactly this: a person answered the
 * question, and the item is queueable again. The next pass cuts a fresh branch
 * from a base that has since moved, which for the commonest case — a conflict
 * nobody chose to repair — is the whole of the fix.
 *
 * No GitHub call. `labelsFor("queued")` is empty, so there is nothing to say
 * that is not already implied, and `reconcile` converges the label an earlier
 * block left behind. A decision here does not need a network round trip to
 * count.
 */
export async function requeue(options: {
  project: string
  issue: number
  by: string
  /**
   * Why, on the record — optional (#424). A requeue of a run's block folds into
   * an `AnswerRecord` only when `runId` is set (`work-item.ts`), and
   * `answersBrief` keeps only the ones with `runId === null`
   * (`attempts.ts:572`); a requeue of a question is written `withdrawn`, which
   * the fold keeps no answer for. So an optional note here never reaches a
   * later attempt's prompt, unlike `answer()`'s.
   */
  note: string
  /**
   * What to do with a question asked before any run: withdraw it (the default,
   * `lingtai requeue` and the board's Withdraw), or refuse. The board's Send
   * refuses — it checks first, but a `lingtai ask` landing between that check
   * and this read would otherwise be withdrawn under a note about a document.
   */
  onQuestion?: 'withdraw' | 'refuse'
  /** The wait the caller was shown — see `ApproveOptions.waitId`'s own comment. */
  waitId?: WaitId
  store?: EventStore
}): Promise<{ ok: boolean; ticketId: string; detail: string }> {
  const store = options.store ?? eventStore
  const ticketId = ticketStream(options.project, options.issue)

  // **Never while an approval is acting on the item** (#150). Requeue sits
  // beside Approve now, and an approval that has appended and is still merging
  // leaves the item `blocked` for seconds; unblocking it then let the diff land
  // on an item a new run had claimed. The run is left as it is: an approval
  // that arrives after this reads the item, which is no longer holding it. See
  // `deciding`.
  return deciding(
    ticketId,
    () => ({
      ok: false,
      ticketId,
      detail: `${ticketId} is being decided by someone else right now — an approval may be merging it. Reload and read it again`,
    }),
    () => requeueHolding(options, store, ticketId),
  )
}

/** Exported for the unit half alone — see `approveHolding`'s own comment. */
export async function requeueHolding(
  options: { by: string; note: string; onQuestion?: 'withdraw' | 'refuse'; waitId?: WaitId },
  store: EventStore,
  ticketId: string,
): Promise<{ ok: boolean; ticketId: string; detail: string }> {
  const events = await store.read(ticketId)
  const item = reduceTicket(events)
  if (item.lifecycle.status !== 'blocked') {
    // Saying which state it is in, for the reason `approve` does: "not blocked"
    // sends somebody nowhere, and "it is already running" answers the question.
    return {
      ok: false,
      ticketId,
      detail: `${ticketId} is ${item.lifecycle.status}, not blocked`,
    }
  }
  // **A block no run holds is a question about the ticket (#147), and a requeue
  // withdraws it rather than answering it.** The fold keeps whatever note ends
  // such a block as a decision and carries it into every later prompt
  // (`answersBrief`), so a requeue's why — *asked by mistake, ignore* — is
  // written `withdrawn`, which the fold keeps nothing of. Answering is
  // `answer()`'s. Refusing here instead left a mistaken question no way out
  // but an answer every attempt would be told.
  //
  // **An `OwnQuestion` is the only wait a requeue withdraws** — every other
  // wait carries a run, which is exactly `item.lifecycle.runId === null` read
  // the old way.
  const withdrawn = item.lifecycle.reason._tag === 'OwnQuestion'
  if (withdrawn && options.onQuestion === 'refuse') {
    return {
      ok: false,
      ticketId,
      detail: `${ticketId} is asking a question before any run — answer it first`,
    }
  }

  // Trimmed, so a whitespace-only box lands as the empty string rather than
  // verbatim (#424) — a blank note is stored as empty, never invented.
  const note = options.note.trim() ? options.note : ''

  const resolved = await resolveWaitHolding(
    {
      ticketId,
      waitId: options.waitId ?? item.lifecycle.waitId,
      resolution: { _tag: 'Requeue' },
      by: options.by,
      note,
      store,
    },
    ticketId,
  )
  if (!resolved.ok) {
    return { ok: false, ticketId, detail: resolved.detail }
  }

  return {
    ok: true,
    ticketId,
    detail: withdrawn
      ? `question withdrawn, by ${options.by} — back in the queue, and no attempt is told it`
      : `back in the queue, by ${options.by}`,
  }
}

// **`waive()` is gone (#502).** It appended `StepWaived`, which 0120's
// appendix retires with no replacement — the standalone waiver `waive()`
// built is "has no caller" there, and nothing in this codebase called it
// either (`index.ts` re-exported it and nothing imported that). `approve()`
// still absorbs a waiver as part of granting an approval (`refusingOn`,
// now in `resolve-wait.ts`); what is gone is waiving a step on its own, with
// no approval beside it.
