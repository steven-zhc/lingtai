/**
 * Claiming a work item.
 *
 * This replaces `.runtime/loop.lock.d`, a directory the old loop created to hold
 * a lock and which leaked after every `kill -9` — recovering meant noticing and
 * running `rm -rf` by hand. There is nothing to unwind here, and that is not a
 * tidier implementation of the same idea but a different one:
 *
 *   - **The claim is an append at an expected version.** `UNIQUE (stream_id,
 *     version)` decides the race. The loser gets a `ConcurrencyError`, re-reads,
 *     and finds the item already held. No lock table, no lock file.
 *   - **Nothing here expires.** A claim carried a `leaseUntilMs` for a while and
 *     [0027](../../../doc/decisions-archive/0027-the-lease-is-deleted.md) deleted it: a
 *     fixed thirty minutes, never renewed, on runs the recipe lets live for one
 *     to two hours. It excluded nobody — two conductors pass a timestamp check
 *     together — and past the half hour it did the opposite of its job, handing
 *     a live run's ticket to the next caller. Held is held.
 *
 * A crash therefore costs a `TicketReleased`, not an intervention: the next
 * conductor to take `lingtai:daemon` knows it is the only one, so every claim
 * naming another worker is dead and it appends the release
 * (`daemon/reconcile.ts`). Liveness is the lock, which the kernel maintains;
 * exclusion is the constraint. Neither is a number.
 */
import {
  type AskDecline,
  type BlockedLifecycle,
  type ClaimDecline,
  type CloseDecline,
  type CloseRefusal,
  type PayloadOf,
  type ResolveRefusal,
  type TicketState,
  type WaitId,
  askTransition,
  closeChecks,
  finishTriageTransition,
  startTriageTransition,
  type FinishTriageDecline,
  type StartTriageDecline,
  closeTransition,
  reduceTicket,
  resolvedEvents,
  resolveWaitTransition,
  type ContinueDecline,
  type ReleaseCause,
  type ReleaseDecline,
  type SplitChildren,
  type SplitChildState,
  claimTransition,
  continueTransition,
  parsePayload,
  releaseTransition,
  ticketReducer,
  type ToAppend,
} from '@lingtai/domain'
import { allowedResolutions, type Resolution, type WaitReason } from '@lingtai/domain/wait'
import {
  ConcurrencyError,
  type EventStore,
  readThroughSnapshot,
  type SnapshotReadOptions,
} from '@lingtai/event-store/store'
import { type StepAction } from '@lingtai/recipe'
import { Cause, Effect, Exit, Result } from 'effect'

import { editHash } from '../attempts.ts'
import { resolveEndActions, type TerminalOutcome } from '../end-step.ts'
import { recordPrompt } from '../record-prompt.ts'
import type { Tickets } from '../ticket-store.ts'

export type { SplitChildState }

export interface ClaimOptions extends SnapshotReadOptions {
  runId: string
  /**
   * Who holds it — host and pid.
   *
   * Not decoration. It is what recovery is decided on (0027): a conductor
   * holding the lock releases every claim recorded by a *different* worker,
   * because it has proof there is no such conductor left alive.
   */
  worker?: string
  /**
   * What the task is, if the caller knows.
   *
   * Recorded on the claim because the queue left the log (0012): this is now
   * the only place a title enters it, and without one a rebuilt projection has
   * nothing to show for work that has already merged — GitHub only lists what
   * is still open. Null is honest when the caller genuinely does not know.
   */
  title?: string | null
  kind?: string | null
  /** The ticket body the pass fetched; recorded on the claim as given, left off when absent. */
  body?: string
  /** Required: the owner opens no process store (the board imports it). */
  store: EventStore
  /**
   * Where a split's children are asked about (#604). Omitted, a recorded split
   * is not looked at and the claim is what it always was.
   */
  children?: Pick<Tickets, 'getIssue'>
}

export interface Claim {
  ticketId: string
  runId: string
  worker: string
  /** The stream version the claim landed at; the next append expects this. */
  version: number
}

/** The ticket's own refusals, plus the append's: another claimant won it. Re-read and look again. */
export type ClaimRefusal = ClaimDecline | { reason: 'lost-race' }

export type ClaimResult = { ok: true; claim: Claim } | { ok: false; refusal: ClaimRefusal }

