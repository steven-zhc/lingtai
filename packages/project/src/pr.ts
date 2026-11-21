/**
 * The PR's commands and reads: every append to `pr-{project}-{n}`, and the draft (0130 §5, 0129 §1).
 *
 * The same shape as the Project's commands beside it: read the stream, ask a pure transition (`@lingtai/domain`'s
 * `pr.ts`), append at the version read, and on a lost race re-read and ask again once. **No process store is reached
 * from here** — every function takes `store` — because the board imports this package.
 *
 * Every later PR ticket adds its commands to this file; nothing else appends to a `pr-` stream.
 */
import {
  type Envelope,
  type PayloadOf,
  type PrState,
  type ToAppend,
  prStream,
  reducePr,
  reduceTicket,
  requestSubmit,
  freezeTransition,
  landedSeq,
  landingsStarted,
  teamSince,
  refuseTransition,
  stepDoneTransition,
  pushedTransition,
  restartTransition,
  draftOpenedTransition,
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
  syncedTransition,
  syncRoundTransition,
  syncRefusalTransition,
  mergedBackTransition,
  mergeBackFailedTransition,
  ticketStream,
  integrationStream,
} from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store/store'
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
  | { kind: 'refused'; reason: 'solo' | 'open-pr'; detail: string }

/**
 * A person asks for the personal branch to be submitted. Refused `solo` and `open-pr` without appending; otherwise
 * the next number's stream gets its first event at version 0. **Two Submits at once**: both read the same latest PR
 * and append at version 0 of the same stream; the loser re-reads, finds it open and is refused `open-pr`.
 */
export const requestPrSubmit = (
  project: string,
  mode: 'solo' | 'team',
  by: string,
  store: EventStore,
): Effect.Effect<SubmitAnswer, Error> =>
  withOneRetry(
    Effect.gen(function* () {
      const previous = yield* latestPr(project, store)
      const decided = requestSubmit(previous, mode, project, by)
      if (decided.kind === 'refused') return decided
      const n = (previous?.n ?? 0) + 1
      yield* Effect.tryPromise({ try: () => store.append(prStream(project, n), 0, [decided.event]), catch: (e) => e })
      return { kind: 'requested', n } as SubmitAnswer
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

/** The PR is In review. */
export const recordPrOpened = (project: string, n: number, opened: PayloadOf<'PrOpened'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => openedTransition(state, opened),
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
    (_state, appended) => appended,
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
): Effect.Effect<PrDraftTicket[], Error> {
  return Effect.gen(function* () {
    if (modeOf(recipe) !== 'team') return []
    return yield* readDraftOn(project, recipe.branch.personal ?? recipe.branch.main, candidates, store)
  })
}

/** The draft against a named personal branch: `readPrDraft` without the recipe, for a caller that holds only text. */
export function readDraftOn(
  project: string,
  personal: string,
  candidates: readonly { readonly issue: string }[],
  store: EventStore,
): Effect.Effect<PrDraftTicket[], Error> {
  return Effect.gen(function* () {
    const since = teamSince(yield* readProjectEvents(project, store), isTeamSource)

    const held = new Set<string>()
    for (const pr of yield* listPrs(project, store)) {
      if (pr.status === 'refused' || pr.status === 'closed') continue
      for (const t of pr.tickets) held.add(t.ticket)
    }

    const landedAtTime = new Map<string, number>()
    const draft: PrDraftTicket[] = []
    for (const { issue } of candidates) {
      if (held.has(issue)) continue
      const events = yield* Effect.tryPromise({ try: () => store.read(ticketStream(project, issue)), catch: failed })
      const state = reduceTicket(events)
      if (state.landed === null || state.landed.base !== personal) continue
      const landedAt = landedSeq(events, personal)
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
  grant: { by: string; merging: 'main' | 'back'; commit: string },
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
