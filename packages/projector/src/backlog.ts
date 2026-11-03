/**
 * `finding_backlog` — the minors a passing gate found, and what a person did
 * about each one ([0038](../../../doc/decisions-archive/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §5, `#137`).
 *
 * A `minor` does not refuse, and that is right. Before this it went from a
 * passing gate's accepted assessment's `findings` into nothing at all: the
 * gate passed, so nobody opened it. This is the destination 0038 gives it —
 * **a backlog a person triages in batches, where accepting one opens an
 * issue.**
 *
 * **It is a fold and nothing else.** No command writes here. An entry exists
 * because a passing gate's assessment carried a minor — read off `StepEnded`
 * through `findingsRaisedOf` (`@lingtai/domain`, #481) — it is closed because
 * a `FindingAccepted` or `FindingDeclined` says so, and an accepted one names
 * its issue once `FindingProposed` does. Dropping the table and
 * replaying the log produces the same rows, which is what
 * `lingtai projection rebuild finding_backlog` does.
 *
 * ## One entry per finding, not per sighting
 *
 * Keyed by `findingKey`, which leaves out the run, the sha and the line. The
 * next attempt's review will likely say the same thing again; it lands on the
 * row that is already there, and `on conflict do nothing` keeps the first
 * sighting — the run and gate an accepted issue cites as its origin. A declined
 * entry therefore stays declined, which is the whole of *does not ask again*.
 *
 * Only a passing gate's assessment, through `findingsRaisedOf`. A refusing
 * one's findings have somewhere to go already — a fix round, and then a
 * person (0038 §1–§4) — and a minor on a failing gate is in the prompt the
 * fixing agent is handed.
 */
import type { Finding, FindingState, PayloadOf } from '@lingtai/domain'
import { applyFinding, findingKey, findingsRaisedOf, parseTicketStream } from '@lingtai/domain'

import { withProjectionStore } from './choose.ts'
import type { Projection } from './store.ts'

export const BACKLOG_TABLE = 'finding_backlog'

interface DecisionRow {
  status: string
  last_seq: string | number | bigint | null
  decided_seq: string | number | bigint | null
  proposed_ref: string | null
  proposed_url: string | null
}

/**
 * The row as the fold's state. Only what a rule of `applyFinding` reads is
 * real — the status, and whether an issue is recorded; the rest is a
 * placeholder, because the update takes its values from the event and never
 * from this (and the row keeps no labels or proposal seq).
 */
function findingOfRow(row: DecisionRow, id: { project: string; key: string }): FindingState {
  switch (row.status) {
    case 'open':
      return { status: 'open' }
    case 'declined':
      return { status: 'declined', by: '', at: new Date(0), seq: 0n, reason: '' }
    case 'accepted':
      return {
        status: 'accepted',
        by: '',
        at: new Date(0),
        seq: 0n,
        kind: '',
        labels: [],
        proposed: row.proposed_ref === null ? null : { externalRef: row.proposed_ref, url: null, seq: 0n },
      }
    default:
      throw new Error(`finding_backlog ${id.project}/${id.key} has status "${row.status}"`)
  }
}

/**
 * `accepted` with no `proposedRef` is a decision whose issue the log has not
 * recorded yet — opening it is still owed, and safe to repeat.
 */
export type BacklogStatus = 'open' | 'accepted' | 'declined'

export interface BacklogEntry {
  key: string
  project: string
  /** The ticket the finding is about — not the one accepting it opens. */
  issue: string
  taskId: string
  /** The first run whose gate raised it. */
  runId: string
  step: string
  action: string
  onSha: string
  file: string
  line: number | null
  severity: Finding['severity']
  claim: string
  failureScenario: string
  raisedSeq: string
  raisedAt: Date
  status: BacklogStatus
  decidedBy: string | null
  decidedAt: Date | null
  /** The kind an accepted entry's issue carries. */
  kind: string | null
  /** What the store called the ticket it opened, on an accepted entry — null until it is recorded. */
  proposedRef: string | null
  proposedUrl: string | null
  /** Why, on a declined entry. */
  reason: string | null
}

