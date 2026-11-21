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
  fixLandedTransition,
  fixRestartTransition,
  draftOpenedTransition,
  openedTransition,
  mergedTransition,
  closedTransition,
  waitTransition,
  syncedTransition,
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
    // A pr-fix the PR held when a merge back carried it, and whose PR then closed unmerged: its code is on the
    // personal branch, so it is a draft ticket like the PR's own. Per ticket, never per branch (#1341): a later fix on
    // the branch, or one the PR was never told of, is not on the personal branch.
    const mergedBack = new Map<string, string>()
    for (const pr of yield* listPrs(project, store)) {
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
