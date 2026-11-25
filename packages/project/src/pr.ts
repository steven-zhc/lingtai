/**
 * The PR's commands and reads: every append to `pr-{project}-{n}`, and the draft (0130 §5, 0129 §1).
 *
 * The same shape as the Project's commands beside it: read the stream, ask a pure transition (`@lingtai/domain`'s
 * `pr.ts`), append at the version read, and on a lost race re-read and ask again once. **No process store is reached
 * from here** — every function takes `store` — because the board imports this package.
 *
 * Every later PR ticket adds its commands to this file; nothing else appends to a `pr-` stream, except that
 * `draftBatchFor` hands one batch to `landTicketEffect`, which writes it beside the ticket's own (0129 §5).
 */
import {
  type Envelope,
  type PayloadOf,
  type PrState,
  type ToAppend,
  prStream,
  reducePr,
  reduceTicket,
  openAmong,
  requestSubmit,
  freezeTransition,
  landedSeq,
  landingsStarted,
  parseTicketStream,
  refuseTransition,
  stepDoneTransition,
  pushedTransition,
  restartTransition,
  fixLandedTransition,
  fixRestartTransition,
  draftOpenedTransition,
  addDraftTicket,
  emptyPr,
  ciSkippedTransition,
  ciFollowingTransition,
  checkedTransition,
  openedTransition,
  mergedTransition,
  closedTransition,
  ticketsHandedBack,
  backClosedTransition,
  retryTransition,
  adoptTransition,
  grantTransition,
  retryRequestTransition,
  backRequestTransition,
  type PrRequest,
  waitTransition,
  outsideTransition,
  syncedTransition,
  syncRoundTransition,
  syncRefusalTransition,
  mergedBackTransition,
  mergeBackFailedTransition,
  caughtUpTransition,
  catchUpFailedTransition,
  summaryWrittenTransition,
  summaryNotWrittenTransition,
  descriptionPushedTransition,
  summaryEditTransition,
  ticketStream,
  integrationStream,
} from '@lingtai/domain'
import { ConcurrencyError, type EventStore, type StreamBatch } from '@lingtai/event-store/store'
import { Effect } from 'effect'
import { parse as parseYaml } from 'yaml'

import { withOneRetry } from './commands.ts'

const failed = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** One PR's stream as it stands. */
export function readPrEvents(project: string, n: number, store: EventStore): Effect.Effect<Envelope[], Error> {
  return Effect.tryPromise({ try: () => store.read(prStream(project, n)), catch: failed })
}

/** One PR reduced, or null when `n` has no events. A failed read is an error, never *no such PR*. */
export function readPr(project: string, n: number, store: EventStore): Effect.Effect<PrState | null, Error> {
  return readPrEvents(project, n, store).pipe(Effect.map((events) => (events.length === 0 ? null : reducePr(events))))
}

/**
 * Every PR of a project, in number order. Numbers are consecutive from 1 and found by `head` — one past the highest
 * stream with any event — so no listing of the log (and no `startsWith('pr')`, which takes `prj-` for a PR) is
 * needed.
 */
export function listPrs(project: string, store: EventStore): Effect.Effect<PrState[], Error> {
  return Effect.gen(function* () {
    const prs: PrState[] = []
    for (let n = 1; ; n++) {
      const head = yield* Effect.tryPromise({ try: () => store.head(prStream(project, n)), catch: failed })
      if (head === 0) return prs
      const pr = yield* readPr(project, n, store)
      if (pr !== null) prs.push(pr)
    }
  })
}

/** The project's highest-numbered PR, or null if it never had one. */
export function latestPr(project: string, store: EventStore): Effect.Effect<PrState | null, Error> {
  return listPrs(project, store).pipe(Effect.map((prs) => prs[prs.length - 1] ?? null))
}

/** The open PR: the highest-numbered one not in `draft`, when it is open; null otherwise. */
export function openPr(project: string, store: EventStore): Effect.Effect<PrState | null, Error> {
  return listPrs(project, store).pipe(Effect.map(openAmong))
}

/**
 * The stream the draft is on. The highest PR when it is in `draft` or `requested`, with its stream's version;
 * otherwise the next number, at version 0 and in no state.
 */
