/**
 * A reducer that may be snapshotted (0124 §1, #867): a name, a version, a start,
 * a step, and a codec for its state. The whole-history reducer is `reduceAll`,
 * so the fold exists once.
 */
import type { Envelope } from './envelope.ts'

export interface Reducer<S> {
  /** The key the reducer is registered under. */
  readonly name: string
  /** Raised whenever the result over `reducer-versions.json`'s fixture changes (0124 §3). */
  readonly version: number
  readonly initial: S
  reduceEvent(state: S, envelope: Envelope): S
  encode(state: S): string
  /** A string (SQLite) or a parsed value (Postgres `jsonb`). Throws on any other shape. */
  decode(stored: unknown): S
}

/** `events.reduce(reduceEvent, initial)`, without handing the step the index and the array. */
export function reduceAll<S>(reducer: Reducer<S>, events: readonly Envelope[]): S {
  return events.reduce((state, e) => reducer.reduceEvent(state, e), reducer.initial)
}
