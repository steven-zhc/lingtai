import { Effect } from 'effect'

import { makeDbTickets } from './db-tickets.ts'

/**
 * The live `history`: a dynamic `import('@lingtai/event-store')`, for
 * `ticket-store.ts`'s own reason — a caller that only wants to ask a setup
 * question must not open a store merely by importing this module. It lives
 * here, beside `db-tickets.ts`, and not in `@lingtai/setup`: `@lingtai/conductor`
 * already depends on setup, so the other way round would be a cycle (#974).
 *
 * **Two kinds of history, not one.** A `ticket-<project>-*` stream is what a
 * claimed ticket leaves in the log, whichever source claimed it. A `db`
 * project's own tickets leave no stream until a pass claims one —
 * `dbTickets.createIssue` (`db-tickets.ts`) is a plain `INSERT INTO
 * tickets` — so `lingtai ticket new` can leave a project with rows in
 * `tickets` and nothing in the log at all. `ticketsFor`'s own guard
 * (`ticketsForEffect`, `ticket-store.ts`) checks the table before the log for exactly
 * that reason, and this checks both for the same one: either is enough that
 * switching away from the project's current source would strand work.
 */
export function liveHistoryEffect(project: string): Effect.Effect<readonly string[]> {
  return Effect.gen(function* () {
    const { log, processTicketSqlEffect } = yield* Effect.promise(() => import('@lingtai/event-store'))
    const { parseTicketStream, ticketStreamsOf } = yield* Effect.promise(() => import('@lingtai/domain'))
    const streams = yield* Effect.promise(() => log.queries.projectStreams(ticketStreamsOf(project)))
    const wiStreams = streams.filter((id) => parseTicketStream(id)?.project === project)
    const sql = yield* processTicketSqlEffect()
    const dbTicketRows = yield* makeDbTickets(sql, project).listIssuesSince(new Date(0))
    return [...wiStreams, ...dbTicketRows.map((t) => `db ticket #${t.number}`)]
  })
}

/** `liveHistoryEffect` as `packages/setup`'s promise `history` port. */
export function liveHistory(project: string): Promise<readonly string[]> {
  return Effect.runPromise(liveHistoryEffect(project))
}
