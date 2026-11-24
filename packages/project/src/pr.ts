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
  teamSince,
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
  summaryWrittenTransition,
  summaryNotWrittenTransition,
  descriptionPushedTransition,
  summaryEditTransition,
  ticketStream,
  integrationStream,
} from '@lingtai/domain'
import { ConcurrencyError, type EventStore, type StreamBatch } from '@lingtai/event-store/store'
import { type Recipe, modeOf } from '@lingtai/recipe'
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
  return listPrs(project, store).pipe(
    Effect.map((prs) => {
      const top = prs[prs.length - 1]
      return top !== undefined && top.status === 'draft' ? top.draft : []
    }),
  )
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
export const recordPrRefused = (project: string, n: number, refusal: PayloadOf<'PrSubmitRefused'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => refuseTransition(state, refusal),
    (_state, appended) => appended,
  )

/** The freeze: In progress, with the branch's commit and the tickets it holds. */
export const recordPrInProgress = (
  project: string,
  n: number,
  frozen: Parameters<typeof freezeTransition>[1],
  store: EventStore,
) =>
  transitionPr(
    store,
    project,
    n,
    (state) => freezeTransition(state, frozen),
    (_state, appended) => appended,
  )

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

/** The PR was found merged. A PR already merged or closed appends nothing. */
export const recordPrMerged = (project: string, n: number, merged: PayloadOf<'PrMerged'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => mergedTransition(state, merged),
    (_state, appended) => appended,
  )

/** The PR was found closed without merging; it holds no tickets from here on. */
export const recordPrClosed = (project: string, n: number, closed: PayloadOf<'PrClosed'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => closedTransition(state, closed),
    (_state, appended) => appended,
  )

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
 * **The draft**: the project's tickets landed on `branch.personal` since it became a team project and held by no PR
 * that is still going. Empty in solo mode.
 *
 * `candidates` are handed in — the board's cards with a window that covers every landed row, **never the board's
 * two-day default**, which would lose every ticket landed longer ago — and each is decided from its own stream's
 * reduce (0129 §6). A ticket a person closed after it landed counts (0130 §4). A failed read fails the whole read:
 * it is never *no tickets*.
 */
export function readPrDraft(
  project: string,
  recipe: Recipe,
  candidates: readonly { readonly issue: string }[],
  store: EventStore,
  prs?: readonly PrState[],
): Effect.Effect<PrDraftTicket[], Error> {
  return Effect.gen(function* () {
    if (modeOf(recipe) !== 'team') return []
    return yield* readDraftOn(project, recipe.branch.personal ?? recipe.branch.main, candidates, store, prs)
  })
}

/** The most times `backfillDraft` reads and decides again after the stream moved under it. */
const BACKFILL_ATTEMPTS = 3

/**
 * **Temporary** (#1394): writes onto the draft's stream each ticket the computed draft holds and the stream lacks, and
 * returns how many it appended. Those tickets landed before any landing wrote `PrDraftTicketAdded`. It is the last
 * caller of the computed draft (`readPrDraft`) and goes with it; keep it in one function with one call site.
 *
 * The PR streams are read once per attempt and the list serves both `wanted` and the target. One `append`, at the
 * version read: all of a project's tickets or none. A `ConcurrencyError` reads again and decides again, up to three
 * times, then fails. A failed read fails the backfill, never "an empty draft". Solo projects append nothing.
 *
 * `candidates` come from the board's projection, which may lag at a start: a ticket landed and not yet projected is
 * missing from `wanted`, so it is only ever under-added, and the next start picks it up.
 */
export function backfillDraft(
  project: string,
  recipe: Recipe,
  candidates: readonly { readonly issue: string }[],
  store: EventStore,
): Effect.Effect<number, Error> {
  const once = Effect.gen(function* () {
    if (modeOf(recipe) !== 'team') return 0
    const prs = yield* listPrs(project, store)
    const wanted = yield* readPrDraft(project, recipe, candidates, store, prs)
    const target = draftOf(prs)
    const top = prs[prs.length - 1]
    const state = target.state === null || top === undefined ? emptyPr : top
    const have = new Set((target.state === null || top === undefined ? [] : top.draft).map((t) => t.ticket))
    const events: NonNullable<ReturnType<typeof addDraftTicket>>[] = []
    for (const t of wanted) {
      if (have.has(t.ticket)) continue
      const event = addDraftTicket(state, { ticket: t.ticket, mergeCommit: t.mergeCommit, from: null })
      if (event === null)
        return yield* Effect.die(new Error(`the draft of ${project} refused a ticket in ${state.status}`))
      events.push(event)
    }
    if (events.length === 0) return 0
    yield* Effect.tryPromise({
      try: () => store.append(prStream(project, target.n), target.version, events),
      catch: (err) => err,
    }).pipe(Effect.mapError((err) => (err instanceof ConcurrencyError ? err : failed(err))))
    return events.length
  })
  const attempt = (left: number): Effect.Effect<number, Error> =>
    once.pipe(
      Effect.catchIf(
        (err): err is ConcurrencyError => err instanceof ConcurrencyError && left > 1,
        () => attempt(left - 1),
      ),
    )
  return attempt(BACKFILL_ATTEMPTS)
}

