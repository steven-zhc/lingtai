/**
 * The snapshot read, once and generic (0124, #873): the latest usable snapshot
 * of a stream plus the tail after it, reduced to the state *before* any
 * evaluation at a clock. Returns an `Effect` so that a caller decides where it
 * runs.
 *
 * **Snapshots belong to the store's own log.** This reads only the `snapshots`
 * it was handed; with none it reduces the whole stream from `reducer.initial`.
 * Which caller gets which snapshots is the caller's decision.
 *
 * With `'all'` in place of a type list it reads every event (`store.read`): a reducer whose `version` and
 * `lastSeq` follow the stream's head must not be fed a filtered tail.
 *
 * A failed `latest` or `decode` is logged once and reduces from version 1. Only
 * a failed event read reaches the error channel, as the store's own rejection.
 *
 * No `Effect.run*` and no `async` here: `effect-ratchet.test.ts` counts both.
 */
import { crossesCommitBoundary, type Envelope, type EventType, type Reducer, reduceFrom } from '@lingtai/domain'
import { Effect } from 'effect'

import type { EventStore } from './event-store.ts'
import type { Snapshot, SnapshotStore } from './snapshots.ts'

/**
 * What a caller may watch of one read (#1144). Each hook only wraps work the
 * read does anyway, and none changes what it returns. `read` wraps one store
 * call (`latest`, the `tail`, the anchor's `recheck`, a `full` re-read), `reduce`
 * the fold, and `served` says whether a snapshot answered: true only when one
 * was used and its anchor still held, false when the whole stream was read.
 */
export interface SnapshotReadObserver {
  readonly read: <A>(step: 'latest' | 'tail' | 'recheck' | 'full', run: () => Promise<A>) => Promise<A>
  readonly reduce: <A>(run: () => A) => A
  readonly served: (snapshot: boolean) => void
}

export interface SnapshotReadOptions {
  readonly snapshots?: SnapshotStore
  readonly writer?: { offer(snapshot: Snapshot): void }
  readonly observe?: SnapshotReadObserver
}

const said = new Set<string>()
function sayOnce(reducer: string, kind: 'latest' | 'decode', e: unknown): void {
  const flag = `${reducer}:${kind}`
  if (said.has(flag)) return
  said.add(flag)
  console.error(`${reducer} snapshot ${kind} failed, reducing from version 1: ${String(e)}`)
}

const attempt = <A>(f: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: () => f(), catch: (e) => e })

export function readThroughSnapshot<S>(
  store: Pick<EventStore, 'readTypes' | 'read'>,
  reducer: Reducer<S>,
  streamId: string,
  types: readonly EventType[] | 'all',
  options: SnapshotReadOptions = {},
): Effect.Effect<S, unknown> {
  const { snapshots, writer, observe } = options
  const step = <A>(name: 'latest' | 'tail' | 'recheck' | 'full', run: () => Promise<A>): (() => Promise<A>) =>
    observe === undefined ? run : () => observe.read(name, run)
  const fold = (state: S, events: Envelope[]): S =>
    observe === undefined
      ? reduceFrom(reducer, state, events)
      : observe.reduce(() => reduceFrom(reducer, state, events))
  const readFrom = (from?: number): Promise<Envelope[]> =>
    types === 'all' ? store.read(streamId, from) : store.readTypes(streamId, types, from)
  if (snapshots === undefined) {
    return attempt(step('full', () => readFrom())).pipe(
      Effect.map((all) => {
        observe?.served(false)
        return fold(reducer.initial, all)
      }),
    )
  }
  return Effect.gen(function* () {
    const key = { streamId, reducer: reducer.name, reducerVersion: reducer.version }
    const row = yield* attempt(step('latest', () => snapshots.latest(key))).pipe(
      Effect.catch((e) => {
        sayOnce(reducer.name, 'latest', e)
        return Effect.succeed(null)
      }),
    )
    let state = reducer.initial
    let start = 0
    let from = 0
    if (row !== null) {
      try {
        state = reducer.decode(row.state)
        start = row.streamVersion
        from = start
      } catch (e) {
        sayOnce(reducer.name, 'decode', e)
      }
    }
    let tail: Envelope[] = yield* attempt(step('tail', () => readFrom(start + 1)))
    let served = row !== null && start > 0
    if (row !== null && start > 0) {
      // The anchor was checked before the tail was read; a reset in between would pair the old
      // state with the new log's events. Ask again: only an anchor still holding vouches for the tail.
      const again = yield* attempt(step('recheck', () => snapshots.latest(key))).pipe(Effect.orElseSucceed(() => null))
      if (again === null || again.streamVersion !== row.streamVersion || again.lastSeq !== row.lastSeq) {
        state = reducer.initial
        from = 0
        served = false
        tail = yield* attempt(step('full', () => readFrom()))
      }
    }
    observe?.served(served)
    const reduced = fold(state, tail)
    const last = tail[tail.length - 1]
    if (last !== undefined && writer !== undefined && crossesCommitBoundary(from, last.version)) {
      writer.offer({
        ...key,
        streamVersion: last.version,
        lastSeq: last.seq,
        lastAt: last.at,
        state: reducer.encode(reduced),
      })
    }
    return reduced
  })
}
