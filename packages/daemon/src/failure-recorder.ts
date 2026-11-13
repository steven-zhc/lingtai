/**
 * Writes a subscriber's failure down as `PluginFailed`, one at a time (#120,
 * #123, #1069).
 *
 * `record` never fails and never dies: `deliver` is the boundary that holds a
 * subscriber's failure away from the process following the log, and a recorder
 * whose face rejected would be the unhandled rejection #120 removed.
 */
import { type Envelope, SUBSCRIBER_STREAM, parsePayload, ticketOf } from '@lingtai/domain'
import { type EventStore, type EventsPort, fromPromiseStore, processEvents } from '@lingtai/event-store'
import { Cause, Effect, Semaphore } from 'effect'

export interface FailureRecorderOptions {
  /** A promise store to record into; the process's own events when absent. */
  readonly store?: EventStore | undefined
  /** Says a line to whoever is watching. */
  readonly tell: (line: string) => void
}

export interface FailureRecorder {
  record(name: string, event: Envelope, reason: string, owner: string | undefined): Effect.Effect<void>
}

export function makeFailureRecorder(options: FailureRecorderOptions): FailureRecorder {
  const { tell } = options
  const given: EventsPort | undefined = options.store ? fromPromiseStore(options.store) : undefined
  // Resolved inside each attempt: opening the process store is itself an IO
  // that can be refused, and a refusal there counts as an attempt.
  const events: Effect.Effect<EventsPort> = given ? Effect.succeed(given) : processEvents

  /**
   * `ext-subscribers`'s version, as this process last left it.
   *
   * Held rather than re-read, because the alternative is quadratic exactly when
   * it hurts: a subscriber that fails on every event appends once per event,
   * and reading the whole stream to find its length each time would make a
   * broken notifier progressively more expensive. Null means *ask the log* —
   * which is what a conflict sets it back to.
   */
  let failuresAt: number | null = null

  /**
   * One permit per recorder, so appends are serial whatever order the failures
   * arrive in. Two `deliver` calls can fail within the same tick — every
   * subscriber and `discuss` are handed the same event — and each would
   * otherwise read the same version and race the others for it.
   */
  const permit = Semaphore.makeUnsafe(1)

  const attemptOnce = (
    attempt: number,
    name: string,
    data: { name: string; eventType: string; project: string | null; reason: string },
  ): Effect.Effect<boolean, unknown> =>
    Effect.gen(function* () {
      const port = yield* events
      failuresAt ??= (yield* port.read(SUBSCRIBER_STREAM)).length
      yield* port.append(SUBSCRIBER_STREAM, failuresAt, [
        { type: 'PluginFailed', actor: 'conductor', data: parsePayload('PluginFailed', data) },
      ])
      failuresAt += 1
      return true
    }).pipe(
      // A process store's failure is a defect, so `Effect.catch` would miss it.
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
        // Somebody else moved the stream, or the log is unreachable. Ask it
        // again; on the third refusal say so and stop, because a boundary
        // that could throw is the boundary this file exists to remove.
        failuresAt = null
        if (attempt === 2) {
          const message = (Cause.squash(cause) as Error | undefined)?.message ?? String(Cause.squash(cause))
          return Effect.sync(() => tell(`could not record ${name}'s failure: ${message}`)).pipe(Effect.as(false))
        }
        return Effect.succeed(false)
      }),
    )

  return {
    record(name, event, reason, owner) {
      // The loop, closed. A `PluginFailed` is an append like any other, so the
      // subscription hands it back to the subscribers, and a subscriber that is
      // failing on everything would fail on this one too — appending another,
      // for ever. The failure is still logged; what it does not do is write
      // itself down again.
      if (event.type === 'PluginFailed') return Effect.void

      // The subscriber's own project when it has one. Otherwise only what the
      // event names *exactly* — its `ticket-` stream or its `ticketId` — and
      // null rather than a guess: `parseTicketStream` cuts any id at its last
      // dash, so `pass-3f2a…-0123` would be recorded as project `pass-3f2a…`.
      const project = owner ?? ticketOf(event)?.project ?? null
      const data = { name, eventType: event.type, project, reason }

      const attempts = Effect.gen(function* () {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (yield* attemptOnce(attempt, name, data)) return
        }
      })

      // Nothing above can reject, and this is caught anyway: `tell` is the
      // caller's, and an unhandled rejection in this process is the whole of
      // what #120 is about.
      return Effect.uninterruptible(permit.withPermits(1)(attempts)).pipe(Effect.catchCause(() => Effect.void))
    },
  }
}
