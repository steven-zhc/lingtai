/**
 * The subscriber: what makes this system event-driven rather than timed.
 *
 * With it, `interval` never has to exist as a configuration value — the
 * conductor and the board wake on an append instead of on a clock.
 *
 * `follow` is the loop, an Effect: it reads through `EventsPort` and is woken by
 * `WakerPort`, and it lives in the scope of whoever forks it, so closing that
 * scope stops it once the batch in flight has committed. `subscribe` is the
 * promise face over it. It reads through an `EventStore` and is woken by a
 * `Waker`, and constructs neither (#177): Postgres's `LISTEN`/`NOTIFY` is `createPostgresWaker` in
 * `wake.ts`, and a second store brings its own.
 *
 * Two rules, and each of them is the difference between "works in a demo" and
 * "does not lose events".
 *
 * **Ready before the catch-up read, never after.** A session's `ready` means an
 * append from then on will nudge it, so an append that happens *during*
 * catch-up is announced rather than dropped into the window between "read the
 * log" and "start listening".
 *
 * **The nudge is a nudge, not the payload.** It carries nothing, so it triggers
 * a drain of everything after `lastSeq`, not a fetch of one row. That is also
 * what makes a late, coalesced, duplicated or spurious nudge harmless:
 * `lastSeq` only ever moves forward, and only after a handler returns.
 */
import type { Envelope } from '@lingtai/domain'
import { Cause, Data, Effect, Queue } from 'effect'

// Types only from the stores: this module builds neither, so it opens no
// connection at import and a test that hands it an in-memory store and waker
// needs no database.
import type { EventStore, EventsPort } from './event-store.ts'
import { followFace } from './store-face.ts'
import type { Waker, WakerPort } from './wake.ts'

interface SubscribeBase {
  /**
   * Resume point, exclusive. A checkpoint's `lastSeq`; `0n` reads the log from
   * the beginning.
   */
  fromSeq: bigint

  /** What is read after a nudge. The process-wide `eventStore` — whichever store this machine chose — outside a test. */
  store: EventStore

  /**
   * What says the log has moved. Required, and never built here: the store is
   * this package's, but how a store is woken is the store's (#177).
   */
  waker: Waker

  /** How many events to read per round trip while catching up. */
  batchSize?: number

  /**
   * A connection error is reported and then retried. A handler error is
   * reported and stops the subscription.
   */
  onError?: (error: unknown, phase: 'connection' | 'handler') => void

  /** Reconnect backoff, in milliseconds. */
  backoff?: { baseMs?: number; capMs?: number }
}

/**
 * Exactly one of these. Both are called in `seq` order and never concurrently
 * with themselves.
 *
 * If either throws, the subscription **stops** and `lastSeq` is left pointing at
 * the last event that succeeded — the failed event is retried on the next
 * attempt rather than skipped. A projection that cannot handle an event must not
 * quietly carry on without it.
 *
 * `onBatch` exists so a projection can put a whole batch and its checkpoint
 * advance inside one transaction. Per-event, a rebuild of a long history would
 * be one network round trip per row.
 */
type SubscribeHandler =
  | { onEvent: (event: Envelope) => Promise<void> | void; onBatch?: never }
  | { onBatch: (events: readonly Envelope[]) => Promise<void> | void; onEvent?: never }

export type SubscribeOptions = SubscribeBase & SubscribeHandler

export interface Subscription {
  /** The highest seq handed to `onEvent` and returned from it. */
  readonly lastSeq: bigint
  /** True once the subscription has stopped and will not reconnect. */
  readonly stopped: boolean
  /**
   * Resolves the first time the subscriber is listening *and* has drained the
   * backlog — the catch-up-to-live handoff. Rejects if it stops first.
   */
  caughtUp(): Promise<void>
  close(): Promise<void>
}

/** A handler failed or died. Tagged so a session's end can be told from a socket drop. */
class HandlerFailed extends Data.TaggedError('HandlerFailed')<{
  readonly event: Envelope
  readonly cause: unknown
}> {}

/** What `follow` writes and `subscribe` reads: the subscription's state, handed in so a face never runs twice. */
export interface FollowCell {
  lastSeq: bigint
  stopped: boolean
  caughtUp: { resolve(): void; reject(error: unknown): void }
}

interface FollowBase {
  fromSeq: bigint
  events: EventsPort
  waker: WakerPort
  batchSize?: number
  onError?: (error: unknown, phase: 'connection' | 'handler') => void
  backoff?: { baseMs?: number; capMs?: number }
}

/** As `SubscribeHandler`, with Effects. A failure or a defect stops the subscription. */
type FollowHandler =
  | { onEvent: (event: Envelope) => Effect.Effect<void, unknown>; onBatch?: never }
  | { onBatch: (events: readonly Envelope[]) => Effect.Effect<void, unknown>; onEvent?: never }

export type FollowOptions = FollowBase & FollowHandler

/**
 * Runs the handler where it is called. A failure **or a defect** is the
 * handler's and stops the subscription (the projector's reducers die by
 * design); an interruption is not a failure and passes through untouched.
 * This is the only `catchCause`: a session's end is never classified with one.
 */
