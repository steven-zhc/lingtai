/**
 * `finding_backlog` — the minors a passing gate found, and what a person did
 * about each one ([0038](../../../doc/decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §5, `#137`).
 *
 * A `minor` does not refuse, and that is right. Before this it went from a
 * `GatePassed`'s `findings` into nothing at all: the gate passed, so nobody
 * opened it. This is the destination 0038 gives it — **a backlog a person
 * triages in batches, where accepting one opens an issue.**
 *
 * **It is a fold and nothing else.** No command writes here. An entry exists
 * because a `GatePassed` carried a minor; it is closed because a
 * `FindingAccepted` or `FindingDeclined` says so, and an accepted one names
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
 * Only `GatePassed`. A `GateFailed`'s findings have somewhere to go already —
 * a fix round, and then a person (0038 §1–§4) — and a minor on a failing gate
 * is in the prompt the fixing agent is handed.
 */
import type { Finding, PayloadOf } from "@lingtai/domain";
import { findingKey, parseWorkItemStream } from "@lingtai/domain";
import { withProjectionStore } from "./choose.ts";
import type { Projection } from "./store.ts";

export const BACKLOG_TABLE = "finding_backlog";

/**
 * `accepted` with no `proposedRef` is a decision whose issue the log has not
 * recorded yet — opening it is still owed, and safe to repeat.
 */
export type BacklogStatus = "open" | "accepted" | "declined";

export interface BacklogEntry {
  key: string;
  project: string;
  /** The ticket the finding is about — not the one accepting it opens. */
  issue: string;
  taskId: string;
  /** The first run whose gate raised it. */
  runId: string;
  gate: string;
  action: string;
  onSha: string;
  file: string;
  line: number | null;
  severity: Finding["severity"];
  claim: string;
  failureScenario: string;
  raisedSeq: string;
  raisedAt: Date;
  status: BacklogStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  /** The kind an accepted entry's issue carries. */
  kind: string | null;
  /** What the store called the ticket it opened, on an accepted entry — null until it is recorded. */
  proposedRef: string | null;
  proposedUrl: string | null;
  /** Why, on a declined entry. */
  reason: string | null;
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
        gate             text not null,
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
        primary key (project, key)
      )`);
    await ctx.query("create index if not exists finding_backlog_status_idx on finding_backlog (status)");

    // Which ticket a run belongs to. `GatePassed` is on the run's stream and
    // names only the run; `RunStarted` names the work item. Kept here rather
    // than read from `task_view_run`, because another projection's table is
    // at another projection's checkpoint.
    await ctx.query(`
      create table if not exists finding_backlog_run (
        run_id  text primary key,
        task_id text not null
      )`);
  },

  async reset(ctx) {
    await ctx.query("drop table if exists finding_backlog");
    await ctx.query("drop table if exists finding_backlog_run");
  },

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString();

      switch (event.type) {
        case "RunStarted": {
          const d = event.data as PayloadOf<"RunStarted">;
          await ctx.query(
            `insert into finding_backlog_run (run_id, task_id) values ($1, $2)
             on conflict (run_id) do nothing`,
            [event.streamId, d.workItemId],
          );
          break;
        }

        case "GatePassed": {
          const d = event.data as PayloadOf<"GatePassed">;
          const minors = d.findings.filter((f) => f.severity === "minor");
          if (minors.length === 0) break;
          const [link] = await ctx.query<{ task_id: string }>(
            "select task_id from finding_backlog_run where run_id = $1",
            [d.runId],
          );
          const task = link ? parseWorkItemStream(link.task_id) : null;
          // A pass on a run nothing started names no ticket, and an entry that
          // cannot say which ticket it is about cannot open one that cites it.
          if (!link || !task) break;
          for (const f of minors) {
            const key = findingKey({
              issue: task.issue,
              gate: d.gate,
              action: d.action,
              file: f.file,
              claim: f.claim,
            });
            await ctx.query(
              `insert into finding_backlog
                 (project, key, issue, task_id, run_id, gate, action, on_sha, file, line,
                  severity, claim, failure_scenario, raised_seq, raised_at)
               values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
               on conflict (project, key) do nothing`,
              [
                task.project,
                key,
                task.issue,
                link.task_id,
                d.runId,
                d.gate,
                d.action,
                d.onSha,
                f.file,
                f.line,
                f.severity,
                f.claim,
                f.failureScenario,
                seq,
                event.at,
              ],
            );
          }
          break;
        }

        case "FindingAccepted": {
          const d = event.data as PayloadOf<"FindingAccepted">;
          await ctx.query(
            `update finding_backlog
               set status = 'accepted', decided_by = $3, decided_at = $4, decided_seq = $5, kind = $6
             where project = $1 and key = $2`,
            [d.project, d.key, d.by, event.at, seq, d.kind],
          );
          break;
        }

        case "FindingProposed": {
          const d = event.data as PayloadOf<"FindingProposed">;
          await ctx.query(
            `update finding_backlog set proposed_ref = $3, proposed_url = $4
             where project = $1 and key = $2`,
            [d.project, d.key, d.externalRef, d.url],
          );
          break;
        }

        case "FindingDeclined": {
          const d = event.data as PayloadOf<"FindingDeclined">;
          await ctx.query(
            `update finding_backlog
               set status = 'declined', decided_by = $3, decided_at = $4, decided_seq = $5,
                   reason = $6
             where project = $1 and key = $2`,
            [d.project, d.key, d.by, event.at, seq, d.reason],
          );
          break;
        }
      }
    }
  },
};

export interface ReadBacklogOptions {
  project?: string;
  /** Absent reads every status. */
  status?: BacklogStatus;
  key?: string;
  url?: string;
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
  );
}
