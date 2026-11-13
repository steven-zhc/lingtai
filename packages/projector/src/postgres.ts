import type { TriageResult } from '@lingtai/domain/wait'
import { postgresUrl } from '@lingtai/env'
/**
 * The projections in Postgres — the implementation that was already here.
 *
 * Every statement in this file was somewhere under `src/` before #219, and is
 * here unchanged. Nothing about the Postgres path's behaviour moved; what moved
 * is where the connection is opened, from six places that each built their own
 * to one that answers `ProjectionStore`.
 *
 * It talks to Postgres through `pg` rather than through the ORM, and that is
 * deliberate. Projections are **not** in the Prisma contract — their shape will
 * change, and changing one is a drop and a replay rather than a migration
 * (doc/decisions-archive/0003-postgres-event-store.md). A table the contract does not
 * know about has no ORM surface, and a projection needs DDL, `drop` and its own
 * upserts regardless. The same deliberate split as the subscriber.
 */
import { Effect, Exit } from 'effect'
import pg from 'pg'

import { acquireObserver } from './acquire.ts'
import type { BacklogEntry } from './backlog.ts'
import { grantOfFor, type SpendRow } from './spend.ts'
import { promiseProjectionStore } from './store-face.ts'
import { CheckpointRewoundError, clampLanded, columnOf, mapRows, ProjectionShapeError } from './store.ts'
import type {
  BacklogQuery,
  ProjectionContextPort,
  ProjectionLag,
  ProjectionsPort,
  ProjectionStore,
  SpendQuery,
  TaskQuery,
  TicketReportLandedQuery,
  TicketReportQuery,
} from './store.ts'
import { waitOf } from './task-view.ts'
import type { TaskCard, TaskState } from './task-view.ts'
import { TICKET_REPORT_COLUMNS, TICKET_REPORT_TABLE, ticketReportRowOf } from './ticket-report.ts'
import type { TicketReportRow } from './ticket-report.ts'

/**
 * `checkpoints.updated_at` is `NOT NULL` with no database default —
 * `temporal.updatedAtString()` is a Prisma client behaviour, not a trigger — so
 * raw SQL has to supply it. Measured against the live schema; forgetting it
 * fails loudly, which is the good case.
 */
const ADVANCE_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, $2, now())
  on conflict (name) do update
    set last_seq = excluded.last_seq, updated_at = now()`

const ADVANCE_CHECKPOINT_FENCED = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, $2, now())
  on conflict (name) do update
    set last_seq = greatest(checkpoints.last_seq, excluded.last_seq), updated_at = now()
    where checkpoints.last_seq >= $3
  returning name`

const REGISTER_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, 0, now())
  on conflict (name) do nothing`

const RESET_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, 0, now())
  on conflict (name) do update
    set last_seq = 0, updated_at = now()`

function ctxFor(client: pg.PoolClient | pg.Client): ProjectionContextPort {
  return {
    query: (text, values) =>
      Effect.promise(() => client.query(text, values ? [...values] : undefined).then((r) => r.rows)),
  }
}