export const backlogProjection: Projection = {
  name: BACKLOG_TABLE,

  async create(ctx) {
    await ctx.query(`
      create table if not exists finding_backlog (
        project          text not null,
        key              text not null,
        issue            text not null,
        task_id          text not null,
        run_id           text not null,
        step             text not null,
        action           text not null,
        on_sha           text not null,
        file             text not null,
        line             integer,
        severity         text not null,
        claim            text not null,
        failure_scenario text not null,
        raised_seq       bigint not null,
        raised_at        timestamptz not null,
        status           text not null default 'open',
        decided_by       text,
        decided_at       timestamptz,
        decided_seq      bigint,
        kind             text,
        proposed_ref     text,
        proposed_url     text,
        reason           text,
        last_seq         bigint,
        primary key (project, key)
      )`)
    await ctx.query('create index if not exists finding_backlog_status_idx on finding_backlog (status)')

    // Which ticket a run belongs to. `StepEnded` is on the run's stream and
    // names only the run; `RunStarted` names the work item. Kept here rather
    // than read from `task_view_run`, because another projection's table is
    // at another projection's checkpoint.
    await ctx.query(`
      create table if not exists finding_backlog_run (
        run_id  text primary key,
        task_id text not null
      )`)
  },

  async reset(ctx) {
    await ctx.query('drop table if exists finding_backlog')
    await ctx.query('drop table if exists finding_backlog_run')
  },

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString()

      switch (event.type) {
        case 'RunStarted': {
          const d = event.data as PayloadOf<'RunStarted'>
          await ctx.query(
            `insert into finding_backlog_run (run_id, task_id) values ($1, $2)
             on conflict (run_id) do nothing`,
            [event.streamId, d.ticketId],
          )
          break
        }

        case 'FindingAccepted':
        case 'FindingProposed':
        case 'FindingDeclined': {
          // Read the row again for every event: an earlier event of this batch
          // has already updated it, and the fold must see that.
          const d = event.data as { project: string; key: string }
          const [row] = await ctx.query<DecisionRow>(
            `select status, last_seq, decided_seq, proposed_ref, proposed_url from finding_backlog where project = $1 and key = $2`,
            [d.project, d.key],
          )
          // A finding nothing raised has no row to be wrong about.
          if (!row) break
          // Delivery is at-least-once: two runners share this checkpoint and each
          // commits its batch before advancing it, so one can hand over an event
          // the other already folded. An event no newer than the last one reduced
          // into the row is that replay, by identity (its seq) — never by payload.
          if (row.last_seq !== null && BigInt(row.last_seq) >= event.seq) break
          const before = findingOfRow(row, d)
          const after = applyFinding(before, event)
          if (before.status === 'open' && after.status === 'accepted') {
            const a = event.data as PayloadOf<'FindingAccepted'>
            await ctx.query(
              `update finding_backlog
                 set status = 'accepted', decided_by = $3, decided_at = $4, decided_seq = $5, kind = $6,
                     last_seq = $5
               where project = $1 and key = $2`,
              [a.project, a.key, a.by, event.at, seq, a.kind],
            )
          } else if (before.status === 'open' && after.status === 'declined') {
            const x = event.data as PayloadOf<'FindingDeclined'>
            await ctx.query(
              `update finding_backlog
                 set status = 'declined', decided_by = $3, decided_at = $4, decided_seq = $5,
                     reason = $6, last_seq = $5
               where project = $1 and key = $2`,
              [x.project, x.key, x.by, event.at, seq, x.reason],
            )
          } else if (after !== before) {
            const p = event.data as PayloadOf<'FindingProposed'>
            await ctx.query(
              `update finding_backlog set proposed_ref = $3, proposed_url = $4, last_seq = $5
               where project = $1 and key = $2`,
              [p.project, p.key, p.externalRef, p.url, seq],
            )
          }
          break
        }

        /**
         * A passing gate's accepted assessment — the one event type 0120's
         * appendix retires here (`StepPassed, StepFailed, … → StepEnded`).
         * `findingsRaisedOf` (`@lingtai/domain`) is where that rule now lives,
         * so #464's switch to the stored read model only has to change that
         * function, leaving this file untouched (the design for #481).
         */
        default: {
          // `findingsRaisedOf` answers an array since #502 (0120 phase 2): a
          // `StepEnded` may carry more than one accepted verdict-yield action.
          for (const raised of findingsRaisedOf(event)) {
            const minors = raised.assessment.findings.filter((f) => f.severity === 'minor')
            if (minors.length === 0) continue
            const [link] = await ctx.query<{ task_id: string }>(
              'select task_id from finding_backlog_run where run_id = $1',
              [raised.runId],
            )
            const task = link ? parseTicketStream(link.task_id) : null
            // A pass on a run nothing started names no ticket, and an entry that
            // cannot say which ticket it is about cannot open one that cites it.
            if (!link || !task) continue
            for (const f of minors) {
              const key = findingKey({
                issue: task.issue,
                step: raised.step,
                action: raised.action,
                file: f.file,
                claim: f.claim,
              })
              await ctx.query(
                `insert into finding_backlog
                   (project, key, issue, task_id, run_id, step, action, on_sha, file, line,
                    severity, claim, failure_scenario, raised_seq, raised_at)
                 values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                 on conflict (project, key) do nothing`,
                [
                  task.project,
                  key,
                  task.issue,
                  link.task_id,
                  raised.runId,
                  raised.step,
                  raised.action,
                  raised.onSha,
                  f.file,
                  f.line,
                  f.severity,
                  f.claim,
                  f.failureScenario,
                  seq,
                  event.at,
                ],
              )
            }
          }
          break
        }
      }
    }
  },
}

export interface ReadBacklogOptions {
  project?: string
  /** Absent reads every status. */
  status?: BacklogStatus
  key?: string
  url?: string
}

/**
 * Oldest first within a project: a backlog is worked from the bottom.
 *
 * Out of whichever store this machine wrote down (#179). The query and the
 * mapping are `postgres.ts`'s and `sqlite.ts`'s since #219 and unchanged by the
 * move, including the one thing that is easy to lose: **a database no projector
 * has ever started has no table, and that is an empty backlog rather than a
 * failure.**
 */
export async function readBacklog(options: ReadBacklogOptions = {}): Promise<BacklogEntry[]> {
  return withProjectionStore({ url: options.url, max: 1 }, (store) =>
    store.backlog({
      project: options.project,
      status: options.status,
      key: options.key,
    }),
  )
}
