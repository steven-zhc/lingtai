import { withProjectionStore } from './choose.ts'
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
export function readLanded(options: ReadLandedOptions): Promise<TicketReportRow[]> {
  const { url, ...query } = options
  return withProjectionStore({ url, max: 1 }, (store) => store.landed(query))
}
