/**
 * `spend` — one row per `RunSpent` ([0110](../../../doc/decisions/0110-tokens-on-the-event-money-at-display.md)
 * §11, `#497`).
 *
 * **It is a fold and nothing else, and it reads `RunSpent` and no other spend
 * source.** `RunFinished`, `FixApplied`, `DiscussionAnswered` and
 * `DiscussionHeld` are the old places a cost briefly lived or still lives for
 * another reason — `task_view` and `finding_backlog` must keep not reading
 * `RunSpent` (0110 §13), and this fold must keep not reading them. `TriageAgent`
 * held one too, until 0118 removed it; it stays named here because it is still
 * an exported type a later edit could reach for.
 *
 * **Facts only, never a price** (0110 §5): no rate card, no clock, no network
 * call lives here. `cost_usd` is written exactly as the runtime reported it,
 * `null` staying `null` rather than becoming a free lunch.
 *
 * ## Filling `ticket`
 *
 * `RunSpent` names no ticket directly — it names the stream it is paid on, and
 * which ticket that stream is about is recorded by an earlier event on the
 * same stream, on the ticket's own stream, or on the control stream for a
 * discussion. `spend_stream` is that link, kept here rather than read from
 * `task_view_run` or `finding_backlog_run` for `backlog.ts`'s own reason:
 * another projection's table is at another projection's checkpoint.
 *
 *   `pass-…`  (action, judge)  — linked by this stream's own `RunStarted`, and
 *                               by `TicketClaimed` on the ticket's stream
 *                               (below), whichever lands first
 *   `ticket-…`   (triage)         — needs no link; the stream id is the ticket
 *   `chat-…` (discussion)     — linked by `DiscussionRequested`, keyed on
 *                               `chatStream(chatId)` because that event lands
 *                               on `ctl-conductor`, not on the chat stream
 *
 * **`TicketClaimed` links a run stream before `RunStarted` can.** `claim`
 * appends it to the `ticket-…` stream carrying the run stream's id as `runId`,
 * and `admit` — which can refuse the pass outright, leaving no `RunStarted`
 * ever appended to that run stream — runs after `claim`. A `Judge` `RunSpent`
 * dispatched on such a refusal still names that run stream, so without this
 * link it would read as untraceable when the claim already said whose ticket
 * it was.
 *
 * **A `RunSpent` with no link keeps its row, `ticket` and `project` null
 * rather than dropped.** That happens only when neither link event was ever
 * appended — there is nothing to backfill a null from later, since both links
 * are always written before the `RunSpent` that would need them: `claim`
 * precedes `admit` precedes dispatch, and a discussion is only ever dispatched
 * in reaction to its own `DiscussionRequested`.
 */
import type { PayloadOf, Usage } from '@lingtai/domain'
import { chatStream, isPassStream, isTicketStream, parseTicketStream } from '@lingtai/domain'

import { withProjectionStore } from './choose.ts'
import type { Projection, SpendQuery } from './store.ts'

export const SPEND_TABLE = 'spend'

