/**
 * `ticket_report` — one row per ticket with the facts the report needs
 * ([0123](../../../doc/decisions/0123-the-report-counts-what-the-log-holds.md) §2, #687).
 *
 * **It folds the log itself and never reads another projection's table** (0123
 * §6): the stream links it needs are its own (`ticket_report_stream`), for
 * `spend.ts`'s reason — another projection's table is at another projection's
 * checkpoint. Everything else lives on the ticket's row, so a batch boundary or
 * a restart loses nothing a replay from the checkpoint would not rebuild.
 *
 * ## The rules
 *
 * - **A pass is a claim, and a continuation is not** (`claimShapeOf`, 0109 §5).
 *   Both open an interval of machine time.
 * - **Fix rounds are summed over passes**: the distinct `(pass stream, round)`
 *   pairs of `Action` `RunSpent`s at round 1 or above (#658: 14 over 4 passes).
 * - **An interval ends at its last sign of life** between its opening and its
 *   ending event, and contributes 0 — counted in `intervals_empty` — when there
 *   is none. A sign of life is an event on the interval's own pass stream after
 *   the opening, or an `Integration*` event naming the ticket. The ending events
 *   are `TicketLanded`, `WaitStarted`, `TicketReleased` and `TicketClosed`, and
 *   close every interval still open. A triage `RunSpent` is on the ticket's
 *   stream and so is no sign of life: its money counts, its time does not.
 *   `intervals_open` are those still open: in flight, or left by a conductor
 *   that died.
 * - **Money is kept in three places and never added together** (0110 §5): the
 *   reported cents, the estimate priced at the run's own day, and the count of
 *   runs nothing could price — per purpose, `Work`/`Answering` being the
 *   `Action` rounds as the board splits them.
 * - **Unknown claims** are the claims with no `Action` `RunSpent` on their pass
 *   stream. A continuation adds none.
 * - **A `RunSpent` with no link to a ticket is dropped**: there is no row to
 *   put it on (unlike `spend`, which keeps it with a null ticket).
 */
import type { Envelope, PayloadOf } from '@lingtai/domain'
import { chatStream, claimShapeOf, cleared, isPassStream, isTicketStream, parseTicketStream } from '@lingtai/domain'
import type { RateRow } from '@lingtai/domain/rate-card'
import { estimateRow } from '@lingtai/domain/rate-card'

import { readRateSnapshot } from './rate-snapshot.ts'
import type { Projection, ProjectionContext } from './store.ts'

export const TICKET_REPORT_TABLE = 'ticket_report'

export interface TicketReportPorts {
  /** The fetched snapshot's rows — read, never fetched. Called at most once per batch. */
  snapshot: () => readonly RateRow[]
}

/** What a purpose cost: reported cents, an estimate, and the runs nothing could price. */
export interface PurposeCost {
  reportedCents: number
  reportedRuns: number
  estimatedUsd: number
  estimatedRuns: number
  unknown: number
}

export interface ReportReview {
  seq: string
  at: string
  round: number
  /** Findings at `blocker` or `major` across the review's completed assessments. */
  blocking: number
  /** Every action of the step cleared: an interrupted review has no blockers and has not cleared. */
  cleared: boolean
}

export interface ReportWait {
  waitId: string
  at: string
  reason: string
  triage: { attempt: number; result: string; cause: string | null } | null
  resolution: string | null
}

interface OpenInterval {
  openedSeq: string
  runId: string
  openedAt: string
  lifeSeq: string | null
  lifeAt: string | null
}

/** A `ticket_report` row, as the fold holds it. */
interface State {
  ticket: string
  kind: string | null
  outcome: 'open' | 'landed' | 'closed'
  outcomeAt: Date | null
  passes: number
  machineMs: number
  intervalsEmpty: number
  passTimes: string[]
  reviews: ReportReview[]
  waits: ReportWait[]
  cost: Record<string, PurposeCost>
  /** runId → whether an `Action` `RunSpent` was paid on it. Only claims are here. */
  claims: Record<string, boolean>
  /** `stream:round`, each distinct pair once. */
  rounds: string[]
  open: OpenInterval[]
  /** The last event seq folded into this row: an event at or below it is a replay and changes nothing. */
  appliedSeq: bigint
}

const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback
  return (typeof value === 'string' ? JSON.parse(value) : value) as T
}

/**
 * A `ticket_report` row as a reader sees it: what `report()` in the conductor
 * takes, less the fold's own bookkeeping (`claims`, `rounds`, `open_intervals`,
 * `applied_seq`). Declared here because the conductor depends on this package.
 */
export interface TicketReportRow {
  ticket: string
  project: string | null
  kind: string | null
  outcome: 'open' | 'landed' | 'closed'
  outcomeAt: Date | null
  passes: number
  fixRounds: number
  machineMs: number
  intervalsEmpty: number
  intervalsOpen: number
  unknownClaims: number
  passTimes: string[]
  reviews: ReportReview[]
  waits: ReportWait[]
  cost: Record<string, PurposeCost>
}