/**
 * What this process calls itself in a claim.
 *
 * Exported because recovery compares against it (0027). A restarted conductor
 * has a new pid, so it does not recognise its predecessor's claims as its own —
 * which is the point: those are exactly the claims nobody is coming back for.
 */
export function conductorWorker(): string {
  return `${process.env['HOSTNAME'] ?? 'local'}:${process.pid}`
}

/**
 * Takes the work item, or says why not.
 *
 * Never throws on a lost race: losing is an ordinary outcome of two schedulers
 * looking at the same queue, and a caller that has to catch an exception to
 * discover it will eventually forget to.
 */
export function claimTicketEffect(ticketId: string, options: ClaimOptions): Effect.Effect<ClaimResult, unknown> {
  return Effect.gen(function* () {
    const store = options.store
    const worker = options.worker ?? conductorWorker()

    const state = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', options)

    // The read is IO, so it is the command's; the decision is the transition's. Asked only where it always was —
    // never of a held or landed ticket, which would be a network call on every pass that finds one.
    let children: SplitChildren = null
    if (state.lifecycle.status === 'backlog' && state.split !== null && options.children !== undefined) {
      // Exactly the numbers the split recorded — never the body, never GitHub's
      // sub-issue list, which a person may have added to by hand. A read that
      // throws is a refusal, not an exception: nothing was appended, so the caller
      // must not treat the ticket as possibly held — and a partial read must not
      // pass for *all closed*.
      const asked = state.split.children.map((c) => c.number)
      const source = options.children
      const attempted = yield* Effect.result(
        Effect.tryPromise({
          try: () => Promise.all(asked.map((n) => source.getIssue(n))),
          catch: (error) => error,
        }),
      )
      children = Result.isFailure(attempted)
        ? { unreadable: attempted.failure instanceof Error ? attempted.failure.message : String(attempted.failure) }
        : { read: attempted.success }
    }

    const decided = claimTransition(state, {
      runId: options.runId,
      worker,
      ...(options.title !== undefined ? { title: options.title } : {}),
      ...(options.kind !== undefined ? { kind: options.kind } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      children,
    })
    if (!decided.ok) return { ok: false, refusal: decided.refusal } as const

    // Every rejection is the caller's to see as a typed failure — not only the
    // `ConcurrencyError` this answers. The caller treats *any* failure of this
    // append as `mayHold`: the write may have committed. A defect would slip past
    // its `Effect.result` and leave an item held by nobody.
    const appended = yield* Effect.result(
      Effect.tryPromise({
        try: () => store.append(ticketId, state.version, decided.events),
        catch: (error) => error,
      }),
    )
    if (Result.isFailure(appended)) {
      // The other claimant appended first. The constraint is the whole of the
      // mutual exclusion; this is what losing it looks like.
      if (appended.failure instanceof ConcurrencyError) return { ok: false, refusal: { reason: 'lost-race' } } as const
      return yield* Effect.fail(appended.failure)
    }
    const [written] = appended.success
    return { ok: true, claim: { ticketId, runId: options.runId, worker, version: written!.version } } as const
  })
}

export type ContinueRefusal =
  | ContinueDecline
  /** Another claimant won the append — the daemon and a CLI/board call raced for the same continuation. */
  | { reason: 'lost-race' }

export type ContinueResult = { ok: true; claim: Claim } | { ok: false; refusal: ContinueRefusal }

/**
 * Takes a run back up for its continuation (#465, 0118 §11) — `claimTicket`'s
 * sibling, for the one state `claimTicket` itself refuses: `approved`,
 * never `backlog`.
 *
 * **A `TicketContinued { runId, worker }` of its own (0109 §5), checked at
 * the same expected version a claim is.** It carries no title and no kind, and
 * the reducer reads it as a continuation by its type (`claims.ts`), so the run
 * already in `runs` is not claimed a second time. A close or a second
 * decision landing between the approval and this call is a
 * `ConcurrencyError` the version check catches on its own; `wrong-run` and
 * `not-approved` are read off the state this call itself fetched, for a caller
 * that wants to say *why* before it ever reaches the store.
 */
export function continueTicketEffect(
  ticketId: string,
  runId: string,
  options: { worker?: string; body?: string; store: EventStore; expectVersion?: number } & SnapshotReadOptions,
): Effect.Effect<ContinueResult, unknown> {
  return Effect.gen(function* () {
    const store = options.store
    const worker = options.worker ?? conductorWorker()

    const state = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', options)

    // A continuation decided on a read of the ticket is taken only on that read (#1205).
    if (options.expectVersion !== undefined && state.version !== options.expectVersion) {
      return { ok: false, refusal: { reason: 'lost-race' } } as const
    }
    const decided = continueTransition(state, {
      runId,
      worker,
      ...(options.body !== undefined ? { body: options.body } : {}),
    })
    if (!decided.ok) return { ok: false, refusal: decided.refusal } as const

    // Typed failures for every rejection, for `claimTicketEffect`'s reason.
    const appended = yield* Effect.result(
      Effect.tryPromise({
        try: () => store.append(ticketId, state.version, decided.events),
        catch: (error) => error,
      }),
    )
    if (Result.isFailure(appended)) {
      if (appended.failure instanceof ConcurrencyError) return { ok: false, refusal: { reason: 'lost-race' } } as const
      return yield* Effect.fail(appended.failure)
    }
    const [written] = appended.success
    return { ok: true, claim: { ticketId, runId, worker, version: written!.version } } as const
  })
}

export type ReleaseResult = { ok: true } | { ok: false; refusal: ReleaseDecline }

/**
 * Hands the item back. The only way back: there is no expiry (0027).
 *
 * `cause` is `null` for every caller here and the reconciler's own release of
 * a dead worker — neither has one of 0120's causes to name (#502, 464.md
 * choice 4) — and `{_tag: 'NewAttempt', restart}` for `conduct.ts`'s own restart,
 * which calls this directly rather than through a second function.
 */
export function releaseTicketEffect(
  ticketId: string,
  runId: string,
  reason: string,
  store: EventStore,
  cause: ReleaseCause | null = null,
  options: SnapshotReadOptions & { endPlan?: readonly ToAppend[] } = {},
): Effect.Effect<ReleaseResult, unknown> {
  return releaseWith(ticketId, { by: 'run', runId, reason, cause }, store, options)
}

/**
 * The release a conductor that holds the daemon lock makes for a claim by a worker that is gone.
 *
 * `beforeAppend` runs between the transition's answer and the append, against the same read — the kill that must
 * precede it (`daemon/reconcile.ts`, #87) happens there, so a claim that moved on is never killed for, and a write
 * that loses to a newer one fails rather than succeeding on a re-read.
 */
export function releaseDeadWorkerEffect(
  ticketId: string,
  input: { mine: string; lock: string },
  store: EventStore,
  options: SnapshotReadOptions & {
    beforeAppend?: (held: { runId: string; worker: string }) => Effect.Effect<void, unknown>
  } = {},
): Effect.Effect<ReleaseResult, unknown> {
  return releaseWith(ticketId, { by: 'dead-worker', ...input }, store, options)
}

function releaseWith(
  ticketId: string,
  input: Parameters<typeof releaseTransition>[1],
  store: EventStore,
  options: SnapshotReadOptions & {
    beforeAppend?: (held: { runId: string; worker: string }) => Effect.Effect<void, unknown>
    /** What `end` resolved for a failed ending: appended in the same append as the release. */
    endPlan?: readonly ToAppend[]
  },
): Effect.Effect<ReleaseResult, unknown> {
  return Effect.gen(function* () {
    const state = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', options)
    const decided = releaseTransition(state, input)
    if (!decided.ok) return { ok: false, refusal: decided.refusal } as const
    if (options.beforeAppend !== undefined && state.lifecycle.status === 'claimed') {
      const { runId, worker } = state.lifecycle
      yield* options.beforeAppend({ runId, worker })
    }
    yield* Effect.tryPromise({
      try: () => store.append(ticketId, state.version, [...decided.events, ...(options.endPlan ?? [])]),
      catch: (error) => error,
    })
    return { ok: true } as const
  })
}

/** The append at an expected version: `true` when another writer got there first, any other failure the caller's. */
function appendLost(
  store: Pick<EventStore, 'append'>,
  ticketId: string,
  version: number,
  events: readonly ToAppend[],
): Effect.Effect<boolean, unknown> {
  return Effect.tryPromise({ try: () => store.append(ticketId, version, events), catch: (error) => error }).pipe(
    Effect.uninterruptible,
    Effect.as(false),
    Effect.catchIf(
      (err) => err instanceof ConcurrencyError,
      () => Effect.succeed(true),
    ),
  )
}

/**
 * What the caller's own checks settled, between the ticket's and the append: the resolution it will record (a
 * `GrantFixRound` is rewritten to the head it was checked against), the triage answers it wrote into the body, and
 * whether it wrote one — the stream moved by its own events then, so the version is read again.
 */
export type PreparedResolve = {
  resolution: Resolution
  answers?: PayloadOf<'WaitResolved'>['answers']
  wroteBody?: boolean
}

export type ResolveTicketWaitResult<R> =
  | { ok: true; kind: 'repeat'; runId: string }
  | { ok: true; kind: 'resolved'; resolution: Resolution; runId: string | null }
  | { ok: false; refusal: ResolveRefusal; written: boolean }
  /** `prepare` refused: the caller's own answer, passed through whole. */
  | { ok: false; refused: R }
  /** Another writer appended first; nothing was resolved. Never retried. */
  | { ok: false; lost: true; written: boolean }

/**
 * A person's resolution of a wait (0118 §11): the transition decides from one read, the caller's `prepare` makes the
 * checks that are not the ticket's own (GitHub, the recipe, the attempt's saved head) against that same read, and
 * one append at the version carries every event.
 */
export function resolveTicketWaitEffect<R>(
  ticketId: string,
  options: SnapshotReadOptions & {
    store: EventStore
    waitId: WaitId
    resolution: Resolution
    by: string
    note: string
    /** Events appended after the resolution, in the same append. */
    with?: readonly ToAppend[]
    split?: unknown
    prepare?: (
      state: TicketState,
      block: BlockedLifecycle,
    ) => Effect.Effect<{ ok: true; prepared: PreparedResolve } | { ok: false; refused: R }, unknown>
  },
): Effect.Effect<ResolveTicketWaitResult<R>, unknown> {
  return Effect.gen(function* () {
    const store = options.store
    const read = { snapshots: options.snapshots, writer: options.writer }
    const state = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', read)

    const decided = resolveWaitTransition(state, { waitId: options.waitId, resolution: options.resolution })
    if (!decided.ok) return { ok: false, refusal: decided.refusal, written: false } as const
    if (decided.kind === 'repeat') return { ok: true, kind: 'repeat', runId: decided.runId } as const
    const block = decided.block

    const prepared: { ok: true; prepared: PreparedResolve } | { ok: false; refused: R } = options.prepare
      ? yield* options.prepare(state, block)
      : { ok: true, prepared: { resolution: options.resolution } }
    if (!prepared.ok) return { ok: false, refused: prepared.refused } as const
    const { resolution, answers } = prepared.prepared
    const written = prepared.prepared.wroteBody === true
    // What is written is checked, not what was asked: `prepare` may rewrite a resolution (a grant's head), never its kind.
    if (resolution._tag !== options.resolution._tag || !allowedResolutions(block.reason).includes(resolution._tag)) {
      return {
        ok: false,
        refusal: { reason: 'not-offered', resolution: resolution._tag, waitReason: block.reason },
        written,
      } as const
    }

    // A split resolves only with its written children, checked after the caller's own checks of the plan.
    const events = resolvedEvents(state, block, {
      waitId: options.waitId,
      by: options.by,
      resolution,
      note: options.note,
      ...(answers ? { answers } : {}),
      split: options.split,
    })
    if (!events.ok) return { ok: false, refusal: events.refusal, written } as const

    let version = state.version
    if (written) {
      // The body write recorded its own events on this stream: read again, and check the wait is still the one open.
      const fresh = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', read)
      const again = resolveWaitTransition(fresh, { waitId: options.waitId, resolution: options.resolution })
      if (!again.ok || again.kind !== 'proceed') {
        return { ok: false, refusal: { reason: 'not-blocked', waitId: options.waitId }, written } as const
      }
      version = fresh.version
    }

    const lost = yield* appendLost(store, ticketId, version, [...events.events, ...(options.with ?? [])])
    if (lost) return { ok: false, lost: true, written } as const
    return { ok: true, kind: 'resolved', resolution, runId: block.runId } as const
  })
}

export type AskTicketResult = { ok: true } | { ok: false; refusal: AskDecline } | { ok: false; lost: true }

/** A question to a person before any run. A claim that landed first won, and is said so rather than retried. */
export function askTicketEffect(
  ticketId: string,
  options: SnapshotReadOptions & { store: EventStore; question: string; by: string; waitId: WaitId },
): Effect.Effect<AskTicketResult, unknown> {
  return Effect.gen(function* () {
    const state = yield* readThroughSnapshot(options.store, ticketReducer, ticketId, 'all', options)
    const decided = askTransition(state, { waitId: options.waitId, question: options.question, by: options.by })
    if (!decided.ok) return { ok: false, refusal: decided.refusal } as const
    const lost = yield* appendLost(options.store, ticketId, state.version, decided.events)
    return lost ? ({ ok: false, lost: true } as const) : ({ ok: true } as const)
  })
}

/** What a triage command reads and appends through: the narrowest store the daemon's catch-up already holds. */
export type TriageStore = Pick<EventStore, 'read' | 'readTypes' | 'append'>

export type StartTriageResult = { ok: true } | { ok: false; refusal: StartTriageDecline } | { ok: false; lost: true }

/**
 * `TriageStarted` at the attempt the caller fixed. Refused when the wait is not current or the reduce already holds
 * that attempt or a later one — a lost race is `already-started`, never retried here. A version conflict is `lost`: the
 * caller reads again and asks again, each try a fresh transition.
 */
export function startTriage(
  ticketId: string,
  options: SnapshotReadOptions & {
    store: TriageStore
    waitId: WaitId
    attempt: number
    by: Parameters<typeof startTriageTransition>[1]['by']
  },
): Effect.Effect<StartTriageResult, unknown> {
  return Effect.gen(function* () {
    const state = yield* readThroughSnapshot(options.store, ticketReducer, ticketId, 'all', options)
    // The reduce keeps `triage.started` only for a wait the ticket started; for any other the stream is the evidence.
    let startedUnseen: number | undefined
    if (!state.waits.some((w) => w.waitId === options.waitId)) {
      const events = yield* Effect.tryPromise({ try: () => options.store.read(ticketId), catch: (e) => e })
      for (const e of events) {
        const d = e.data as { waitId?: unknown; attempt?: number }
        if (e.type === 'TriageStarted' && d.waitId === options.waitId && typeof d.attempt === 'number') {
          startedUnseen = Math.max(startedUnseen ?? 0, d.attempt)
        }
      }
    }
    const decided = startTriageTransition(state, {
      waitId: options.waitId,
      attempt: options.attempt,
      by: options.by,
      ...(startedUnseen === undefined ? {} : { startedUnseen }),
    })
    if (!decided.ok) return { ok: false, refusal: decided.refusal } as const
    const lost = yield* appendLost(options.store, ticketId, state.version, decided.events)
    return lost ? ({ ok: false, lost: true } as const) : ({ ok: true } as const)
  })
}

type FinishTriageInput = Parameters<typeof finishTriageTransition>[1]

export type FinishTriageResult = { ok: true } | { ok: false; refusal: FinishTriageDecline } | { ok: false; lost: true }

/**
 * `WaitTriaged`, while the wait is current. `ifVersion` is the version a caller decided on: a stream that moved since
 * is `lost` (a refusal `changed`, said the way a conflict is). The retry loop stays the caller's (0015).
 */
export function finishTriage(
  ticketId: string,
  options: SnapshotReadOptions & {
    store: TriageStore
    ifVersion?: number
    /** A function is settled after the read, so what changed while it ran (a caller's abort) is seen. */
    result: FinishTriageInput['result'] | (() => FinishTriageInput['result'])
  } & Pick<FinishTriageInput, 'waitId' | 'attempt' | 'headSha' | 'by'>,
): Effect.Effect<FinishTriageResult, unknown> {
  return Effect.gen(function* () {
    const state = yield* readThroughSnapshot(options.store, ticketReducer, ticketId, 'all', options)
    const decided = finishTriageTransition(state, {
      waitId: options.waitId,
      attempt: options.attempt,
      headSha: options.headSha,
      result: typeof options.result === 'function' ? options.result() : options.result,
      by: options.by,
      ...(options.ifVersion === undefined ? {} : { ifVersion: options.ifVersion }),
    })
    if (!decided.ok) {
      return decided.refusal.reason === 'changed'
        ? ({ ok: false, lost: true } as const)
        : ({ ok: false, refusal: decided.refusal } as const)
    }
    const lost = yield* appendLost(options.store, ticketId, state.version, decided.events)
    return lost ? ({ ok: false, lost: true } as const) : ({ ok: true } as const)
  })
}

export type TriageRunRecord =
  | {
      _tag: 'Prompted'
      promptVersion: string
      runtimeVersion: string | null
      prompt: string
    }
  | {
      _tag: 'Spent'
      runtime: string
      outcome: {
        turns: number
        durationMs: number
        costUsd: number | null
        usage?: PayloadOf<'RunSpent'>['usage']
      }
    }

/**
 * A fact about one triage run, kept on the ticket stream (where run facts belong is 0129's to decide). It has no
 * transition: nothing about the stream refuses it. `Prompted` is `recordPrompt`, which never rejects and is not
 * retried. `Spent` is tried five times, and **a retry is not "nothing was written"** — a dropped connection can reject
 * after the transaction committed — so each try first looks for an identical `RunSpent` since the first read that
 * succeeded. Answers `null` once it has landed, otherwise the last error's message.
 */
export function recordTriageRun(
  ticketId: string,
  options: { store: EventStore; waitId: WaitId; record: TriageRunRecord; log?: (line: string) => void },
): Effect.Effect<string | null> {
  const { store, waitId, record } = options
  const log = options.log ?? (() => {})
  const spentFor = { _tag: 'Triage', waitId } as const
  if (record._tag === 'Prompted') {
    return Effect.promise(() =>
      recordPrompt(
        store,
        ticketId,
        {
          for: spentFor,
          promptVersion: record.promptVersion,
          runtimeVersion: record.runtimeVersion,
          prompt: record.prompt,
        },
        log,
      ),
    ).pipe(Effect.as(null))
  }
  const { outcome } = record
  return Effect.gen(function* () {
    // Captured from the first read that succeeds, so a failure on that very first read still retries.
    let since: number | null = null
    let lastError: unknown = null
    for (let i = 0; i < 5; i += 1) {
      const tried = yield* Effect.exit(
        Effect.gen(function* () {
          const current = yield* Effect.tryPromise({ try: () => store.read(ticketId), catch: (e) => e })
          if (since === null) since = current.length
          const alreadyLanded = current.slice(since).some((e) => {
            if (e.type !== 'RunSpent') return false
            const data = e.data as PayloadOf<'RunSpent'>
            return (
              data.for._tag === 'Triage' &&
              data.for.waitId === waitId &&
              data.turns === outcome.turns &&
              data.durationMs === outcome.durationMs &&
              data.costUsd === outcome.costUsd
            )
          })
          if (alreadyLanded) return
          yield* Effect.tryPromise({
            try: () =>
              store.append(ticketId, current.length, [
                {
                  type: 'RunSpent',
                  actor: 'conductor',
                  data: parsePayload('RunSpent', {
                    for: spentFor,
                    runtime: record.runtime,
                    turns: outcome.turns,
                    durationMs: outcome.durationMs,
                    usage: outcome.usage ?? [],
                    costUsd: outcome.costUsd,
                  }),
                },
              ]),
            catch: (e) => e,
          })
        }),
      )
      if (Exit.isSuccess(tried)) return null
      if (Cause.hasInterruptsOnly(tried.cause)) return yield* Effect.failCause(tried.cause as Cause.Cause<never>)
      lastError = Cause.squash(tried.cause)
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError)
    log(`triage ${waitId}: RunSpent append failed — ${message}`)
    return message
  })
}

export type CloseTicketResult<R> =
  | { ok: true; ended: readonly ToAppend[] }
  | { ok: false; decline: CloseDecline }
  | { ok: false; refusal: CloseRefusal }
  /** `loadEnd` refused: the caller's own answer, passed through whole. */
  | { ok: false; refused: R }
  | { ok: false; lost: true; blocked: boolean }

/**
 * Ending a ticket (#151). **A blocked item's wait is resolved in this same append** (#465, 0118 §11) — `TicketClosed`
 * and the end plan ride behind `WaitResolved`, never a resolve and then a close. `loadEnd` reads the recipe's `end`
 * steps and runs only once the ticket has said it can be closed.
 */
export function closeTicketEffect<R>(
  ticketId: string,
  options: {
    store: EventStore
    by: string
    reason: string
    waitId?: WaitId | null
    ifVersion?: number
    loadEnd: Effect.Effect<{ ok: true; end: readonly StepAction[] } | { ok: false; refused: R }, unknown>
  },
): Effect.Effect<CloseTicketResult<R>, unknown> {
  return Effect.gen(function* () {
    const events = yield* Effect.promise(() => options.store.read(ticketId))
    const state = reduceTicket(events)

    const declined = closeChecks(state, { ifVersion: options.ifVersion })
    if (declined !== null) return { ok: false, decline: declined } as const

    const loaded = yield* options.loadEnd
    if (!loaded.ok) return { ok: false, refused: loaded.refused } as const

    // One transaction: the outcome and what its point resolved to cannot come apart.
    const ended = resolveEndActions(events, loaded.end, 'closed')
    const decided = closeTransition(state, { by: options.by, reason: options.reason, waitId: options.waitId, ended })
    if (!decided.ok) return { ok: false, refusal: decided.refusal } as const

    const lost = yield* appendLost(options.store, ticketId, state.version, decided.events)
    if (lost) return { ok: false, lost: true, blocked: decided.blocked } as const
    return { ok: true, ended } as const
  })
}

/**
 * The writers below append what an attempt's ending decided, at the version
 * they read. None checks the ticket's state (none did in `conduct.ts`), and a
 * store that refuses is a defect, as `conduct.ts`'s `appendAt` made it: the
 * caller remembers it as the attempt's own (`appendNow`).
 */
function appendOnTicket(
  store: EventStore,
  ticketId: string,
  options: SnapshotReadOptions,
  events: readonly ToAppend[],
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = yield* readThroughSnapshot(store, ticketReducer, ticketId, 'all', options).pipe(Effect.orDie)
    yield* Effect.promise(() => store.append(ticketId, state.version, events))
  })
}

