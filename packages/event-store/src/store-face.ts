/**
 * The promise `EventStore` as a face over `Events` (0101 §7, #1020).
 *
 * Each face is one `Effect.runPromise` over one `Events` method and nothing
 * else — the shape `effect-ratchet.faces.json` lists, so a run that is only a
 * face goes uncounted. On Effect 4 `runPromise` rejects with the squashed
 * cause: the `Fail`'s error itself, else the `Die`'s defect itself. A face over
 * `append` therefore rejects with the very `ConcurrencyError` the Effect failed
 * with, and with the same `RangeError` or driver error as a defect.
 *
 * **A moved caller is never handed `fromPromiseStore(eventStore)`.** That is
 * Effect → face → Effect, and the face's run starts a root fiber that drops the
 * caller's span and interruption. Production code takes `eventsLayer`;
 * `fromPromiseStore` is for the memory store and for test fakes.
 */
import type { Envelope, EventType, ToAppend } from '@lingtai/domain'
import { Effect } from 'effect'

import { ConcurrencyError, type EventStore, type EventsPort } from './event-store.ts'

export function appendFace(events: EventsPort, streamId: string, expectedVersion: number, batch: readonly ToAppend[]) {
  return Effect.runPromise(events.append(streamId, expectedVersion, batch))
}

export function readFace(events: EventsPort, streamId: string, fromVersion?: number) {
  return Effect.runPromise(events.read(streamId, fromVersion))
}

export function headFace(events: EventsPort, streamId: string) {
  return Effect.runPromise(events.head(streamId))
}

export function readTypesFace(events: EventsPort, streamId: string, types: readonly EventType[], fromVersion?: number) {
  return Effect.runPromise(events.readTypes(streamId, types, fromVersion))
}

export function readAllFace(events: EventsPort, fromSeq: bigint, limit: number) {
  return Effect.runPromise(events.readAll(fromSeq, limit))
}

/** The promise `EventStore` every caller and test fake holds, over `events`. */
export function promiseStore(events: EventsPort): EventStore {
  return {
    append: (streamId, expectedVersion, batch) => appendFace(events, streamId, expectedVersion, batch),
    read: (streamId, fromVersion) => readFace(events, streamId, fromVersion),
    head: (streamId) => headFace(events, streamId),
    readTypes: (streamId, types, fromVersion) => readTypesFace(events, streamId, types, fromVersion),
    readAll: (fromSeq, limit) => readAllFace(events, fromSeq, limit),
  }
}

/**
 * A promise store as `Events`: a `ConcurrencyError` is the failure and anything
 * else a defect. For the memory store and fakes, never for `eventStore`.
 */
export function fromPromiseStore(store: EventStore): EventsPort {
  return {
    append: (streamId, expectedVersion, batch) =>
      Effect.flatten(
        Effect.promise(() =>
          store.append(streamId, expectedVersion, batch).then(
            (written): Effect.Effect<Envelope[], ConcurrencyError> => Effect.succeed(written),
            (err): Effect.Effect<Envelope[], ConcurrencyError> => {
              if (err instanceof ConcurrencyError) return Effect.fail(err)
              throw err
            },
          ),
        ),
      ),
    read: (streamId, fromVersion) => Effect.promise(() => store.read(streamId, fromVersion)),
    head: (streamId) => Effect.promise(() => store.head(streamId)),
    readTypes: (streamId, types, fromVersion) => Effect.promise(() => store.readTypes(streamId, types, fromVersion)),
    readAll: (fromSeq, limit) => Effect.promise(() => store.readAll(fromSeq, limit)),
  }
}
