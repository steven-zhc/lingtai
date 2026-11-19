/**
 * **The daemon carries out the split triage decided** (0118 §12, #1262).
 *
 * The decision is `SplitStarted`, appended by `actOnTriageTransition` in the same append as `WaitTriaged`. This
 * module is what happens next: a live `SplitStarted` wakes the writer, and at the daemon's start and after every
 * pass `catchUpSplits` finds a split that was started and never finished — one whose writer died with the process
 * that held it, and one that failed partway.
 *
 * **A failed split is retried at most once per `source.backoff`, measured from the `SplitFailed` on the log** rather
 * than from this process's own memory, so a daemon that restarts in a loop cannot hammer a GitHub that keeps refusing.
 * The clock is Effect's, so a test drives it with `TestClock`.
 */
import { reduceTicket, splitLastOf, ticketStream, type Envelope, type PayloadOf, type WaitId } from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import type { TaskCard } from '@lingtai/projector'
import { Clock, Effect } from 'effect'

export interface SplitRequest {
  project: string
  issue: number
  ticketId: string
  waitId: WaitId
  /** This daemon's start id: what the writer records on its `SplitStarted`. */
  instance: string
}

export interface SplitPorts {
  store: Pick<EventStore, 'read'>
  readTasks(project: string): Effect.Effect<Pick<TaskCard, 'issue' | 'state'>[], unknown>
  /** This daemon's start id. */
  instance(): Effect.Effect<string, unknown>
  /** The writer: reads the frozen plan off the log and reconciles it against GitHub. Never takes a plan of its own. */
  write(request: SplitRequest): Effect.Effect<unknown, unknown>
  /** The recipe's `source.backoff`, in milliseconds. */
  backoffMs(project: string): Effect.Effect<number, unknown>
  /** The waits a writer is running for in this process; a second one is never started beside it. */
  running: Set<string>
  log?: (line: string) => void
  /** A sentence while the project is locked (0126 §5); absent means no lock. */
  locked?: (project: string) => Effect.Effect<string | null, unknown>
}

/** What a ticket's log says about the split of the wait it is held on. */
export type SplitStanding =
  | { _tag: 'None' }
  | { _tag: 'Interrupted'; waitId: WaitId }
  | { _tag: 'Failed'; waitId: WaitId; at: Date }

/** Pure: is there a started split on the wait this ticket is blocked on, and how did the last attempt end? */
export function splitStandingOf(events: readonly Envelope[]): SplitStanding {
  const life = reduceTicket(events).lifecycle
  if (life.status !== 'blocked') return { _tag: 'None' }
  const waitId = life.waitId
  const last = splitLastOf(events, waitId)
  if (last._tag === 'failed') return { _tag: 'Failed', waitId, at: last.at }
  return last._tag === 'started' ? { _tag: 'Interrupted', waitId } : { _tag: 'None' }
}

const guarded = (deps: SplitPorts, request: SplitRequest): Effect.Effect<void> =>
  deps.write(request).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.sync(() => deps.log?.(`split ${request.waitId} on ${request.ticketId}: ${String(cause)}`)),
    ),
    Effect.ensuring(Effect.sync(() => deps.running.delete(request.waitId))),
  )

/** Run one split here and wait for it; a wait already being written in this process is left to its writer. */
export const runSplit = (deps: SplitPorts, request: SplitRequest): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (deps.running.has(request.waitId)) return Effect.void
    deps.running.add(request.waitId)
    return guarded(deps, request)
  })

/**
 * Start one split in the background and return at once: a writer runs an agent-priced number of GitHub calls, and a
 * handler that has not settled in `SUBSCRIBER_TIMEOUT_MS` is reported as a failure. The wait is marked running before
 * the fork, so two looks in a row never start two writers.
 */
export const startSplit = (deps: SplitPorts, request: SplitRequest): Effect.Effect<void> =>
  Effect.suspend(() => {
    if (deps.running.has(request.waitId)) return Effect.void
    deps.running.add(request.waitId)
    return Effect.forkDetach(guarded(deps, request)).pipe(Effect.asVoid)
  })

/**
 * A `SplitStarted` the decision just appended. Only this daemon's own start is run live; another instance's
 * (a board still on old code) is the catch-up's, which finds it if its writer is gone.
 */
export const onSplitStarted = (event: Envelope, deps: SplitPorts): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (event.type !== 'SplitStarted') return
    const data = event.data as PayloadOf<'SplitStarted'>
    const ours = yield* deps.instance()
    if (data.instance !== ours) return
    const parsed = parseStream(event.streamId)
    if (parsed === null) return
    const held = yield* (deps.locked ?? notLocked)(parsed.project)
    // A held project is left to the catch-up, which runs when the hold lifts.
    if (held !== null) return
    yield* startSplit(deps, { ...parsed, ticketId: event.streamId, waitId: data.waitId, instance: ours })
  })

const notLocked = () => Effect.succeed(null)

function parseStream(ticketId: string): { project: string; issue: number } | null {
  const m = /^ticket-(.+)-(\d+)$/.exec(ticketId)
  return m === null ? null : { project: m[1]!, issue: Number(m[2]) }
}

/**
 * Every split of `project` that was started and not finished, and is due. An interrupted one is due at once (its
 * writer is gone, or this would not be a catch-up); a failed one only once `source.backoff` has passed since its
 * `SplitFailed`. Answers how many it started.
 */
export const catchUpSplits = (project: string, deps: SplitPorts): Effect.Effect<number, unknown> =>
  Effect.gen(function* () {
    const instance = yield* deps.instance()
    const backoff = yield* deps.backoffMs(project)
    let started = 0
    for (const card of yield* deps.readTasks(project)) {
      if (card.state !== 'waiting') continue
      const ticketId = ticketStream(project, card.issue)
      const standing = splitStandingOf(yield* Effect.tryPromise(() => deps.store.read(ticketId)))
      if (standing._tag === 'None' || deps.running.has(standing.waitId)) continue
      if (standing._tag === 'Failed' && (yield* Clock.currentTimeMillis) - standing.at.getTime() < backoff) continue
      started++
      yield* startSplit(deps, { project, issue: Number(card.issue), ticketId, waitId: standing.waitId, instance })
    }
    return started
  })

/** `catchUpSplits` over every registered project that is not locked; one failed project never stops the rest. */
export const catchUpRegisteredSplits = (
  projects: readonly { project: string | null }[],
  deps: SplitPorts,
  log: (line: string) => void,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const registered of projects) {
      if (registered.project === null) continue
      const name = registered.project
      yield* Effect.gen(function* () {
        if ((yield* (deps.locked ?? notLocked)(name)) !== null) return
        yield* catchUpSplits(name, deps)
      }).pipe(Effect.catchCause((cause) => Effect.sync(() => log(`split catch-up ${name}: ${String(cause)}`))))
    }
  })
