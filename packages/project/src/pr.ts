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
  projectStream,
  reduceProject,
  reducePr,
  reducePrEvent,
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
import { readProjectEvents } from './state.ts'

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
 * The highest PR number the project stream records (`ProjectPrNumbered`, ADR 0131 §1), with the stream's version from
 * the same read. Null is *none recorded*: for a reader that is no PRs, and a writer finds the number by `numberedPrs`.
 * A read that fails is the error, never *no PRs*.
 */
export const highestPr = (
  project: string,
  store: EventStore,
): Effect.Effect<{ highest: number | null; version: number }, Error> =>
  readProjectEvents(project, store).pipe(
    Effect.map((events) => {
      const state = reduceProject(events)
      return { highest: state.highestPr, version: state.version }
    }),
  )

/** PRs `1..top` as `listPrs` reads them: a stream with no events is skipped. */
const readPrsUpTo = (project: string, top: number, store: EventStore): Effect.Effect<PrState[], Error> =>
  Effect.gen(function* () {
    const prs: PrState[] = []
    for (let n = 1; n <= top; n++) {
      const pr = yield* readPr(project, n, store)
      if (pr !== null) prs.push(pr)
    }
    return prs
  })

/**
 * Every PR of a project, in number order, up to the highest the project records. **No probing**: a project that
 * records nothing has no PRs to a reader until a write records its highest (ADR 0131 §1).
 */
export function listPrs(project: string, store: EventStore): Effect.Effect<PrState[], Error> {
  return Effect.gen(function* () {
    const { highest } = yield* highestPr(project, store)
    return highest === null ? [] : yield* readPrsUpTo(project, highest, store)
  })
}

/** What a writer knows of the project's numbering: what is recorded, the stream's version, and the highest there is. */
interface Numbering {
  /** The highest the project records, null when it records none. */
  readonly recorded: number | null
  /** The project stream's version at the read, which the number's append is pinned to. */
  readonly version: number
  /** The recorded highest, or — when nothing is recorded — the highest stream found by the one walk. */
  readonly highest: number
}

/**
 * **The one place numbers are still found by `head`, and only for writers.** A project that records nothing may have
 * PRs all the same (every project before `ProjectPrNumbered`), and a writer that took *none* for *none* would start
 * again at 1 and land on a PR that exists. So it walks up once; the answer is recorded in the same write (`numberBatch`).
 */
const numberingOf = (project: string, store: EventStore): Effect.Effect<Numbering, Error> =>
  Effect.gen(function* () {
    const { highest, version } = yield* highestPr(project, store)
    if (highest !== null) return { recorded: highest, version, highest }
    let top = 0
    for (;;) {
      const head = yield* Effect.tryPromise({ try: () => store.head(prStream(project, top + 1)), catch: failed })
      if (head === 0) break
      top++
    }
    return { recorded: null, version, highest: top }
  })

/** The PRs a writer decides over, with the numbering they were read under. */
const numberedPrs = (
  project: string,
  store: EventStore,
): Effect.Effect<{ prs: PrState[]; numbering: Numbering }, Error> =>
  Effect.gen(function* () {
    const numbering = yield* numberingOf(project, store)
    return { prs: yield* readPrsUpTo(project, numbering.highest, store), numbering }
  })

/**
 * The batch that records a number, for a write that reaches PR `target`: none when the project records `target` or
 * more, else `ProjectPrNumbered` at the project stream's version, so two writers racing for a number conflict. With
 * nothing recorded it records the highest that exists even when the write targets a lower stream, or the PRs above
 * the target would vanish from every reader.
 */
const numberBatch = (project: string, target: number, numbering: Numbering): StreamBatch[] => {
  if (numbering.recorded !== null && target <= numbering.recorded) return []
  const n = Math.max(target, numbering.highest)
  return [
    {
      streamId: projectStream(project),
      expectedVersion: numbering.version,
      events: [{ type: 'ProjectPrNumbered', actor: 'conductor', data: { n } }],
    },
  ]
}

/**
 * The PRs that decide the open PR and the draft, in number order: the highest PR, and every one below it down to the
 * first not in `draft` (inclusive). `openAmong` and `draftIn` look at nothing else, so older streams are never read —
 * the cost does not grow with the project's history. The highest comes from the project's record, never a probe.
 */
const listTailPrs = (project: string, store: EventStore): Effect.Effect<PrState[], Error> =>
  Effect.gen(function* () {
    const { highest } = yield* highestPr(project, store)
    const tail: PrState[] = []
    for (let n = highest ?? 0; n >= 1; n--) {
      const pr = yield* readPr(project, n, store)
      if (pr === null) continue
      tail.push(pr)
      if (pr.status !== 'draft') break
    }
    return tail.reverse()
  })

/** The project's highest-numbered PR, or null if it never had one. */
export function latestPr(project: string, store: EventStore): Effect.Effect<PrState | null, Error> {
  return listPrs(project, store).pipe(Effect.map((prs) => prs[prs.length - 1] ?? null))
}

