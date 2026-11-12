import { Effect } from 'effect'

import { withStoreEffect } from './choose.ts'
import type { TicketReportLandedQuery } from './store.ts'
import type { TicketReportRow } from './ticket-report.ts'

export interface ReadLandedOptions extends TicketReportLandedQuery {
  url?: string
}

/**
 * `ticket_report`'s landed rows, newest first, one page. `/landed` reads it.
 * A `ProjectionShapeError` is the table lacking the landing columns, and it
 * names the rebuild; a database with no table is no rows.
 */
export const readLandedEffect = Effect.fn('projector.readLanded')(function* (options: ReadLandedOptions) {
  const { url, ...query } = options
  return yield* withStoreEffect({ url, max: 1 }, (p) => p.landed(query))
})

/** The promise face (0101 §7): the board reads `/landed` as a promise. */
export function readLanded(options: ReadLandedOptions): Promise<TicketReportRow[]> {
  return Effect.runPromise(readLandedEffect(options))
}
