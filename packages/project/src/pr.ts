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
  refuseTransition,
  stepDoneTransition,
  waitTransition,
  ticketStream,
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
  return readPrEvents(project, n, store).pipe(
    Effect.map((events) => (events.length === 0 ? null : reducePr(events))),
  )
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
      yield* Effect.tryPromise({ try: () => store.append(prStream(project, n), state.version, [next]), catch: (e) => e })
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

/** A step answered `done`, on the head it ran on. A step already recorded appends nothing. */
export const recordPrStepDone = (project: string, n: number, done: PayloadOf<'PrStepDone'>, store: EventStore) =>
  transitionPr(
    store,
    project,
    n,
    (state) => stepDoneTransition(state, done),
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

/** A ticket in the draft: what a PR would hold of it. */
export interface PrDraftTicket {
  readonly ticket: string
  readonly mergeCommit: string
  readonly title: string
}

/** Whether a recorded recipe text says `mode: team`. Text that does not parse is not team: it can only shrink the draft. */
function isTeamSource(source: string): boolean {
  try {
    const raw: unknown = parseYaml(source)
    return typeof raw === 'object' && raw !== null && (raw as { mode?: unknown }).mode === 'team'
  } catch {
    return false
  }
}

/**
 * The seq of the `ProjectRecipeChanged` after which the project has been team ever since, or 0 when no recorded
 * recipe says otherwise. A landing before it was a solo project's, even on a branch of the same name.
 */
export function teamSince(events: readonly Envelope[]): bigint {
  let since = 0n
  let team = false
  for (const e of events) {
    if (e.type !== 'ProjectRecipeChanged') continue
    const now = isTeamSource((e.data as PayloadOf<'ProjectRecipeChanged'>).source)
    if (now && !team) since = e.seq
    team = now
  }
  return since
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
    const personal = recipe.branch.personal ?? recipe.branch.main
    const since = teamSince(yield* readProjectEvents(project, store))

    const held = new Set<string>()
    for (const pr of yield* listPrs(project, store)) {
      if (pr.status === 'refused') continue
      for (const t of pr.tickets) held.add(t.ticket)
    }

    const draft: PrDraftTicket[] = []
    for (const { issue } of candidates) {
      if (held.has(issue)) continue
      const events = yield* Effect.tryPromise({ try: () => store.read(ticketStream(project, issue)), catch: failed })
      const state = reduceTicket(events)
      if (state.landed === null || state.landed.base !== personal) continue
      const landedAt = events
        .filter((e) => e.type === 'TicketLanded' && (e.data as PayloadOf<'TicketLanded'>).base === personal)
        .reduce<bigint | null>((_last, e) => e.seq, null)
      if (landedAt === null || landedAt <= since) continue
      draft.push({ ticket: issue, mergeCommit: state.landed.mergeCommit, title: state.title ?? `#${issue}` })
    }
    return draft
  })
}

