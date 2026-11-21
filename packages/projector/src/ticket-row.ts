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
  encodeRun,
  encodeTicket,
  reduceAttemptEvent,
  reduceTicketEvent,
  RunCodecError,
  TicketCodecError,
} from '@lingtai/domain'
import { Cause, Effect, Exit } from 'effect'

import type { ProjectionContextPort, ProjectionLog } from './store.ts'

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

/** One table a projection keeps a stored state in, for the backfill (#1349). */
export interface StateTable {
  table: string
  /** The primary key column, which is also the stream the state was reduced from. */
  key: string
  column: string
  shape: 'ticket' | 'run'
}

/**
 * One page of the backfill (#1349): up to `limit` rows after `after`, each whose stored state does not decode
 * re-reduced from its stream below `beforeSeq` and written back, only that column. `next` is the cursor to
 * pass back (`<table index>:<last key>`), or null when every table has been scanned. A row whose stream
 * cannot be read, or has nothing below `beforeSeq`, is said (`log.note`) and left as it is.
 *
 * The caller holds the projection's lane, so no batch commits between the read and the write.
 */
export function backfillStateRows(
  tables: readonly StateTable[],
  projection: string,
  ctx: ProjectionContextPort,
  log: ProjectionLog,
  beforeSeq: bigint,
  after: string | null,
  limit: number,
): Effect.Effect<{ rewritten: number; next: string | null }> {
  return Effect.gen(function* () {
    const cursor = after ?? '0:'
    const colon = cursor.indexOf(':')
    const index = Number(cursor.slice(0, colon))
    const from = cursor.slice(colon + 1)
    const t = tables[index]
    if (t === undefined) return { rewritten: 0, next: null }
    const rows = yield* ctx.query<Record<string, unknown>>(
      `select ${t.key} as k, ${t.column} as v from ${t.table} where ${t.key} > $1 order by ${t.key} limit $2`,
      [from, limit],
    )
    // The re-reduce's own per-row line is not said: a version bump would print one for every closed ticket.
    const quiet: ProjectionLog = { read: (s) => log.read(s), note: () => {} }
    let rewritten = 0
    for (const row of rows) {
      const stream = String(row.k)
      const empty: unknown = t.shape === 'ticket' ? emptyTicket : emptyAttempt
      const reduced: Effect.Effect<{ state: unknown; reReduced: boolean; encoded: unknown }> =
        t.shape === 'ticket'
          ? Effect.map(ticketBefore(row.v, stream, beforeSeq, projection, quiet), (r) => ({
              ...r,
              encoded: encodeTicket(r.state),
            }))
          : Effect.map(runBefore(row.v, stream, beforeSeq, projection, quiet), (r) => ({
              ...r,
              encoded: encodeRun(r.state),
            }))
      const exit = yield* Effect.exit(reduced)
      if (Exit.isFailure(exit)) {
        log.note(`${projection}: could not re-reduce ${stream} from the log, left as it was: ${causeText(exit.cause)}`)
        continue
      }
      if (!exit.value.reReduced) continue
      if (exit.value.state === empty) {
        log.note(`${projection}: ${stream} has no events below the checkpoint, left as it was`)
        continue
      }
      yield* ctx.query(`update ${t.table} set ${t.column} = $1::jsonb where ${t.key} = $2`, [
        exit.value.encoded,
        stream,
      ])
      rewritten += 1
    }
    const last = rows.at(-1)
    if (rows.length === limit && last !== undefined) return { rewritten, next: `${index}:${String(last.k)}` }
    return { rewritten, next: index + 1 < tables.length ? `${index + 1}:` : null }
  })
}

const causeText = (cause: Cause.Cause<unknown>): string => {
  const e = Cause.squash(cause)
  return e instanceof Error ? e.message : String(e)
}