/** Both stores' one mapper: SQLite hands JSON back as text and Postgres as a value, `json` takes either. */
export function ticketReportRowOf(row: Record<string, unknown>): TicketReportRow {
  return {
    ticket: String(row.ticket),
    project: (row.project as string | null | undefined) ?? null,
    kind: (row.kind as string | null | undefined) ?? null,
    outcome: row.outcome as TicketReportRow['outcome'],
    outcomeAt: row.outcome_at === null || row.outcome_at === undefined ? null : new Date(row.outcome_at as string),
    passes: Number(row.passes),
    fixRounds: Number(row.fix_rounds),
    machineMs: Number(row.machine_ms),
    intervalsEmpty: Number(row.intervals_empty),
    intervalsOpen: Number(row.intervals_open),
    unknownClaims: Number(row.unknown_claims),
    passTimes: json(row.pass_times, []),
    reviews: json(row.reviews, []),
    waits: json(row.waits, []),
    cost: json(row.cost, {}),
  }
}

const fresh = (ticket: string): State => ({
  ticket,
  kind: null,
  outcome: 'open',
  outcomeAt: null,
  passes: 0,
  machineMs: 0,
  intervalsEmpty: 0,
  passTimes: [],
  reviews: [],
  waits: [],
  cost: {},
  claims: {},
  rounds: [],
  open: [],
  appliedSeq: 0n,
})

async function load(ctx: ProjectionContext, ticket: string): Promise<State> {
  const [row] = await ctx.query<Record<string, unknown>>('select * from ticket_report where ticket = $1', [ticket])
  if (!row) return fresh(ticket)
  return {
    ticket,
    kind: (row.kind as string | null) ?? null,
    outcome: row.outcome as State['outcome'],
    outcomeAt: row.outcome_at === null || row.outcome_at === undefined ? null : new Date(row.outcome_at as string),
    passes: Number(row.passes),
    machineMs: Number(row.machine_ms),
    intervalsEmpty: Number(row.intervals_empty),
    passTimes: json(row.pass_times, []),
    reviews: json(row.reviews, []),
    waits: json(row.waits, []),
    cost: json(row.cost, {}),
    claims: json(row.claims, {}),
    rounds: json(row.rounds, []),
    open: json(row.open_intervals, []),
    appliedSeq: BigInt(String(row.applied_seq ?? 0)),
  }
}

async function save(ctx: ProjectionContext, s: State): Promise<void> {
  const project = parseTicketStream(s.ticket)?.project ?? null
  await ctx.query(
    `insert into ticket_report
       (ticket, project, kind, outcome, outcome_at, passes, fix_rounds, machine_ms,
        intervals_empty, intervals_open, unknown_claims, pass_times, reviews, waits, cost,
        claims, rounds, open_intervals, applied_seq)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14::jsonb,
             $15::jsonb, $16::jsonb, $17::jsonb, $18::jsonb, $19)
     on conflict (ticket) do update set
       project = excluded.project, kind = excluded.kind, outcome = excluded.outcome,
       outcome_at = excluded.outcome_at, passes = excluded.passes, fix_rounds = excluded.fix_rounds,
       machine_ms = excluded.machine_ms, intervals_empty = excluded.intervals_empty,
       intervals_open = excluded.intervals_open, unknown_claims = excluded.unknown_claims,
       pass_times = excluded.pass_times, reviews = excluded.reviews, waits = excluded.waits,
       cost = excluded.cost, claims = excluded.claims, rounds = excluded.rounds,
       open_intervals = excluded.open_intervals, applied_seq = excluded.applied_seq
     where ticket_report.applied_seq < excluded.applied_seq`,
    [
      s.ticket,
      project,
      s.kind,
      s.outcome,
      s.outcomeAt,
      s.passes,
      s.rounds.length,
      s.machineMs,
      s.intervalsEmpty,
      s.open.length,
      Object.values(s.claims).filter((paid) => !paid).length,
      JSON.stringify(s.passTimes),
      JSON.stringify(s.reviews),
      JSON.stringify(s.waits),
      JSON.stringify(s.cost),
      JSON.stringify(s.claims),
      JSON.stringify(s.rounds),
      JSON.stringify(s.open),
      s.appliedSeq.toString(),
    ],
  )
}

async function link(ctx: ProjectionContext, streamId: string, ticket: string): Promise<void> {
  await ctx.query(
    `insert into ticket_report_stream (stream_id, ticket) values ($1, $2)
     on conflict (stream_id) do nothing`,
    [streamId, ticket],
  )
}