export function draftTarget(
  project: string,
  store: EventStore,
): Effect.Effect<{ n: number; version: number; state: PrState['status'] }, Error> {
  return listPrs(project, store).pipe(Effect.map(draftOf))
}

const draftOf = (prs: readonly PrState[]): { n: number; version: number; state: PrState['status'] } => {
  const top = prs[prs.length - 1]
  if (top === undefined) return { n: 1, version: 0, state: null }
  if (top.status === 'draft' || top.status === 'requested') {
    return { n: top.n ?? prs.length, version: top.version, state: top.status }
  }
  return { n: (top.n ?? prs.length) + 1, version: 0, state: null }
}

/**
 * The batch that adds a landed ticket to the draft, **not an append**: the caller writes it with the ticket's own
 * (ADR 0131 §1). The stream is `draftTarget`'s, at the version it was read at; the event is the PR's own transition.
 * A transition that declines is a defect — `draftTarget` never names a PR in a status that refuses.
 */
export function draftBatchFor(
  project: string,
  input: { ticket: string; mergeCommit: string; from: number | null },
  store: EventStore,
): Effect.Effect<StreamBatch, Error> {
  return Effect.gen(function* () {
    const prs = yield* listPrs(project, store)
    const target = draftOf(prs)
    const top = prs[prs.length - 1]
    const state = target.state === null || top === undefined ? emptyPr : top
    const event = addDraftTicket(state, input)
    if (event === null)
      return yield* Effect.die(new Error(`the draft of ${project} refused a ticket in ${state.status}`))
    return { streamId: prStream(project, target.n), expectedVersion: target.version, events: [event] }
  })
}

/** The tickets the draft holds: the highest PR's `draft` while it is in `draft`, else none. */
export function readDraft(project: string, store: EventStore): Effect.Effect<PrState['draft'], Error> {
  return listPrs(project, store).pipe(Effect.map(draftIn))
}

/** The draft among PRs already read: the highest one's tickets while it is `draft`, else none. One read, one answer. */
export function draftIn(prs: readonly PrState[]): PrState['draft'] {
  const top = prs[prs.length - 1]
  return top !== undefined && top.status === 'draft' ? top.draft : []
}

/**
 * The statuses of a PR whose draft tickets are on `branch.personal`'s history: a refused or closed PR may never have
 * had its code reach it (#1423).
 */
const LANDED_PR_STATUSES: ReadonlySet<NonNullable<PrState['status']>> = new Set([
  'draft',
  'requested',
  'in-progress',
  'waiting',
  'in-review',
  'merged',
])

/**
 * The tickets that *joined a draft* (`PrDraftTicketAdded`) in PRs of these streams whose status says the code is on the
 * personal branch, as the issue numbers they were written with (#1423). Not `PrState.draft ∪ PrState.tickets`: a
 * `PrInProgress` empties `draft`, and a pr-fix lands on the PR's own branch, so `tickets` holds tickets that are not
 * on the personal branch. Pure, over envelopes already read.
 */
export function draftedTicketsIn(streams: readonly (readonly Envelope[])[]): Set<string> {
  const drafted = new Set<string>()
  for (const events of streams) {
    if (events.length === 0) continue
    const status = reducePr(events).status
    if (status === null || !LANDED_PR_STATUSES.has(status)) continue
    for (const event of events) {
      if (event.type === 'PrDraftTicketAdded') drafted.add((event.data as { ticket: string }).ticket)
    }
  }
  return drafted
}

/** `draftedTicketsIn` over every PR of a project. A failed read is the error, never *none drafted*. */
export function readDraftedTickets(project: string, store: EventStore): Effect.Effect<ReadonlySet<string>, Error> {
  return Effect.gen(function* () {
    const streams: Envelope[][] = []
    for (let n = 1; ; n++) {
      const head = yield* Effect.tryPromise({ try: () => store.head(prStream(project, n)), catch: failed })
      if (head === 0) return draftedTicketsIn(streams)
      streams.push(yield* readPrEvents(project, n, store))
    }
  })
}

