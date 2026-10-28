import { withProjectionStore } from './choose.ts'
import type { TicketReportQuery } from './store.ts'
import type { TicketReportRow } from './ticket-report.ts'

export interface ReadTicketReportOptions extends TicketReportQuery {
  url?: string
}

/**
 * Every ticket's `ticket_report` row, or one project's. Unwindowed on purpose:
 * an open ticket is placed by its pass times, and that is `report()`'s rule.
 * A database no projector has ever started has no table, and that is no rows.
 */
export async function readTicketReport(options: ReadTicketReportOptions = {}): Promise<TicketReportRow[]> {
  return withProjectionStore({ url: options.url, max: 1 }, (store) =>
    store.ticketReport(options.project === undefined ? {} : { project: options.project }),
  )
}