/** The runtime cannot fail closed: the board says why nothing ran. */
export function refuseDispatchEffect(
  ticketId: string,
  input: { runtime: string; missing: readonly string[] },
  store: EventStore,
  options: SnapshotReadOptions = {},
): Effect.Effect<void> {
  return appendOnTicket(store, ticketId, options, [
    {
      type: 'DispatchRefused',
      actor: 'conductor',
      data: parsePayload('DispatchRefused', { runtime: input.runtime, missing: [...input.missing] }),
    },
  ])
}

/**
 * `TicketLanded` and the end plan, **one append**: an `EndActionsResolved{landed}`
 * over an unrecorded landing must be unreachable, not merely unlikely.
 */
export function landTicketEffect(
  ticketId: string,
  input: { mergeCommit: string; base: string; endPlan?: readonly ToAppend[] },
  store: EventStore,
  options: SnapshotReadOptions = {},
): Effect.Effect<void> {
  return appendOnTicket(store, ticketId, options, [
    {
      type: 'TicketLanded',
      actor: 'conductor',
      data: parsePayload('TicketLanded', { mergeCommit: input.mergeCommit, base: input.base }),
    },
    ...(input.endPlan ?? []),
  ])
}

/** `WaitStarted` and the end plan, one append, for the landing's reason. */
export function holdTicketEffect(
  ticketId: string,
  input: { waitId: string; reason: WaitReason; endPlan?: readonly ToAppend[] },
  store: EventStore,
  options: SnapshotReadOptions = {},
): Effect.Effect<void> {
  return appendOnTicket(store, ticketId, options, [
    {
      type: 'WaitStarted',
      actor: 'conductor',
      data: parsePayload('WaitStarted', { waitId: input.waitId, reason: input.reason }),
    },
    ...(input.endPlan ?? []),
  ])
}