/** Appends one PR's transition at the head it was read at, if the transition decides anything. */
const transitionPr = <A>(
  store: EventStore,
  project: string,
  n: number,
  transition: (state: PrState) => ToAppend | null,
  answer: (state: PrState, appended: boolean) => A,
): Effect.Effect<A, Error> =>
  withOneRetry(
    Effect.gen(function* () {
      const state = reducePr(yield* readPrEvents(project, n, store))
      const next = transition(state)
      if (next === null) return answer(state, false)
      yield* Effect.tryPromise({
        try: () => store.append(prStream(project, n), state.version, [next]),
        catch: (e) => e,
      })
      return answer(state, true)
    }),
  )

/** What a Submit came to. */
export type SubmitAnswer =
  | { kind: 'requested'; n: number }
  | { kind: 'refused'; reason: 'solo' | 'open-pr' | 'nothing-landed'; detail: string }

/**
 * A person asks for the personal branch to be submitted: an event on the draft's own stream, at the version read.
 * Refused `solo`, `open-pr` (an open PR, even one below a draft, or a draft already `requested`) and
 * `nothing-landed` (the highest PR is not in `draft`) without appending. **Two Submits at once**: both append at
 * the draft's version; the loser re-reads, finds it `requested` and is refused `open-pr`.
 */
export const requestPrSubmit = (
  project: string,
  mode: 'solo' | 'team',
  by: string,
  store: EventStore,
): Effect.Effect<SubmitAnswer, Error> =>
  withOneRetry(
    Effect.gen(function* () {
      const prs = yield* listPrs(project, store)
      const top = prs[prs.length - 1]
      const decided = requestSubmit(openAmong(prs), mode, project, by, top?.status === 'draft')
      if (decided.kind === 'refused') return decided
      const target = draftOf(prs)
      // `listPrs` reads the streams one after another, so a PR read early may have moved while a later one was read.
      // Every stream below the target is read again; one that moved fails this attempt as a lost race, to read afresh.
      for (const pr of prs) {
        if (pr.n === null || pr.n === target.n) continue
        const stream = prStream(project, pr.n)
        const head = yield* Effect.tryPromise({ try: () => store.head(stream), catch: failed })
        if (head !== pr.version) return yield* Effect.fail(new ConcurrencyError(stream, pr.version, [head]))
      }
      yield* Effect.tryPromise({
        try: () => store.append(prStream(project, target.n), target.version, [decided.event]),
        catch: (e) => e,
      })
      return { kind: 'requested', n: target.n } as SubmitAnswer
    }),
  )

/** The serve refused a request it found it could not honour. */
export const recordPrRefused = (
  project: string,
  n: number,
  refusal: PayloadOf<'PrSubmitRefused'>,
  store: EventStore,
  decided?: PrState,
): Effect.Effect<boolean, Error> =>
  decided !== undefined
    ? // Pinned: the refusal was decided against this snapshot, so it is written at its version or not at all.
      Effect.gen(function* () {
        const next = refuseTransition(decided, refusal)
        if (next === null) return false
        yield* Effect.tryPromise({
          try: () => store.append(prStream(project, n), decided.version, [next]),
          catch: (e) => e,
        })
        return true
      }).pipe(Effect.mapError((e) => (e instanceof ConcurrencyError ? e : failed(e))))
    : transitionPr(
        store,
        project,
        n,
        (state) => refuseTransition(state, refusal),
        (_state, appended) => appended,
      )

type Batches = Parameters<EventStore['appendAll']>[0] extends readonly (infer B)[] ? B[] : never

/** One `PrDraftTicketAdded` per ticket, through the domain's guard, for a stream that is in no state yet. */
const draftEvents = (tickets: readonly PayloadOf<'PrDraftTicketAdded'>[]): ToAppend[] =>
  tickets.flatMap((t) => {
    const added = addDraftTicket(reducePr([]), t)
    return added === null ? [] : [added]
  })

/**
 * The freeze: In progress, with the branch's commit and the tickets it holds.
 *
 * With `decided`, the write is pinned to the version of the `PrState` the freeze asked git about: `PrInProgress` on
 * stream `n` at that version, and the tickets the commit does not hold on stream `n + 1` (the next draft), in one
 * `appendAll`. **No retry in here, and no read of PR `n`**: a landing between the freeze's read and its write moves
 * stream `n`, the write fails with a `ConcurrencyError`, and the caller reads, asks git and decides again. Nothing to
 * hand over is today's single append. Without `decided` it reads the PR itself and hands nothing over.
 */
