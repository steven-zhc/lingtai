/**
 * The ticket reduce, held in a projection's row (0124 §1, #833). Shared by every
 * projection that stores a `TicketState`: `ticket_report`, `task_view` and
 * `spend`.
 *
 * A stored row that no longer decodes is re-reduced from its own stream rather
 * than stopping the projection (#1348): the same `reduceEvent` as every other
 * fold, so there is still one.
 */
import type { AttemptState, Envelope, TicketState } from '@lingtai/domain'
import {
  decodeRun,
  decodeTicket,
  emptyAttempt,
  emptyTicket,
  reduceAttemptEvent,
  reduceTicketEvent,
  RunCodecError,
  TicketCodecError,
} from '@lingtai/domain'
import { Effect } from 'effect'

import type { ProjectionLog } from './store.ts'

/** The `(…)` part of a codec error's message: what was wrong with the stored value. */
function whatOf(error: Error): string {
  const m = /\(([^]*)\); run `/.exec(error.message)
  return m?.[1] ?? error.message
}

/**
 * The state of `stream` as of the events before `beforeSeq`: the stored value
 * decoded, or — when it is of an older shape, and only then — the stream's events
 * below `beforeSeq` reduced from `emptyTicket`. `stored === undefined` is no row.
 *
 * Anything but a `TicketCodecError` is rethrown, and a failed `log.read` is a
 * defect, so neither is skipped over. `reReduced` says the caller must write the
 * row back, or every later event pays the read again.
 */
export function ticketBefore(
  stored: unknown,
  stream: string,
  beforeSeq: bigint,
  projection: string,
  log: ProjectionLog,
): Effect.Effect<{ state: TicketState; reReduced: boolean }> {
  return Effect.gen(function* () {
    if (stored === undefined) return { state: emptyTicket, reReduced: false }
    let failure: Error
    try {
      return { state: decodeTicket(stored, projection, stream), reReduced: false }
    } catch (error) {
      if (!(error instanceof TicketCodecError)) throw error
      failure = error
    }
    const events = yield* log.read(stream)
    let state = emptyTicket
    for (const e of events) if (e.seq < beforeSeq) state = reduceTicketEvent(state, e)
    log.note(`${projection}: re-reduced ${stream} from the log (stored state was an older shape: ${whatOf(failure)})`)
    return { state, reReduced: true }
  })
}

/** `ticketBefore`'s twin for a stored `AttemptState` (`task_view_run`). */
export function runBefore(
  stored: unknown,
  stream: string,
  beforeSeq: bigint,
  projection: string,
  log: ProjectionLog,
): Effect.Effect<{ state: AttemptState; reReduced: boolean }> {
  return Effect.gen(function* () {
    if (stored === undefined) return { state: emptyAttempt, reReduced: false }
    let failure: Error
    try {
      return { state: decodeRun(stored, projection, stream), reReduced: false }
    } catch (error) {
      if (!(error instanceof RunCodecError)) throw error
      failure = error
    }
    const events = yield* log.read(stream)
    let state = emptyAttempt
    for (const e of events) if (e.seq < beforeSeq) state = reduceAttemptEvent(state, e)
    log.note(`${projection}: re-reduced ${stream} from the log (stored state was an older shape: ${whatOf(failure)})`)
    return { state, reReduced: true }
  })
}

/**
 * The stored state, or `emptyTicket` for none (`undefined`: no row yet), reduced
 * by `event`. One runner writes each projection (0100 §13), so every event is
 * reduced exactly once and no row-level replay guard is needed.
 *
 * A stored value of another shape is re-reduced from its stream (`ticketBefore`);
 * `null` is a stored value, `undefined` is none.
 */
export function reduceStoredTicket(
  stored: unknown,
  event: Envelope,
  projection: string,
  log: ProjectionLog,
): Effect.Effect<{ before: TicketState; after: TicketState }> {
  return Effect.gen(function* () {
    const { state } = yield* ticketBefore(stored, event.streamId, event.seq, projection, log)
    return { before: state, after: reduceTicketEvent(state, event) }
  })
}