/** A `task_view` row → the card the board renders. Unchanged from `readTasks`. */
function toCard(row: pg.QueryResultRow): TaskCard {
  // Through `columnOf`, not off the row: `select t.*` on a table created
  // before the column was renamed hands back no `verdicts` at all, and
  // `row.verdicts ?? {}` would count that as a run with no verdicts rather
  // than as the drift it is.
  const recorded = (columnOf(row, 'task_view', 'verdicts') ?? {}) as Record<string, string>
  // Only the run the row names. A released row names none, so it counts
  // nothing — which is the point: between a release and the next attempt
  // reaching the same point there is no live verdict to report, and the
  // card used to report the dead one anyway (#78).
  const mine = row.run_id ? `${row.run_id as string}:` : null
  const verdicts = mine
    ? Object.entries(recorded)
        .filter(([key]) => key.startsWith(mine))
        .map(([, verdict]) => verdict)
    : []
  const count = (v: string) => verdicts.filter((x) => x === v).length
  const wait = waitOf(
    row.task_id,
    row.state as TaskState,
    columnOf(row, 'task_view', 'wait_id'),
    columnOf(row, 'task_view', 'wait_reason'),
  )
  return {
    taskId: row.task_id,
    project: row.project,
    issue: row.issue,
    title: row.title ?? `#${row.issue}`,
    kind: row.kind ?? 'unknown',
    state: row.state as TaskState,
    tier: row.tier,
    runId: row.run_id,
    turns: row.turns,
    passed: count('passed'),
    failed: count('failed'),
    waived: count('waived'),
    approved: count('approved'),
    baseSha: row.base_sha,
    headSha: row.head_sha,
    files: row.files,
    insertions: row.insertions,
    deletions: row.deletions,
    note: row.note,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at,
    restarts: row.restarts ?? 0,
    restartsOf: row.restarts_of ?? 0,
    // `waitOf` reads both columns through `columnOf`, so a stale table
    // reports shape drift instead of drawing a card without its wait.
    wait,
    triage:
      wait === null
        ? { started: null, result: null }
        : {
            started:
              columnOf(row, 'task_view', 'triage_attempt') === null
                ? null
                : {
                    attempt: columnOf(row, 'task_view', 'triage_attempt') as number,
                    at: columnOf(row, 'task_view', 'triage_started_at') as Date,
                  },
            result: columnOf(row, 'task_view', 'triage_result') as TriageResult | null,
          },
    triageHeadSha: wait === null ? null : (columnOf(row, 'task_view', 'triage_head_sha') as string | null),
    answer: (row.answer as TaskCard['answer']) ?? null,
    split: (columnOf(row, 'task_view', 'split') as TaskCard['split']) ?? null,
    awaitingSha: row.awaiting_sha,
    awaitingApproval: row.awaiting_sha !== null,
    repairPending: row.repair_pending === true,
  }
}

/**
 * A `finding_backlog` row → a backlog entry. Unchanged from `readBacklog`.
 *
 * **The column and the field are both `step` since `#247`, and before it they
 * were not.** The column follows the payload field it reduces, and while that
 * field was spelled `gate` the column was too: `#250` renamed the read with the
 * field and left `gate text not null` standing, so every entry came back with
 * `step: undefined` and nothing said so — `pg.QueryResultRow`'s index signature
 * is what `tsc` cannot see through. A row read by a name the table has not got
 * is silent in both directions, which is why `projector/unit/drift.test.ts`
 * asserts the round trip rather than the spelling.
 */
function toEntry(row: pg.QueryResultRow): BacklogEntry {
  return {
    key: row.key,
    project: row.project,
    issue: row.issue,
    taskId: row.task_id,
    runId: row.run_id,
    step: row.step,
    action: row.action,
    onSha: row.on_sha,
    file: row.file,
    line: row.line,
    severity: row.severity,
    claim: row.claim,
    failureScenario: row.failure_scenario,
    raisedSeq: String(row.raised_seq),
    raisedAt: row.raised_at,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    kind: row.kind,
    proposedRef: row.proposed_ref,
    proposedUrl: row.proposed_url,
    reason: row.reason,
  }
}

/** A `spend` row → `SpendRow`. Unchanged from `readSpend`. */
function toSpendRow(row: pg.QueryResultRow): SpendRow {
  return {
    seq: String(row.seq),
    at: row.at,
    streamId: row.stream_id,
    ticket: row.ticket,
    project: row.project,
    pass: row.pass,
    purpose: row.purpose,
    step: row.step,
    action: row.action,
    round: row.round,
    runtime: row.runtime,
    turns: row.turns,
    durationMs: row.duration_ms,
    costUsd: row.cost_usd,
    usage: row.usage,
    estimatedUsd: row.estimated_usd ?? null,
    estimateFetched: row.estimate_fetched ?? null,
    kind: row.kind ?? null,
    grant: grantOfFor(row.spent_for),
  }
}