export const recordPrInProgress = (
  project: string,
  n: number,
  frozen: Parameters<typeof freezeTransition>[1],
  store: EventStore,
  decided?: { state: PrState; notKept: readonly PayloadOf<'PrDraftTicketAdded'>[] },
): Effect.Effect<boolean, Error> => {
  if (decided === undefined) {
    return transitionPr(
      store,
      project,
      n,
      (state) => freezeTransition(state, frozen),
      (_state, appended) => appended,
    )
  }
  return Effect.gen(function* () {
    const event = freezeTransition(decided.state, frozen)
    if (event === null) return false
    const handed = draftEvents(decided.notKept)
    const batches: Batches = [
      { streamId: prStream(project, n), expectedVersion: decided.state.version, events: [event] },
    ]
    if (handed.length > 0) {
      const next = prStream(project, n + 1)
      const head = yield* Effect.tryPromise({ try: () => store.head(next), catch: failed })
      batches.push({ streamId: next, expectedVersion: head, events: handed })
    }
    yield* Effect.tryPromise({ try: () => store.appendAll(batches), catch: (e) => e })
    return true
  }).pipe(Effect.mapError((e) => (e instanceof ConcurrencyError ? e : failed(e))))
}

/** In progress starts again from its first step, on the same freeze. */
export const recordPrRestart = (project: string, n: number, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => restartTransition(state),
    (_state, appended) => appended,
  )

/**
 * A pr-fix ticket landed on the PR's branch (#1341): the PR is owed In progress again. Appends nothing for a PR that is
 * no longer open or one that already holds the ticket, so the in-lane append and the sweep's repair write it once.
 */
export const recordPrFixLanded = (project: string, n: number, landed: PayloadOf<'PrFixLanded'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => fixLandedTransition(state, landed),
    (_state, appended) => appended,
  )

/** In progress starts again because a pr-fix landed: from the head the fix made, tickets including it. */
export const recordPrFixRestart = (project: string, n: number, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => fixRestartTransition(state),
    (_state, appended) => appended,
  )

/** A step answered `done`, on the head it ran on. A step already recorded appends nothing. */
export const recordPrStepDone = (project: string, n: number, done: PayloadOf<'PrStepDone'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => stepDoneTransition(state, done),
    (_state, appended) => appended,
  )

/** The PR branch is on the remote. A push already recorded since the latest `PrInProgress` appends nothing. */
export const recordPrPushed = (project: string, n: number, pushed: PayloadOf<'PrPushed'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => pushedTransition(state, pushed),
    (_state, appended) => appended,
  )

/** The draft pull request is open on GitHub. Recorded once per pass through In progress. */
export const recordPrDraftOpened = (
  project: string,
  n: number,
  opened: PayloadOf<'PrDraftOpened'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => draftOpenedTransition(state, opened),
    (_state, appended) => appended,
  )

/** The `ci` step is passed over: the project has no CI on this PR. */
export const recordPrCiSkipped = (project: string, n: number, skipped: PayloadOf<'PrCiSkipped'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => ciSkippedTransition(state, skipped),
    (_state, appended) => appended,
  )

/** CI follows this head; a head that moved takes the walk back to `ci` on it. */
export const recordPrCiFollowing = (
  project: string,
  n: number,
  following: PayloadOf<'PrCiFollowing'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => ciFollowingTransition(state, following),
    (_state, appended) => appended,
  )

/** A verdict on the PR's head. The same one on the same head appends nothing. */
export const recordPrChecked = (project: string, n: number, checked: PayloadOf<'PrChecked'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => checkedTransition(state, checked),
    (_state, appended) => appended,
  )

/** The PR is In review. */
export const recordPrOpened = (project: string, n: number, opened: PayloadOf<'PrOpened'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => openedTransition(state, opened),
    (_state, appended) => appended,
  )

/** Commits others pushed to the PR branch are merged into the PR's commit and built (#1353). A step already recorded appends nothing. */
export const recordPrOutsideMerged = (
  project: string,
  n: number,
  merged: PayloadOf<'PrOutsideMerged'>,
  onto: string,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => outsideTransition(state, merged, onto),
    (_state, appended) => appended,
  )