/**
 * The one `PromptEdited` both writers build. The hash is the digest the next run's `promptVersion` will carry, from
 * the same function, so the event and the version cannot name different numbers for one edit; null on a removal.
 * It does not trim: what is typed is what the attempt is told, byte for byte.
 */
function promptEdited(input: { text: string; by: string; basedOn: string | null; chatId: string | null }): ToAppend {
  return {
    type: 'PromptEdited',
    actor: input.by,
    data: parsePayload('PromptEdited', {
      text: input.text,
      hash: input.text.trim() === '' ? null : editHash(input.text),
      by: input.by,
      basedOn: input.basedOn,
      chatId: input.chatId,
    }),
  }
}

/**
 * A person's edit to the next attempt's prompt (#104). It decides nothing about state, so a lost race re-reads the
 * head once and appends there; `basedOn` records what the person saw and is never checked. A second lost race fails.
 */
export function editPromptEffect(
  store: EventStore,
  ticketId: string,
  input: { text: string; basedOn: string | null; by: string },
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const events = [promptEdited({ ...input, chatId: null })]
    const head = () => Effect.tryPromise({ try: () => store.head(ticketId), catch: (error) => error })
    const lost = yield* appendLost(store, ticketId, yield* head(), events)
    if (!lost) return
    const at = yield* head()
    yield* Effect.tryPromise({ try: () => store.append(ticketId, at, events), catch: (error) => error })
  })
}

