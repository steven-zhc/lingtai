import type { TicketState } from '@lingtai/domain'
import { Effect } from 'effect'

import { withStoreEffect } from './choose.ts'
import type { TicketReportQuery } from './store.ts'
import { fillStale, type TicketReportRow } from './ticket-report.ts'

export interface ReadTicketReportOptions extends TicketReportQuery {
  url?: string
  /** One ticket's state off the log, for a row stored in an older shape (#1349). Without it such a row is shown unread. */
  reread?: (ticket: string) => Effect.Effect<TicketState, unknown>
}

/**
 * Every ticket's `ticket_report` row, or one project's. Unwindowed on purpose:
 * an open ticket is placed by its pass times, and that is `report()`'s rule.
 * A database no projector has ever started has no table, and that is no rows.
 */
export const readTicketReportEffect = Effect.fn('projector.readTicketReport')(function* (
  options: ReadTicketReportOptions = {},
) {
  const rows = yield* withStoreEffect({ url: options.url, max: 1 }, (p) =>
    p.ticketReport(options.project === undefined ? {} : { project: options.project }),
  )
  return yield* fillStale(rows, options.reread)
})

/** The promise face (0101 §7). */
export function readTicketReport(options: ReadTicketReportOptions = {}): Promise<TicketReportRow[]> {
  return Effect.runPromise(readTicketReportEffect(options))
}