export const spendProjection: Projection = {
  name: SPEND_TABLE,

  async create(ctx) {
    await ctx.query(`
      create table if not exists spend (
        seq         bigint primary key,
        at          timestamptz not null,
        stream_id   text not null,
        ticket      text,
        project     text,
        pass        text,
        purpose     text not null,
        step        text,
        action      text,
        round       integer,
        spent_for   jsonb not null,
        runtime     text not null,
        turns       integer not null,
        duration_ms bigint not null,
        cost_usd    double precision,
        usage       jsonb not null
      )`)
    // `readSpend({ ticket })` and `readSpend({ project })` are both filters on
    // a table that grows with the log's whole lifetime (0110 §10's six
    // places, several per pass) — without these, every board render scans
    // every row ever to bill the handful of cards on screen.
    await ctx.query('create index if not exists spend_ticket_idx on spend (ticket)')
    await ctx.query('create index if not exists spend_project_idx on spend (project)')

    // Which ticket a stream `RunSpent` arrives on is about. Kept here and not
    // read from another projection's run-link table, for `backlog.ts`'s
    // reason: another projection's table is at another projection's
    // checkpoint.
    await ctx.query(`
      create table if not exists spend_stream (
        stream_id text primary key,
        ticket    text not null
      )`)
  },

  async reset(ctx) {
    await ctx.query('drop table if exists spend')
    await ctx.query('drop table if exists spend_stream')
  },

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString()

      switch (event.type) {
        case 'RunStarted': {
          const d = event.data as PayloadOf<'RunStarted'>
          await ctx.query(
            `insert into spend_stream (stream_id, ticket) values ($1, $2)
             on conflict (stream_id) do nothing`,
            [event.streamId, d.ticketId],
          )
          break
        }

        case 'TicketClaimed': {
          const d = event.data as PayloadOf<'TicketClaimed'>
          await ctx.query(
            `insert into spend_stream (stream_id, ticket) values ($1, $2)
             on conflict (stream_id) do nothing`,
            [d.runId, event.streamId],
          )
          break
        }

        case 'DiscussionRequested': {
          const d = event.data as PayloadOf<'DiscussionRequested'>
          await ctx.query(
            `insert into spend_stream (stream_id, ticket) values ($1, $2)
             on conflict (stream_id) do nothing`,
            [chatStream(d.chatId), d.ticketId],
          )
          break
        }

        case 'RunSpent': {
          const d = event.data as PayloadOf<'RunSpent'>

          let ticket: string | null
          if (isTicketStream(event.streamId)) {
            ticket = event.streamId
          } else {
            const [link] = await ctx.query<{ ticket: string }>('select ticket from spend_stream where stream_id = $1', [
              event.streamId,
            ])
            ticket = link ? link.ticket : null
          }
          const project = ticket === null ? null : (parseTicketStream(ticket)?.project ?? null)
          const pass = isPassStream(event.streamId) ? event.streamId : null
          const step = d.for._tag === 'Action' ? d.for.step : null
          const action = d.for._tag === 'Action' ? d.for.name : null
          const round = d.for._tag === 'Action' ? d.for.round : null

          await ctx.query(
            `insert into spend
               (seq, at, stream_id, ticket, project, pass, purpose, step, action, round,
                spent_for, runtime, turns, duration_ms, cost_usd, usage)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14, $15, $16::jsonb)
             on conflict (seq) do nothing`,
            [
              seq,
              event.at,
              event.streamId,
              ticket,
              project,
              pass,
              d.for._tag,
              step,
              action,
              round,
              JSON.stringify(d.for),
              d.runtime,
              d.turns,
              d.durationMs,
              d.costUsd,
              JSON.stringify(d.usage),
            ],
          )
          break
        }

        default:
          break
      }
    }
  },
}

/**
 * A `spend` row, as the board reads it — facts only, never a price (0110 §5).
 *
 * `purpose` is `RunSpent.for._tag` exactly as written: `step`, `action` and
 * `round` are filled only where it is `'Action'`, and null otherwise, the same
 * split the table itself keeps. Deciding *Work* from *Answering* within
 * `'Action'` is a reader's job (`apps/board/src/lib/spend.ts`'s `billOf`), not
 * this row's — a fact one layer down the stack must not also decide its own
 * purpose.
 *
 * `costUsd` stays `null` rather than becoming a free lunch (0110 §4); so does
 * `project` and `ticket` on the one row shape that can carry both null — a
 * `RunSpent` whose stream linked to neither (`spend.ts`'s own header).
 */
export interface SpendRow {
  seq: string
  at: Date
  streamId: string
  ticket: string | null
  project: string | null
  pass: string | null
  purpose: PayloadOf<'RunSpent'>['for']['_tag']
  step: string | null
  action: string | null
  round: number | null
  runtime: string
  turns: number
  durationMs: number
  costUsd: number | null
  usage: Usage
}

export interface ReadSpendOptions extends SpendQuery {
  url?: string
}

/**
 * Oldest first — a ledger is read the way a log is written. `postgres.ts`'s
 * and `sqlite.ts`'s own queries, since #219, including the one thing that is
 * easy to lose: **a database no projector has ever started has no table, and
 * that is no spend rather than a failure.**
 */
export async function readSpend(options: ReadSpendOptions = {}): Promise<SpendRow[]> {
  return withProjectionStore({ url: options.url, max: 1 }, (store) =>
    store.spend({ ticket: options.ticket, project: options.project, since: options.since }),
  )
}