export interface PostgresProjectionStoreOptions {
  /** Pooled connection. Transaction mode is fine: a transaction is one checkout. */
  url?: string
  /** Connections. Two is enough for a runner: one transaction and one read. */
  max?: number
  /** Let an idle pool stop holding the event loop: for a pool that is shared and so never ended per read. */
  allowExitOnIdle?: boolean
}

/**
 * An idle client the server drops emits `error` on the pool; with no listener
 * Node throws and the board or the daemon dies (#793). One line, and the next
 * checkout gets a new client.
 */
export function listenForIdleErrors(
  emitter: { on(event: 'error', listener: (err: Error) => void): unknown },
  write: (line: string) => void = (line) => console.error(line),
): void {
  emitter.on('error', (err) => write(`lingtai: a projection connection dropped while idle (${err.message})`))
}

/** The promise `ProjectionStore`: a face over `makePostgresProjections`. */
export function createPostgresProjectionStore(options: PostgresProjectionStoreOptions = {}): ProjectionStore {
  return promiseProjectionStore(makePostgresProjections(options))
}

const codeOf = (err: unknown) => (err as { code?: string }).code

/** The part of a `pg.Pool` a read needs, so a test can hand a fake one. */
export type QueryPool = Pick<pg.Pool, 'connect' | 'query'>

/**
 * One read. With an observer installed it takes the connection itself, which is
 * what `Pool.query` does underneath, so the checkout is its own step; a driver
 * error discards the client (`release(err)`), as `Pool.query` does.
 */
export function queryRows(pool: QueryPool, text: string, args?: unknown[]): Promise<pg.QueryResultRow[]> {
  const around = acquireObserver()
  if (around === undefined) return pool.query(text, args).then((r) => r.rows)
  return around(() => pool.connect()).then((client) =>
    client.query(text, args).then(
      (r) => {
        client.release()
        return r.rows
      },
      (err: unknown) => {
        client.release(err instanceof Error ? err : true)
        throw err
      },
    ),
  )
}

