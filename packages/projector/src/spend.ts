/**
 * `spend` — one row per `RunSpent` ([0110](../../../doc/decisions/0110-tokens-on-the-event-money-at-display.md)
 * §11, `#497`).
 *
 * **It is a fold and nothing else, and it reads `RunSpent` and no other spend
 * source.** `RunFinished`, `FixApplied`, `DiscussionAnswered`, `DiscussionHeld`
 * and `TriageAgent` are the old places a cost briefly lived or still lives for
 * another reason — `task_view` and `finding_backlog` must keep not reading
 * `RunSpent` (0110 §13), and this fold must keep not reading them.
 *
 * **Facts only, never a price** (0110 §5): no rate card, no clock, no network
 * call lives here. `cost_usd` is written exactly as the runtime reported it,
 * `null` staying `null` rather than becoming a free lunch.
 *
 * ## Filling `ticket`
 *
 * `RunSpent` names no ticket directly — it names the stream it is paid on, and
 * which ticket that stream is about is recorded by an earlier event on the
 * same stream, or on the control stream for a discussion. `spend_stream` is
 * that link, kept here rather than read from `task_view_run` or
 * `finding_backlog_run` for `backlog.ts`'s own reason: another projection's
 * table is at another projection's checkpoint.
 *
 *   `run-…`  (action, judge)  — linked by this stream's own `RunStarted`
 *   `wi-…`   (triage)         — needs no link; the stream id is the ticket
 *   `chat-…` (discussion)     — linked by `DiscussionRequested`, keyed on
 *                               `chatStream(chatId)` because that event lands
 *                               on `ctl-conductor`, not on the chat stream
 *
 * **A `RunSpent` with no link keeps its row, `ticket` and `project` null
 * rather than dropped.** The link is always written before the `RunSpent`
 * that would need it — `RunStarted` opens the pass stream it is about, and a
 * discussion is only ever dispatched in reaction to its own
 * `DiscussionRequested` — so a null here means the source event is missing,
 * and there is nothing to backfill from later.
 */
import type { PayloadOf } from '@lingtai/domain'
import { chatStream, isPassStream, isWorkItemStream, parseWorkItemStream } from '@lingtai/domain'

import type { Projection } from './store.ts'

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
            [event.streamId, d.workItemId],
          )
          break
        }

        case 'DiscussionRequested': {
          const d = event.data as PayloadOf<'DiscussionRequested'>
          await ctx.query(
            `insert into spend_stream (stream_id, ticket) values ($1, $2)
             on conflict (stream_id) do nothing`,
            [chatStream(d.chatId), d.workItemId],
          )
          break
        }

        case 'RunSpent': {
          const d = event.data as PayloadOf<'RunSpent'>

          let ticket: string | null
          if (isWorkItemStream(event.streamId)) {
            ticket = event.streamId
          } else {
            const [link] = await ctx.query<{ ticket: string }>('select ticket from spend_stream where stream_id = $1', [
              event.streamId,
            ])
            ticket = link ? link.ticket : null
          }
          const project = ticket === null ? null : (parseWorkItemStream(ticket)?.project ?? null)
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