/** Main is in the PR's commit (already, or merged and built). A step already recorded appends nothing. */
export const recordBranchSynced = (project: string, n: number, synced: PayloadOf<'BranchSynced'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => syncedTransition(state, synced),
    (_state, appended) => appended,
  )

/** The merge back pushed `branch.personal`. Once per head. */
export const recordPrMergedBack = (project: string, n: number, merged: PayloadOf<'PrMergedBack'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => mergedBackTransition(state, merged),
    (state, appended): 'recorded' | 'already' | 'refused' =>
      appended
        ? 'recorded'
        : state.mergeBack?.prHead === merged.prHead && state.mergeBack.outcome === 'merged'
          ? 'already'
          : 'refused',
  )

/** The merge back did not complete; with `unknown` it is not known whether the push landed, and the head stays owed. Once per head. */
export const recordPrMergeBackFailed = (
  project: string,
  n: number,
  failed: PayloadOf<'PrMergeBackFailed'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => mergeBackFailedTransition(state, failed),
    (_state, appended) => appended,
  )

/** The personal branch was caught up with `main` after the merge (#1371). Once per PR; the answer says whether it was already there. */
export const recordPrCaughtUp = (project: string, n: number, caught: PayloadOf<'PrCaughtUp'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => caughtUpTransition(state, caught),
    (state, appended): 'recorded' | 'already' | 'refused' =>
      appended ? 'recorded' : state.catchUp?.outcome === 'caught-up' ? 'already' : 'refused',
  )

/** The catch-up did not complete; `unknown` and `locked` stay owed. Once per answer. */
export const recordPrCatchUpFailed = (
  project: string,
  n: number,
  failed: PayloadOf<'PrCatchUpFailed'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => catchUpFailedTransition(state, failed),
    (_state, appended) => appended,
  )

/** The PR was found merged. A PR already merged or closed appends nothing. */
export const recordPrMerged = (project: string, n: number, merged: PayloadOf<'PrMerged'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => mergedTransition(state, merged),
    (_state, appended) => appended,
  )

/**
 * A PR ends without merging: its `PrClosed` and, in the same `appendAll`, its tickets handed back to the draft
 * (`ticketsHandedBack`) on the draft's own stream, each naming this PR. Reads, decides and writes as one unit inside
 * one retry: a `ConcurrencyError` on either stream writes neither, and both are read again. Answers whether it closed.
 */
const closeAndHandBack = (
  store: EventStore,
  project: string,
  n: number,
  transition: (state: PrState) => ToAppend<PayloadOf<'PrClosed'>> | null,
): Effect.Effect<boolean, Error> =>
  withOneRetry(
    Effect.gen(function* () {
      const prs = yield* listPrs(project, store)
      const state = prs.find((p) => p.n === n)
      if (state === undefined) return false
      const closed = transition(state)
      if (closed === null) return false
      const target = draftOf(prs)
      const handed = draftEvents(ticketsHandedBack(state))
      const batches: Batches = [{ streamId: prStream(project, n), expectedVersion: state.version, events: [closed] }]
      if (handed.length > 0)
        batches.push({ streamId: prStream(project, target.n), expectedVersion: target.version, events: handed })
      yield* Effect.tryPromise({ try: () => store.appendAll(batches), catch: (e) => e })
      return true
    }),
  )

/** The PR was found closed without merging: its tickets go back to the draft in the same transaction. */
export const recordPrClosed = (project: string, n: number, closed: PayloadOf<'PrClosed'>, store: EventStore) =>
  closeAndHandBack(store, project, n, (state) => closedTransition(state, closed))

/** A step needs a person. The same wait twice appends nothing. */
export const recordPrWaiting = (project: string, n: number, wait: PayloadOf<'PrWaiting'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => waitTransition(state, wait),
    (_state, appended) => appended,
  )

/** A landing begun and not on the log as a `TicketLanded`; `headSha` is set when whether it pushed is for git to say. */
export interface LandingInFlight {
  readonly ticketId: string
  readonly headSha: string | null
}