async function ticketOf(ctx: ProjectionContext, streamId: string): Promise<string | null> {
  if (isTicketStream(streamId)) return streamId
  const [row] = await ctx.query<{ ticket: string }>('select ticket from ticket_report_stream where stream_id = $1', [
    streamId,
  ])
  return row ? row.ticket : null
}

/** The board's split of `Action` into the work and answering a refusal (`apps/board/src/lib/spend.ts`'s `purposeOf`). */
const purposeOf = (spentFor: PayloadOf<'RunSpent'>['for']): string =>
  spentFor._tag !== 'Action' ? spentFor._tag : spentFor.round > 0 ? 'Answering' : 'Work'

const emptyCost = (): PurposeCost => ({
  reportedCents: 0,
  reportedRuns: 0,
  estimatedUsd: 0,
  estimatedRuns: 0,
  unknown: 0,
})

/** Ends every open interval: a sign of life makes it count, none makes it empty. */
function endIntervals(s: State): void {
  for (const interval of s.open) {
    if (interval.lifeAt === null) s.intervalsEmpty += 1
    else s.machineMs += Math.max(0, Date.parse(interval.lifeAt) - Date.parse(interval.openedAt))
  }
  s.open = []
}

/** A sign of life on `runId` (or on the ticket, where `runId` is null) after the interval opened. */
function signOfLife(s: State, event: Envelope, runId: string | null): boolean {
  let touched = false
  for (const interval of s.open) {
    if (runId !== null && interval.runId !== runId) continue
    if (event.seq <= BigInt(interval.openedSeq)) continue
    interval.lifeSeq = event.seq.toString()
    interval.lifeAt = event.at.toISOString()
    touched = true
  }
  return touched
}

const blockingOf = (outcome: PayloadOf<'StepEnded'>['outcome']): number => {
  let n = 0
  for (const action of outcome.actions) {
    if (action.yields !== 'verdict' || action.result._tag !== 'Completed') continue
    for (const f of action.result.assessment.findings) if (f.severity === 'blocker' || f.severity === 'major') n += 1
  }
  return n
}