/** `Projections` over a `pg.Pool`. A driver error is a defect, as itself. */
export function makePostgresProjections(options: PostgresProjectionStoreOptions = {}): ProjectionsPort {
  const pool = new pg.Pool({
    connectionString: options.url ?? postgresUrl(),
    max: options.max ?? 2,
    ...(options.allowExitOnIdle ? { allowExitOnIdle: true } : {}),
  })
  listenForIdleErrors(pool)

  const rows = (text: string, args?: unknown[]) => Effect.promise(() => queryRows(pool, text, args))

  /** A read whose missing table (`42P01`) is no rows rather than a failure. */
  const rowsOrNone = (text: string, args?: unknown[]) =>
    Effect.promise(() =>
      queryRows(pool, text, args).then(
        (r) => r,
        (err: unknown) => {
          if (codeOf(err) === '42P01') return []
          throw err
        },
      ),
    )

  return {
    transact: <A, E>(fn: (ctx: ProjectionContextPort) => Effect.Effect<A, E>) =>
      Effect.suspend(() => {
        // Set once COMMIT has been acknowledged: a rollback after that would run
        // outside any transaction.
        let committed = false
        return Effect.acquireUseRelease(
          Effect.promise(() => pool.connect()),
          (client) =>
            Effect.gen(function* () {
              yield* Effect.promise(() => client.query('begin'))
              const result = yield* fn(ctxFor(client))
              // Uninterruptible: an interruption waits for the commit's
              // acknowledgment rather than abandoning it and queueing a ROLLBACK
              // behind a COMMIT that has already been dispatched.
              yield* Effect.uninterruptible(
                Effect.promise(() =>
                  client.query('commit').then(() => {
                    committed = true
                  }),
                ),
              )
              return result
            }),
          (client, exit) =>
            (Exit.isSuccess(exit) || committed
              ? Effect.void
              : Effect.promise(() =>
                  client.query('rollback').then(
                    () => undefined,
                    () => {
                      // The connection is already gone; the transaction died with it.
                    },
                  ),
                )
            ).pipe(Effect.ensuring(Effect.sync(() => client.release()))),
        )
      }).pipe(Effect.withSpan('Projections.transact')),

    checkpoint: Effect.fn('Projections.checkpoint')(function* (name: string) {
      const r = yield* rows('select last_seq::text as last_seq from checkpoints where name = $1', [name])
      return BigInt((r[0]?.last_seq as string | undefined) ?? '0')
    }),

    advance: Effect.fn('Projections.advance')(function* (
      ctx: ProjectionContextPort,
      name: string,
      seq: bigint,
      from?: bigint,
    ) {
      if (from === undefined) {
        yield* ctx.query(ADVANCE_CHECKPOINT, [name, seq.toString()])
        return
      }
      const moved = yield* ctx.query(ADVANCE_CHECKPOINT_FENCED, [name, seq.toString(), from.toString()])
      if (moved.length === 0) return yield* Effect.fail(new CheckpointRewoundError(name))
    }),

    register: Effect.fn('Projections.register')(function* (ctx: ProjectionContextPort, name: string) {
      yield* ctx.query(REGISTER_CHECKPOINT, [name])
    }),

    rewind: Effect.fn('Projections.rewind')(function* (ctx: ProjectionContextPort, name: string) {
      yield* ctx.query(RESET_CHECKPOINT, [name])
    }),

    columnsOf: Effect.fn('Projections.columnsOf')(function* (tables: readonly string[]) {
      const live = new Map<string, ReadonlySet<string>>()
      if (tables.length === 0) return live
      const r = yield* rows(
        `select table_name, column_name from information_schema.columns
         where table_schema = current_schema() and table_name = any($1::text[])`,
        [[...tables]],
      )
      for (const row of r) {
        const set = (live.get(row.table_name) as Set<string> | undefined) ?? new Set<string>()
        set.add(row.column_name)
        live.set(row.table_name, set)
      }
      return live
    }),

    lag: Effect.fn('Projections.lag')(function* (name: string) {
      const r = yield* rows(
        `select coalesce(c.last_seq, 0)::text as last_seq,
                (select coalesce(max(seq), 0) from events)::text as head_seq,
                c.updated_at
         from (select 1) one
         left join checkpoints c on c.name = $1`,
        [name],
      )
      const row = r[0]
      const lastSeq = BigInt(row?.last_seq ?? '0')
      const headSeq = BigInt(row?.head_seq ?? '0')
      return { name, lastSeq, headSeq, lag: headSeq - lastSeq, updatedAt: (row?.updated_at as Date | null) ?? null }
    }),

    lags: Effect.fn('Projections.lags')(function* () {
      const r = yield* rows(
        `select c.name,
                c.last_seq::text as last_seq,
                (select coalesce(max(seq), 0) from events)::text as head_seq,
                c.updated_at
         from checkpoints c
         order by c.name`,
      )
      return r.map((row): ProjectionLag => {
        const lastSeq = BigInt(row.last_seq)
        const headSeq = BigInt(row.head_seq)
        return { name: row.name, lastSeq, headSeq, lag: headSeq - lastSeq, updatedAt: row.updated_at }
      })
    }),

    tasks: Effect.fn('Projections.tasks')(function* (query: TaskQuery) {
      const args: unknown[] = [query.retentionDays]
      let where = `where (t.closed_at is null or t.closed_at > now() - ($1 || ' days')::interval)`
      if (query.project) {
        args.push(query.project)
        where += ` and t.project = $2`
      }

      const r = yield* rows(
        `select t.*
         from task_view t
         ${where}
         order by t.project,
           -- "Waiting on you" is oldest first: it is the column that stalls, and
           -- what has waited longest is what to do next. Null everywhere else, so
           -- the other lanes fall through to the ticket number.
           case when t.state = 'waiting' then t.updated_at end asc nulls last,
           nullif(regexp_replace(t.issue, '\\D', '', 'g'), '')::bigint`,
        args,
      )
      return yield* mapRows(() => r.map(toCard))
    }),

    taskProjects: Effect.fn('Projections.taskProjects')(function* (query: Pick<TaskQuery, 'retentionDays'>) {
      const r = yield* rows(
        `select distinct project
         from task_view
         where (closed_at is null or closed_at > now() - ($1 || ' days')::interval)
         order by project`,
        [query.retentionDays],
      )
      return r.map((row) => row.project as string)
    }),

    backlog: Effect.fn('Projections.backlog')(function* (query: BacklogQuery) {
      const where: string[] = []
      const args: unknown[] = []
      for (const [column, value] of [
        ['project', query.project],
        ['status', query.status],
        ['key', query.key],
      ] as const) {
        if (value === undefined) continue
        args.push(value)
        where.push(`${column} = $${args.length}`)
      }
      if (query.taskIds !== undefined) {
        if (query.taskIds.length === 0) return []
        args.push([...query.taskIds])
        where.push(`task_id = any($${args.length}::text[])`)
      }
      // A database no projector has ever started has no table, and that is an
      // empty backlog rather than a failure.
      const r = yield* rowsOrNone(
        `select * from finding_backlog
         ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
         order by project, raised_seq`,
        args,
      )
      return r.map(toEntry)
    }),

    spend: Effect.fn('Projections.spend')(function* (query: SpendQuery) {
      const where: string[] = []
      const args: unknown[] = []
      if (query.ticket !== undefined) {
        args.push(Array.isArray(query.ticket) ? query.ticket : [query.ticket])
        where.push(`ticket = any($${args.length}::text[])`)
      }
      if (query.project !== undefined) {
        args.push(query.project)
        where.push(`project = $${args.length}`)
      }
      if (query.since !== undefined) {
        args.push(query.since)
        where.push(`at >= $${args.length}`)
      }
      // No table is no spend rather than a failure — `backlog`'s own reason.
      const r = yield* rowsOrNone(
        `select * from spend
         ${where.length > 0 ? `where ${where.join(' and ')}` : ''}
         order by seq`,
        args,
      )
      return r.map(toSpendRow)
    }),

    ticketReport: Effect.fn('Projections.ticketReport')(function* (query: TicketReportQuery) {
      // `spend`'s own reason: no table is no tickets, not a failure.
      const r =
        query.project === undefined
          ? yield* rowsOrNone('select * from ticket_report order by ticket')
          : yield* rowsOrNone('select * from ticket_report where project = $1 order by ticket', [query.project])
      return r.map(ticketReportRowOf)
    }),

    landed: Effect.fn('Projections.landed')(function* (query: TicketReportLandedQuery) {
      const where = [`outcome = 'landed'`]
      const args: unknown[] = []
      if (query.project !== undefined) {
        args.push(query.project)
        where.push(`project = $${args.length}`)
      }
      if (query.kind !== undefined) {
        args.push(query.kind)
        where.push(`kind = $${args.length}`)
      }
      if (query.before !== undefined) {
        args.push(query.before.at, query.before.ticket)
        where.push(`(outcome_at, ticket) < ($${args.length - 1}::timestamptz, $${args.length})`)
      }
      args.push(clampLanded(query.limit))
      const read = yield* Effect.promise(() =>
        pool
          .query(
            `select ${TICKET_REPORT_COLUMNS} from ticket_report
             where ${where.join(' and ')}
             order by outcome_at desc, ticket desc
             limit $${args.length}`,
            args,
          )
          .then(
            (r): Effect.Effect<TicketReportRow[], ProjectionShapeError> =>
              Effect.succeed(r.rows.map(ticketReportRowOf)),
            (err: unknown): Effect.Effect<TicketReportRow[], ProjectionShapeError> => {
              if (codeOf(err) === '42P01') return Effect.succeed([])
              // A column the table lacks is drift, and drift names the rebuild.
              if (codeOf(err) === '42703') {
                return Effect.fail(
                  new ProjectionShapeError(TICKET_REPORT_TABLE, [
                    { table: TICKET_REPORT_TABLE, missing: ['landing columns'], unexpected: [] },
                  ]),
                )
              }
              throw err
            },
          ),
      )
      return yield* read
    }),

    close: Effect.fn('Projections.close')(function* () {
      yield* Effect.promise(() => pool.end())
    }),
  }
}
