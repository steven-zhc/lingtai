import type { TicketSource } from '@lingtai/recipe'

/** Why a project with work items in the log cannot change its ticket source. */
export const DIFFERENT_SOURCE_CLASH = 'a different source would number its own tickets into those same streams'

/**
 * Which source holds: the file's own `source.tickets` when it says `db`, and
 * where it says nothing, `history` — a `db ticket #<n>` entry is only ever
 * written by `dbTickets.createIssue` (`liveHistory`), so it is decisive even
 * with no file at all. Otherwise `github`, `ticketSourceOf`'s own default.
 *
 * One function so `askTickets` and `proposeSetup` cannot answer differently.
 */
export function ticketSourceFrom(rawTickets: unknown, history: readonly string[]): TicketSource {
  return rawTickets === 'db' || (rawTickets === null && history.some((h) => h.startsWith('db ticket #')))
    ? 'db'
    : 'github'
}

/**
 * The live `history`: a dynamic `import('@lingtai/event-store')`, for
 * `ticket-store.ts`'s own reason — a caller that only wants to ask a setup
 * question must not open a store merely by importing this module.
 *
 * **Two kinds of history, not one.** A `ticket-<project>-*` stream is what a
 * claimed ticket leaves in the log, whichever source claimed it. A `db`
 * project's own tickets leave no stream until a pass claims one —
 * `dbTickets.createIssue` (`db-tickets.ts`) is a plain `INSERT INTO
 * tickets` — so `lingtai ticket new` can leave a project with rows in
 * `tickets` and nothing in the log at all. `ticketsFor`'s own guard
 * (`ticket-store.ts:247-253`) checks the table before the log for exactly
 * that reason, and this checks both for the same one: either is enough that
 * switching away from the project's current source would strand work.
 */
export async function liveHistory(project: string): Promise<readonly string[]> {
  const { log, processTicketSql } = await import('@lingtai/event-store')
  const { parseTicketStream, ticketStreamsOf } = await import('@lingtai/domain')
  const { dbTickets } = await import('@lingtai/conductor/db-tickets')
  const streams = await log.queries.projectStreams(ticketStreamsOf(project))
  const wiStreams = streams.filter((id) => parseTicketStream(id)?.project === project)
  const sql = await processTicketSql()
  const dbTicketRows = await dbTickets(sql, project).listIssuesSince(new Date(0))
  return [...wiStreams, ...dbTicketRows.map((t) => `db ticket #${t.number}`)]
}