export const ticketReportProjectionWith = (ports: TicketReportPorts): Projection => ({
  name: TICKET_REPORT_TABLE,

  async create(ctx) {
    await ctx.query(`
      create table if not exists ticket_report (
        ticket          text primary key,
        project         text,
        kind            text,
        outcome         text not null,
        outcome_at      timestamptz,
        passes          integer not null,
        fix_rounds      integer not null,
        machine_ms      bigint not null,
        intervals_empty integer not null,
        intervals_open  integer not null,
        unknown_claims  integer not null,
        pass_times      jsonb not null,
        reviews         jsonb not null,
        waits           jsonb not null,
        cost            jsonb not null,
        claims          jsonb not null,
        rounds          jsonb not null,
        open_intervals  jsonb not null,
        applied_seq     bigint not null default 0
      )`)
    await ctx.query('create index if not exists ticket_report_project_idx on ticket_report (project)')
    // Which ticket a pass or chat stream is about — this projection's own, never `spend_stream`.
    await ctx.query(`
      create table if not exists ticket_report_stream (
        stream_id text primary key,
        ticket    text not null
      )`)
  },

  async reset(ctx) {
    await ctx.query('drop table if exists ticket_report')
    await ctx.query('drop table if exists ticket_report_stream')
  },

  async apply(events, ctx) {
    let snapshot: readonly RateRow[] | null = null

    for (const event of events) {
      // Which ticket's row this event touches, and what it does to it.
      let ticket: string | null = null
      let change: ((s: State) => void) | null = null

      switch (event.type) {
        case 'RunStarted': {
          const d = event.data as PayloadOf<'RunStarted'>
          await link(ctx, event.streamId, d.ticketId)
          break
        }

        case 'DiscussionRequested': {
          const d = event.data as PayloadOf<'DiscussionRequested'>
          await link(ctx, chatStream(d.chatId), d.ticketId)
          break
        }

        case 'TicketClaimed':
        case 'TicketContinued': {
          const d = event.data as PayloadOf<'TicketClaimed'>
          await link(ctx, d.runId, event.streamId)
          ticket = event.streamId
          change = (s) => {
            const shape = claimShapeOf(event, Object.keys(s.claims))
            if (shape === 'claim') {
              s.passes += 1
              s.passTimes.push(event.at.toISOString())
              s.claims[d.runId] ??= false
              if (event.type === 'TicketClaimed') s.kind = d.kind
            }
            // A new claim after a close reopens the ticket; a landing stays.
            if (s.outcome === 'closed') {
              s.outcome = 'open'
              s.outcomeAt = null
            }
            s.open.push({
              openedSeq: event.seq.toString(),
              runId: d.runId,
              openedAt: event.at.toISOString(),
              lifeSeq: null,
              lifeAt: null,
            })
          }
          break
        }

        case 'TicketLanded':
          ticket = event.streamId
          change = (s) => {
            endIntervals(s)
            s.outcome = 'landed'
            s.outcomeAt = event.at
          }
          break

        case 'TicketClosed':
          ticket = event.streamId
          change = (s) => {
            endIntervals(s)
            if (s.outcome !== 'landed') {
              s.outcome = 'closed'
              s.outcomeAt = event.at
            }
          }
          break

        case 'TicketReleased':
          ticket = event.streamId
          change = endIntervals
          break

        case 'WaitStarted': {
          const d = event.data as PayloadOf<'WaitStarted'>
          ticket = event.streamId
          change = (s) => {
            endIntervals(s)
            s.waits.push({
              waitId: d.waitId,
              at: event.at.toISOString(),
              reason: d.reason._tag,
              triage: null,
              resolution: null,
            })
          }
          break
        }

        case 'WaitTriaged': {
          const d = event.data as PayloadOf<'WaitTriaged'>
          ticket = event.streamId
          change = (s) => {
            const wait = s.waits.find((w) => w.waitId === d.waitId)
            // A reader takes only the latest attempt's result (`WaitTriaged`'s own comment).
            if (!wait || (wait.triage !== null && wait.triage.attempt > d.attempt)) return
            const cause = d.result._tag === 'TriageAdvised' ? d.result.cause._tag : null
            wait.triage = { attempt: d.attempt, result: d.result._tag, cause }
          }
          break
        }

        case 'WaitResolved': {
          const d = event.data as PayloadOf<'WaitResolved'>
          ticket = event.streamId
          change = (s) => {
            const wait = s.waits.find((w) => w.waitId === d.waitId)
            if (wait) wait.resolution = d.resolution._tag
          }
          break
        }

        case 'StepEnded': {
          const d = event.data as PayloadOf<'StepEnded'>
          ticket = (await ticketOf(ctx, d.runId)) ?? (await ticketOf(ctx, event.streamId))
          if (d.outcome.step !== 'review') break
          change = (s) => {
            s.reviews.push({
              seq: event.seq.toString(),
              at: event.at.toISOString(),
              round: d.outcome.round,
              blocking: blockingOf(d.outcome),
              cleared: d.outcome.actions.every(cleared),
            })
          }
          break
        }

        case 'IntegrationAttempted':
        case 'IntegrationRefused':
        case 'IntegrationSucceeded': {
          const d = event.data as PayloadOf<'IntegrationAttempted'>
          ticket = isTicketStream(d.ticketId) ? d.ticketId : isTicketStream(event.streamId) ? event.streamId : null
          change = (s) => {
            signOfLife(s, event, null)
          }
          break
        }

        case 'RunSpent': {
          const d = event.data as PayloadOf<'RunSpent'>
          ticket = await ticketOf(ctx, event.streamId)
          const onPass = isPassStream(event.streamId)
          let estimate: { usd: number } | null = null
          if (d.costUsd === null) {
            snapshot ??= ports.snapshot()
            estimate = estimateRow({ at: event.at, usage: d.usage }, snapshot)
          }
          change = (s) => {
            const purpose = purposeOf(d.for)
            const bill = (s.cost[purpose] ??= emptyCost())
            if (d.costUsd !== null) {
              bill.reportedCents += Math.round(d.costUsd * 100)
              bill.reportedRuns += 1
            } else if (estimate !== null) {
              bill.estimatedUsd += estimate.usd
              bill.estimatedRuns += 1
            } else bill.unknown += 1

            if (d.for._tag !== 'Action') return
            if (onPass && event.streamId in s.claims) s.claims[event.streamId] = true
            if (d.for.round >= 1) {
              const key = `${event.streamId}:${d.for.round}`
              if (!s.rounds.includes(key)) s.rounds.push(key)
            }
          }
          break
        }

        default:
          break
      }

      // Anything else on a pass stream is a sign of life for the interval that opened it.
      if (change === null && isPassStream(event.streamId)) {
        ticket = await ticketOf(ctx, event.streamId)
        if (ticket !== null) {
          const s = await load(ctx, ticket)
          if (s.appliedSeq < event.seq && signOfLife(s, event, event.streamId)) {
            s.appliedSeq = event.seq
            await save(ctx, s)
          }
        }
        continue
      }
      if (ticket === null || change === null) continue

      const s = await load(ctx, ticket)
      // A replay (a second follower from an older cursor) must not add twice.
      if (s.appliedSeq >= event.seq) continue
      change(s)
      s.appliedSeq = event.seq
      // A pass-stream event is also a sign of life, whatever else it did.
      if (isPassStream(event.streamId)) signOfLife(s, event, event.streamId)
      await save(ctx, s)
    }
  },
})

export const ticketReportProjection: Projection = ticketReportProjectionWith({ snapshot: () => readRateSnapshot() })