/** The open PR: the highest-numbered one not in `draft`, when it is open; null otherwise. */
export function openPr(project: string, store: EventStore): Effect.Effect<PrState | null, Error> {
  return listTailPrs(project, store).pipe(Effect.map(openAmong))
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
 * The batches that add a landed ticket to the draft, **not an append**: the caller writes them with the ticket's own
 * (ADR 0131 §1). The first is the stream of the highest PR *that exists* at the version it was read at (a project that
 * records nothing is walked once for it), the event the PR's own transition; a second records the number on the project
 * stream when the project has not recorded it yet. That is `draftTarget`'s stream only once the project records its
 * number: `draftTarget` is a reader and reads nothing a project has not recorded.
 * A transition that declines is a defect — the draft is never a PR in a status that refuses.
 */
export function draftBatchFor(
  project: string,
  input: { ticket: string; mergeCommit: string; from: number | null },
  store: EventStore,
): Effect.Effect<StreamBatch[], Error> {
  return Effect.gen(function* () {
    const { prs, numbering } = yield* numberedPrs(project, store)
    const target = draftOf(prs)
    const top = prs[prs.length - 1]
    const state = target.state === null || top === undefined ? emptyPr : top
    const event = addDraftTicket(state, input)
    if (event === null)
      return yield* Effect.die(new Error(`the draft of ${project} refused a ticket in ${state.status}`))
    return [
      { streamId: prStream(project, target.n), expectedVersion: target.version, events: [event] },
      ...numberBatch(project, target.n, numbering),
    ]
  })
}

/** The tickets the draft holds: the highest PR's `draft` while it is in `draft`, else none. */
export function readDraft(project: string, store: EventStore): Effect.Effect<PrState['draft'], Error> {
  return listTailPrs(project, store).pipe(Effect.map(draftIn))
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
    // The union of every draft the stream ever had: a ticket joins `draft` and `PrInProgress` empties it, so the
    // draft at the end forgets it. Read through the reducer and never by event type (`one-reducer.test.ts`).
    let state = emptyPr
    const joined = new Set<string>()
    for (const event of events) {
      state = reducePrEvent(state, event)
      for (const t of state.draft) joined.add(t.ticket)
    }
    // A pr-fix lands on the PR's branch; a successful merge back is what puts its code on `branch.personal`, whatever
    // the PR's status is now (`PrState.mergedBackTickets`).
    for (const t of state.mergedBackTickets) drafted.add(t)
    if (state.status === null || !LANDED_PR_STATUSES.has(state.status)) continue
    for (const t of joined) drafted.add(t)
  }
  return drafted
}

/** `draftedTicketsIn` over every PR of a project. A failed read is the error, never *none drafted*. */
export function readDraftedTickets(project: string, store: EventStore): Effect.Effect<ReadonlySet<string>, Error> {
  return Effect.gen(function* () {
    const { highest } = yield* highestPr(project, store)
    const numbers = Array.from({ length: highest ?? 0 }, (_, i) => i + 1)
    // At most 8 reads in flight; results come back in PR-number order, and the first failed read fails the whole.
    const streams = yield* Effect.forEach(numbers, (n) => readPrEvents(project, n, store), {
      concurrency: READ_CONCURRENCY,
    })
    return draftedTicketsIn(streams)
  })
}

/**
 * Appends `events` to PR `n`'s stream at `version`, and — in the same `appendAll` — the project's record of its numbers
 * when it has not recorded `n` (`numberBatch`): **an existing stream does not mean a recorded number**, a project from
 * before `ProjectPrNumbered` has PRs and no record, and the first write to any of them is what ends that (ADR 0131 §1).
 * A project that already records `n` appends the single event it always did. A lost race on the project stream is a
 * `ConcurrencyError`, which the caller's retry reads again.
 */
const appendOnPr = (
  store: EventStore,
  project: string,
  n: number,
  version: number,
  events: ToAppend[],
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    const numbered = numberBatch(project, n, yield* numberingOf(project, store))
    yield* Effect.tryPromise({
      try: () =>
        numbered.length === 0
          ? store.append(prStream(project, n), version, events).then(() => undefined)
          : store.appendAll([{ streamId: prStream(project, n), expectedVersion: version, events }, ...numbered]),
      catch: (e) => e,
    })
  })

/**
 * Appends one PR's transition at the head it was read at, if the transition decides anything, and records the PR's
 * number when the project has not (`appendOnPr`). The writes that can reach a new number also use `numberBatch`.
 */
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
      yield* appendOnPr(store, project, n, state.version, [next])
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
      const { prs, numbering } = yield* numberedPrs(project, store)
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
      const own = { streamId: prStream(project, target.n), expectedVersion: target.version, events: [decided.event] }
      const numbered = numberBatch(project, target.n, numbering)
      yield* Effect.tryPromise({
        // The common Submit records no number, and is the single append it always was.
        try: () =>
          numbered.length === 0
            ? store.append(own.streamId, own.expectedVersion, own.events).then(() => undefined)
            : store.appendAll([own, ...numbered]),
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
        yield* appendOnPr(store, project, n, decided.version, [next])
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
 * `appendAll`. **No retry in here, and no read of PR `n`** (only of the project's numbering): a landing between the freeze's read and its write moves
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
    // `n` or `n + 1` is a number the project may not record yet; a lost race on the project stream is a
    // `ConcurrencyError` like the others, and the caller reads and decides again.
    batches.push(...numberBatch(project, handed.length > 0 ? n + 1 : n, yield* numberingOf(project, store)))
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
      const { prs, numbering } = yield* numberedPrs(project, store)
      const state = prs.find((p) => p.n === n)
      if (state === undefined) return false
      const closed = transition(state)
      if (closed === null) return false
      const target = draftOf(prs)
      const handed = draftEvents(ticketsHandedBack(state))
      const batches: Batches = [{ streamId: prStream(project, n), expectedVersion: state.version, events: [closed] }]
      if (handed.length > 0)
        batches.push({ streamId: prStream(project, target.n), expectedVersion: target.version, events: handed })
      batches.push(...numberBatch(project, handed.length > 0 ? target.n : n, numbering))
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
      yield* appendOnPr(store, pr.project, pr.n, state?.version ?? 0, [decided.event])
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