/**
 * The tickets whose landing on `base` has begun and is not yet on the log as a `TicketLanded`: an integration attempted
 * with no terminal, an `unexpected` refusal, or one that succeeded (the push is done) before its ticket recorded the
 * landing. Git can already hold such a ticket's merge commit while the draft cannot yet name it, so a freeze that reads
 * both must wait these out. **The ticket's lifecycle says nothing here**: a release or a close does not take back a push,
 * so an attempt nobody finished carries its `headSha` and the freeze asks git whether the frozen commit holds it.
 */
export function landingsInFlight(
  project: string,
  base: string,
  store: EventStore,
): Effect.Effect<LandingInFlight[], Error> {
  return Effect.gen(function* () {
    const events = yield* Effect.tryPromise({ try: () => store.read(integrationStream(project, base)), catch: failed })
    const pending: LandingInFlight[] = []
    for (const started of landingsStarted(events)) {
      const ticket = reduceTicket(yield* Effect.tryPromise({ try: () => store.read(started.ticketId), catch: failed }))
      if (started.mergeCommit === null) {
        if (ticket.landed === null) pending.push({ ticketId: started.ticketId, headSha: started.headSha })
        continue
      }
      if (ticket.landed?.mergeCommit !== started.mergeCommit)
        pending.push({ ticketId: started.ticketId, headSha: null })
    }
    return pending
  })
}

/** A ticket in the draft: what a PR would hold of it. */
export interface PrDraftTicket {
  readonly ticket: string
  readonly mergeCommit: string
  readonly title: string
}

/** Whether a recorded recipe text says `mode: team`. Text that does not parse is not team: it can only shrink the draft. */
export function isTeamSource(source: string): boolean {
  try {
    const raw: unknown = parseYaml(source)
    return typeof raw === 'object' && raw !== null && (raw as { mode?: unknown }).mode === 'team'
  } catch {
    return false
  }
}

/**
 * The branch a landing joins the draft on, from a recorded recipe text: `branch.personal` of a `mode: team` recipe, or
 * null where the text is not team or names none. The live pass joins the draft for exactly this base (`draftOfLanding`).
 */
export function draftBranchOf(source: string): string | null {
  try {
    if (!isTeamSource(source)) return null
    const raw = parseYaml(source) as { branch?: { personal?: unknown } } | null
    const personal = raw?.branch?.personal
    return typeof personal === 'string' ? personal : null
  } catch {
    return null
  }
}

/**
 * How many of a page's independent per-item reads (a PR stream, a draft ticket) run at once, per reader. Unbounded, a
 * project with hundreds of items would open hundreds of reads on the store together and every other reader would wait
 * behind them. The board's Postgres log is one `pg.Pool` per process (`choose.ts`: "one `pg.Pool` for a Postgres
 * machine"; `db.ts`: "Each call constructs its own `pg.Pool`") and no `max` is passed, so `pg`'s own default of 10
 * clients applies. The bound is per reader: the PRs and the draft are read side by side, so the page peaks at twice
 * this plus the bar's reads, and what is over the pool's size queues inside the board process's pool.
 */
export const READ_CONCURRENCY = 8

/**
 * The tickets the draft holds, each with its title: `readDraft`'s list in the stream's order (the order they joined),
 * and one read of each ticket's own stream for the title (`#<issue>` where it has none). Only the PR streams and the
 * draft's tickets are read — never every ticket that ever landed. A failed read fails the whole read: it is never
 * *no tickets*.
 */
export function readDraftTickets(project: string, store: EventStore): Effect.Effect<PrDraftTicket[], Error> {
  return Effect.gen(function* () {
    const draft = yield* readDraft(project, store)
    // `forEach` returns in input order, which is the stream's order; the first failure interrupts the reads in flight.
    return yield* Effect.forEach(
      draft,
      (t) =>
        Effect.tryPromise({ try: () => store.read(ticketStream(project, t.ticket)), catch: failed }).pipe(
          Effect.map((events): PrDraftTicket => {
            const state = reduceTicket(events)
            return { ticket: t.ticket, mergeCommit: t.mergeCommit, title: state.title ?? `#${t.ticket}` }
          }),
        ),
      { concurrency: READ_CONCURRENCY },
    )
  })
}