/**
 * What Lingtai wrote to GitHub about a ticket (`IssueUpdated`, `IssueUpdateFailed`). A fact about GitHub rather than a
 * decision about the stream, so no transition refuses it: append at the head just read, one attempt. It fails when the
 * read or the append does; whether that matters is the caller's, and each caller says so at its call.
 */
export function recordIssueUpdate<T extends 'IssueUpdated' | 'IssueUpdateFailed'>(
  store: EventStore,
  ticketId: string,
  type: T,
  data: PayloadOf<T>,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const at = yield* Effect.tryPromise({ try: () => store.head(ticketId), catch: (error) => error })
    yield* Effect.tryPromise({
      try: () => store.append(ticketId, at, [{ type, actor: 'conductor', data: parsePayload(type, data) }]),
      catch: (error) => error,
    })
  })
}

/**
 * A split's progress on GitHub (`SplitStarted`, `SplitFailed`, `SplitChildWritten`, `SplitLinkWritten`), written by
 * `by`. Facts about GitHub, not decisions about the stream: append at its current version, once more if it moved.
 */
export function recordSplitProgress<
  T extends 'SplitStarted' | 'SplitFailed' | 'SplitChildWritten' | 'SplitLinkWritten',
>(store: EventStore, ticketId: string, type: T, data: PayloadOf<T>, by: string): Effect.Effect<void, unknown> {
  const once = Effect.gen(function* () {
    const at = yield* Effect.tryPromise({ try: () => store.head(ticketId), catch: (error) => error })
    yield* Effect.tryPromise({
      try: () => store.append(ticketId, at, [{ type, actor: by, data: parsePayload(type, data) }]),
      catch: (error) => error,
    })
  })
  return once.pipe(
    Effect.catchIf(
      (e) => e instanceof ConcurrencyError,
      () => once,
    ),
  )
}