/** The draft against a named personal branch: `readPrDraft` without the recipe, for a caller that holds only text. */
export function readDraftOn(
  project: string,
  personal: string,
  candidates: readonly { readonly issue: string }[],
  store: EventStore,
  /** The PRs, where the caller has read them already: the stream is then not read a second time, and a caller whose read of one failed does not pass any. */
  prs?: readonly PrState[],
): Effect.Effect<PrDraftTicket[], Error> {
  return Effect.gen(function* () {
    const since = teamSince(yield* readProjectEvents(project, store), isTeamSource)

    const held = new Set<string>()
    // A pr-fix the PR held when a merge back carried it, and whose PR then closed unmerged: its code is on the
    // personal branch, so it is a draft ticket like the PR's own. Per ticket, never per branch (#1341): a later fix on
    // the branch, or one the PR was never told of, is not on the personal branch.
    const mergedBack = new Map<string, string>()
    for (const pr of prs ?? (yield* listPrs(project, store))) {
      if (pr.status === 'closed') {
        if (pr.prBranch !== null) for (const t of pr.mergedBackTickets) mergedBack.set(t, pr.prBranch)
        continue
      }
      if (pr.status === 'refused') continue
      for (const t of pr.tickets) held.add(t.ticket)
    }

    const landedAtTime = new Map<string, number>()
    const draft: PrDraftTicket[] = []
    for (const { issue } of candidates) {
      if (held.has(issue)) continue
      const events = yield* Effect.tryPromise({ try: () => store.read(ticketStream(project, issue)), catch: failed })
      const state = reduceTicket(events)
      if (state.landed === null) continue
      const onBase = state.landed.base
      if (onBase !== personal && mergedBack.get(issue) !== onBase) continue
      const landedAt = landedSeq(events, onBase)
      if (landedAt === null || landedAt <= since) continue
      const landing = events.find((e) => e.seq === landedAt)
      landedAtTime.set(issue, landing === undefined ? 0 : landing.at.getTime())
      draft.push({ ticket: issue, mergeCommit: state.landed.mergeCommit, title: state.title ?? `#${issue}` })
    }
    // In the order they landed, not the order of their numbers; a tie keeps the candidates' order.
    return draft.sort((a, b) => (landedAtTime.get(a.ticket) ?? 0) - (landedAtTime.get(b.ticket) ?? 0))
  })
}

/**
 * The pr-fix landings on an open PR's branch that the PR does not hold (#1341): tickets whose latest landing is on
 * `prBranch` and are not among the PR's tickets, so a process that died between `TicketLanded` and `PrFixLanded` is
 * mended on the next sweep. A PR's branch is named for it alone, so nothing landed there is anything but its fix.
 */
export function readUnheldFixLandings(
  project: string,
  pr: PrState,
  candidates: readonly { readonly issue: string }[],
  store: EventStore,
): Effect.Effect<PayloadOf<'PrFixLanded'>[], Error> {
  return Effect.gen(function* () {
    const unheld: PayloadOf<'PrFixLanded'>[] = []
    const order = new Map<string, bigint>()
    if (pr.prBranch === null) return unheld
    for (const { issue } of candidates) {
      if (pr.tickets.some((t) => t.ticket === issue)) continue
      const events = yield* Effect.tryPromise({ try: () => store.read(ticketStream(project, issue)), catch: failed })
      const state = reduceTicket(events)
      if (state.landed === null || state.landed.base !== pr.prBranch) continue
      const landedAt = landedSeq(events, pr.prBranch)
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

/** A back was served: the PR is closed, with or without a pull request on a code host to close. */
export const recordPrTakenBack = (project: string, n: number, closed: PayloadOf<'PrClosed'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => backClosedTransition(state, closed),
    (_state, appended) => appended,
  )

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