/**
 * The pr-fix landings on an open PR's branch that the PR does not hold (#1341): tickets whose latest landing is on
 * `prBranch` and are not among the PR's tickets, so a process that died between `TicketLanded` and `PrFixLanded` is
 * mended on the next sweep. A PR's branch is named for it alone, so nothing landed there is anything but its fix.
 *
 * The candidates are the tickets named on the PR branch's integration stream — every ticket with an attempt, a refusal
 * or a success there, not only each one's last event, so a ticket that landed and was later refused again is still
 * found. Each is decided by its own stream; one that never landed on the branch is skipped.
 */
export function readUnheldFixLandings(
  project: string,
  pr: PrState,
  store: EventStore,
): Effect.Effect<PayloadOf<'PrFixLanded'>[], Error> {
  return Effect.gen(function* () {
    const unheld: PayloadOf<'PrFixLanded'>[] = []
    const order = new Map<string, bigint>()
    const branch = pr.prBranch
    if (branch === null) return unheld
    const lane = yield* Effect.tryPromise({
      try: () => store.read(integrationStream(project, branch)),
      catch: failed,
    })
    // An integration event's `ticketId` is the ticket's stream id; the issue is what the PR holds.
    const named = new Set<string>()
    for (const e of lane) {
      if (e.type !== 'IntegrationAttempted' && e.type !== 'IntegrationRefused' && e.type !== 'IntegrationSucceeded')
        continue
      const parsed = parseTicketStream((e.data as { ticketId: string }).ticketId)
      if (parsed !== null && parsed.project === project) named.add(parsed.issue)
    }
    for (const issue of named) {
      if (pr.tickets.some((t) => t.ticket === issue)) continue
      const events = yield* Effect.tryPromise({ try: () => store.read(ticketStream(project, issue)), catch: failed })
      const state = reduceTicket(events)
      if (state.landed === null || state.landed.base !== branch) continue
      const landedAt = landedSeq(events, branch)
      if (landedAt === null) continue
      order.set(issue, landedAt)
      unheld.push({
        ticket: issue,
        mergeCommit: state.landed.mergeCommit,
        ...(state.title === null ? {} : { title: state.title }),
      })
    }
    // In the order they landed: the PR's head must only ever move forward.
    return unheld.sort((a, b) => Number((order.get(a.ticket) ?? 0n) - (order.get(b.ticket) ?? 0n)))
  })
}

/**
 * A round of the conflict agent starts (#1313): appended **before** the agent is dispatched, and answers whether this call
 * appended it. A round already counted for the commit (a second appender read the same head) appends nothing and answers
 * false, so the agent is not started twice for one round.
 */
export const recordSyncRoundStarted = (
  project: string,
  n: number,
  round: PayloadOf<'SyncRoundStarted'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => syncRoundTransition(state, round),
    (_state, appended) => appended,
  )

/** A started round was refused (#1313): on the log, so a restart and the end of the rounds read it and not memory. */
export const recordSyncRoundRefused = (
  project: string,
  n: number,
  refusal: PayloadOf<'SyncRoundRefused'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => syncRefusalTransition(state, refusal),
    (_state, appended) => appended,
  )

/** Which PR a person's request is about, and whether its project is team: a solo project has none. */
export interface PrRef {
  readonly project: string
  readonly n: number
  readonly mode: 'solo' | 'team'
}

/** What a request came to: appended for the conductor to serve, or the sentence that says why not. */
export type PrRequestAnswer = { kind: 'appended' } | { kind: 'refused'; detail: string }

/**
 * Reads the PR, asks the pure transition, and appends what it decides at the version read — the shape of `pauseProject`.
 * **Nothing here writes the event itself**: a refusal appends nothing and says why.
 */
const requestOnPr = <E>(
  store: EventStore,
  pr: PrRef,
  transition: (state: PrState | null) => PrRequest<E>,
): Effect.Effect<PrRequestAnswer, Error> =>
  withOneRetry(
    Effect.gen(function* () {
      const events = yield* readPrEvents(pr.project, pr.n, store)
      const state = events.length === 0 ? null : reducePr(events)
      const decided = transition(state)
      if (decided.kind === 'refused') return { kind: 'refused', detail: decided.detail } as PrRequestAnswer
      yield* Effect.tryPromise({
        try: () => store.append(prStream(pr.project, pr.n), state?.version ?? 0, [decided.event]),
        catch: (e) => e,
      })
      return { kind: 'appended' } as PrRequestAnswer
    }),
  )