/**
 * `DiscussionHeld`, preceded in the same append by the `PromptEdited` a `prompt` outcome adopts: one decision, one
 * append, so neither is written without the other. No retry: a lost race is the conclusion's failure.
 */
export function concludeDiscussionOnTicketEffect(
  store: EventStore,
  ticketId: string,
  input: { chatId: string; by: string } & (
    | { outcome: 'prompt'; prompt: string }
    | { outcome: 'ticket' | 'none'; prompt?: undefined }
  ),
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const { chatId, by } = input
    const head = yield* Effect.tryPromise({ try: () => store.head(ticketId), catch: (error) => error })
    const held: ToAppend = {
      type: 'DiscussionHeld',
      actor: by,
      data: parsePayload('DiscussionHeld', { chatId, outcome: input.outcome, by }),
    }
    // `basedOn` is null and that is the honest value: the assistant proposes a sentence, not a change to a
    // document, so nobody was looking at a composed prompt when this was adopted (#104).
    const events =
      input.outcome === 'prompt' ? [promptEdited({ text: input.prompt, by, basedOn: null, chatId }), held] : [held]
    yield* Effect.tryPromise({ try: () => store.append(ticketId, head, events), catch: (error) => error })
  })
}

/**
 * `EndActionsResolved` alone, for `cli end` replaying an ending. Returns what
 * it wrote, so the caller can carry it out: resolving and doing are two steps
 * on purpose.
 */
export function recordEndPlanEffect(
  store: EventStore,
  ticketId: string,
  actions: readonly StepAction[],
  outcome: TerminalOutcome,
): Effect.Effect<ToAppend[], unknown> {
  return Effect.gen(function* () {
    if (actions.length === 0) return []
    const events = yield* Effect.tryPromise({ try: () => store.read(ticketId), catch: (error) => error })
    const toAppend = resolveEndActions(events, actions, outcome)
    if (toAppend.length === 0) return []
    yield* Effect.tryPromise({ try: () => store.append(ticketId, events.length, toAppend), catch: (error) => error })
    return toAppend
  })
}
