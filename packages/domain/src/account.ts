/**
 * The Account aggregate: `acct-{runtime}`, whether a runtime's account is at
 * its usage limit (0126 §2).
 *
 * A small stream reduced whole and never snapshotted, in the shape of
 * `ProjectState`. Nothing here reads a clock: whether `until` has passed is
 * `accountCheck`'s question, given `now`.
 */
import type { Envelope, ToAppend } from './envelope.ts'
import type { PayloadOf, RuntimeId } from './events.ts'

export type AccountLimit = {
  /**
   * When the limit is expected to end. **An invalid date is possible**: an
   * event written by hand and stored before the schema checked it reduces to a
   * `Date` that is `NaN`. `accountCheck` never lifts it (`NaN <= now` is false),
   * so a person lifts it.
   */
  until: Date
  untilFrom: PayloadOf<'AccountLimitReached'>['untilFrom']
  said: string
  /** The first `AccountLimitReached`'s time and seq, so *since when* needs no clock. */
  since: Date
  seq: bigint
}

export interface AccountState {
  /** Null until the first event; a stream can be read before it exists. */
  runtime: RuntimeId | null
  limit: AccountLimit | null
  version: number
  lastSeq: bigint | null
}

export const emptyAccount: AccountState = { runtime: null, limit: null, version: 0, lastSeq: null }

export function reduceAccountEvent(state: AccountState, event: Envelope): AccountState {
  const at = { version: event.version, lastSeq: event.seq }
  switch (event.type) {
    case 'AccountLimitReached': {
      const d = event.data as PayloadOf<'AccountLimitReached'>
      // A second one while a limit stands changes nothing: the first `since` and `until` stand.
      if (state.limit !== null) return { ...state, ...at, runtime: d.runtime }
      return {
        ...state,
        ...at,
        runtime: d.runtime,
        limit: { until: new Date(d.until), untilFrom: d.untilFrom, said: d.said, since: event.at, seq: event.seq },
      }
    }
    case 'AccountLimitLifted': {
      const d = event.data as PayloadOf<'AccountLimitLifted'>
      return { ...state, ...at, runtime: d.runtime, limit: null }
    }
    default:
      return { ...state, ...at }
  }
}

export function reduceAccount(events: readonly Envelope[]): AccountState {
  return events.reduce(reduceAccountEvent, emptyAccount)
}

/** The one place an `AccountLimitLifted` is built, so the append finder has one site to name. */
function lifted(runtime: RuntimeId, by: string | null): ToAppend<PayloadOf<'AccountLimitLifted'>> {
  const data = by === null ? { runtime } : { runtime, by }
  return { type: 'AccountLimitLifted', actor: by ?? 'conductor', data }
}

/** The event that records the wall, or null when a limit already stands (0126 §3). */
export function reachTransition(
  state: AccountState,
  runtime: RuntimeId,
  fields: Omit<PayloadOf<'AccountLimitReached'>, 'runtime'>,
): ToAppend<PayloadOf<'AccountLimitReached'>> | null {
  if (state.limit !== null) return null
  return { type: 'AccountLimitReached', actor: 'conductor', data: { runtime, ...fields } }
}

/** The event that lifts a limit a person says is over, or null when none stands. */
export function liftTransition(
  state: AccountState,
  runtime: RuntimeId,
  by: string,
): ToAppend<PayloadOf<'AccountLimitLifted'>> | null {
  if (state.limit === null) return null
  return lifted(runtime, by)
}

/** The guard's check (0126 §4): a limit whose `until` has passed is lifted. */
export function accountCheck(input: {
  state: AccountState
  runtime: RuntimeId
  now: Date
}): ToAppend<PayloadOf<'AccountLimitLifted'>>[] {
  const { state, runtime, now } = input
  if (state.limit === null || !(state.limit.until.getTime() <= now.getTime())) return []
  return [lifted(runtime, null)]
}