/** *Give the agent 3 more rounds* for the commit the wait is about (#1314). */
export const grantPrRounds = (
  pr: PrRef,
  grant: { by: string; merging: 'main' | 'back' | 'outside'; commit: string },
  store: EventStore,
): Effect.Effect<PrRequestAnswer, Error> =>
  requestOnPr(store, pr, (state) => grantTransition(state, pr.mode, pr.project, grant))

/** *Check again* (`lingtai pr retry`, #1314). */
export const requestPrRetry = (
  pr: PrRef,
  request: { by: string },
  store: EventStore,
): Effect.Effect<PrRequestAnswer, Error> =>
  requestOnPr(store, pr, (state) => retryRequestTransition(state, pr.mode, pr.project, request.by))

/** *Back*: close the draft and return the PR's tickets to Draft (#1314). */
export const requestPrBack = (
  pr: PrRef,
  request: { by: string },
  store: EventStore,
): Effect.Effect<PrRequestAnswer, Error> =>
  requestOnPr(store, pr, (state) => backRequestTransition(state, pr.mode, pr.project, request.by))

/** The conductor served a retry without a head to adopt: In progress starts again from its first step. */
export const recordPrRetried = (project: string, n: number, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => retryTransition(state),
    (_state, appended) => appended,
  )

/** The conductor adopted the head a person pushed to the PR branch. */
export const recordPrHeadAdopted = (
  project: string,
  n: number,
  adopted: PayloadOf<'PrHeadAdopted'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => adoptTransition(state, adopted),
    (_state, appended) => appended,
  )

/** A back was served: the PR is closed, with or without a pull request on a code host to close; its tickets go back to the draft. */
export const recordPrTakenBack = (project: string, n: number, closed: PayloadOf<'PrClosed'>, store: EventStore) =>
  closeAndHandBack(store, project, n, (state) => backClosedTransition(state, closed))

/**
 * The `pr:` agent's answer (#1318). **The person's words win a race**: where a `PrSummaryEdited` landed after the version
 * the run began at (`basedOn`), the text is set aside and `PrSummaryNotWritten` is what is appended. Answers which of the
 * two it was, or null when the PR was no longer walking.
 */
export const recordPrSummaryWritten = (
  project: string,
  n: number,
  written: PayloadOf<'PrSummaryWritten'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => summaryWrittenTransition(state, written),
    (_state, appended) => appended,
  )

/** No summary was written this time: a lock, a failed run. The PR goes on with the one it has. */
export const recordPrSummaryNotWritten = (
  project: string,
  n: number,
  notWritten: PayloadOf<'PrSummaryNotWritten'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => summaryNotWrittenTransition(state, notWritten),
    (_state, appended) => appended,
  )

/** The description on the code host is the log's: appended whether or not the hash changed, so what was owed is settled. */
export const recordPrDescriptionPushed = (
  project: string,
  n: number,
  pushed: PayloadOf<'PrDescriptionPushed'>,
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => descriptionPushedTransition(state, pushed),
    (_state, appended) => appended,
  )

/** One paid run of the `pr:` agent, on the PR's own stream (0110 §9, #1318): its `RunSpent`, appended at the head it is read at. */
export const recordPrRunSpent = (project: string, n: number, spent: PayloadOf<'RunSpent'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    () => ({ type: 'RunSpent', actor: 'conductor', data: spent }),
    (_state, appended) => appended,
  )

/**
 * *Replace the summary* (#1318, `lingtai pr summary --file`): refused by name where there is nothing open to push to, and
 * otherwise appended for the daemon to serve — it regenerates the description and puts it on the code host.
 */
export const editPrSummary = (
  pr: PrRef,
  edit: { by: string; summary: string },
  store: EventStore,
): Effect.Effect<PrRequestAnswer, Error> =>
  requestOnPr(store, pr, (state) => summaryEditTransition(state, pr.mode, pr.project, edit))