function guarded(event: Envelope, handler: Effect.Effect<void, unknown>): Effect.Effect<void, HandlerFailed> {
  return handler.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new HandlerFailed({ event, cause: Cause.squash(cause) })),
    ),
  )
}

/**
 * Follows the log until a handler fails, reconnecting with backoff when a
 * session dies. Interrupting it stops it once the batch in flight has committed.
 */
export function follow(options: FollowOptions, cell: FollowCell): Effect.Effect<void> {
  const batchSize = options.batchSize ?? 500
  const baseMs = options.backoff?.baseMs ?? 100
  const capMs = options.backoff?.capMs ?? 10_000

  /**
   * One batch: the handler, then the advance, uninterruptible together. An
   * interrupted batch that had advanced first would skip an event for good.
   */
  const apply = (batch: readonly Envelope[]): Effect.Effect<void, HandlerFailed> => {
    if (options.onBatch) {
      const handler = options.onBatch
      return Effect.uninterruptible(
        // Before the advance: the whole batch is retried rather than any of it skipped.
        guarded(batch[0]!, handler(batch)).pipe(
          Effect.andThen(
            Effect.sync(() => {
              cell.lastSeq = batch[batch.length - 1]!.seq
            }),
          ),
        ),
      )
    }
    const handler = options.onEvent
    return Effect.forEach(
      batch,
      (event) =>
        Effect.uninterruptible(
          guarded(event, handler(event)).pipe(
            Effect.andThen(
              Effect.sync(() => {
                cell.lastSeq = event.seq
              }),
            ),
          ),
        ),
      { discard: true },
    )
  }

  /** Reads after `lastSeq` until a short batch. Runs on the loop's fiber, never beside it. */
  const drain: Effect.Effect<void, HandlerFailed> = Effect.gen(function* () {
    for (;;) {
      const batch = yield* options.events.readAll(cell.lastSeq, batchSize)
      if (batch.length > 0) yield* apply(batch)
      if (batch.length < batchSize) return
    }
  }).pipe(Effect.withSpan('Subscription.drain'))

  /** One connection's life. `served` says whether it got as far as listening and draining. */
  const session = (served: { value: boolean }): Effect.Effect<void, HandlerFailed> =>
    Effect.scoped(
      Effect.gen(function* () {
        // Before the session opens, so a nudge during catch-up is kept.
        const nudges = yield* Queue.sliding<void>(1)
        // Ready before the catch-up read, always: `open` returns once it is.
        const { lost } = yield* options.waker.open(() => {
          Queue.offerUnsafe(nudges, undefined)
        })
        yield* drain
        served.value = true
        cell.caughtUp.resolve()
        // `raceFirst`, not `race`: a handler failing in the nudge loop must end
        // this, and `race` would wait for `lost`.
        yield* Effect.raceFirst(lost, Effect.forever(Queue.take(nudges).pipe(Effect.andThen(drain))))
      }),
    ).pipe(Effect.withSpan('Subscription.session'))

  /** Exponential with jitter, so a database restart is not met by a thundering herd. */
  const backoffMs = (attempt: number): number => {
    const flat = Math.min(capMs, baseMs * 2 ** attempt)
    return flat * (0.8 + Math.random() * 0.4)
  }

  const loop = Effect.gen(function* () {
    let attempt = 0
    for (;;) {
      const served = { value: false }
      const outcome = yield* session(served).pipe(
        Effect.as('reconnect' as const),
        Effect.catchTag('HandlerFailed', (failed) =>
          Effect.sync(() => options.onError?.(failed.cause, 'handler')).pipe(Effect.as('stop' as const)),
        ),
        Effect.catchDefect((defect) =>
          Effect.sync(() => options.onError?.(defect, 'connection')).pipe(Effect.as('reconnect' as const)),
        ),
      )
      if (outcome === 'stop') return
      attempt = served.value ? 0 : attempt + 1
      yield* Effect.sleep(backoffMs(attempt))
    }
  })

  return loop.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        cell.stopped = true
        cell.caughtUp.reject(new Error('subscription stopped before it caught up'))
      }),
    ),
  )
}

export function subscribe(options: SubscribeOptions): Subscription {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const caughtUp = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Nothing awaits `caughtUp()` in the common case, and an unobserved rejection
  // takes the process down under Node's default handler.
  caughtUp.catch(() => {})

  const cell: FollowCell = { lastSeq: options.fromSeq, stopped: false, caughtUp: { resolve, reject } }
  const abort = new AbortController()
  // Caught where it starts: an abort rejects the run, and so does a throwing
  // `onError`, and neither may go unhandled before any `close()`.
  const running = followFace(options, cell, abort.signal).then(undefined, () => {})

  return {
    get lastSeq() {
      return cell.lastSeq
    },
    get stopped() {
      return cell.stopped
    },
    caughtUp: () => caughtUp,
    close() {
      abort.abort()
      return running
    },
  }
}
