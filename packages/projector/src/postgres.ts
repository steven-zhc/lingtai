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
 * (doc/decisions/0003-postgres-event-store.md). A table the contract does not
 * know about has no ORM surface, and a projection needs DDL, `drop` and its own
 * upserts regardless. The same deliberate split as the subscriber.
 */
import pg from "pg";
import { postgresUrl } from "@lingtai/env";
import type { BacklogEntry } from "./backlog.ts";
import type {
  BacklogQuery,
  ProjectionContext,
  ProjectionLag,
  ProjectionStore,
  TaskQuery,
} from "./store.ts";
import type { BlockDiagnosis } from "@lingtai/domain";
import type { TaskCard, TaskState } from "./task-view.ts";

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
    set last_seq = excluded.last_seq, updated_at = now()`;

const REGISTER_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, 0, now())
  on conflict (name) do nothing`;

const RESET_CHECKPOINT = `
  insert into checkpoints (name, last_seq, updated_at)
  values ($1, 0, now())
  on conflict (name) do update
    set last_seq = 0, updated_at = now()`;

function ctxFor(client: pg.PoolClient | pg.Client): ProjectionContext {
  return {
    async query(text, values) {
      const r = await client.query(text, values ? [...values] : undefined);
      return r.rows;
    },
  };
}

/** A `task_view` row → the card the board renders. Unchanged from `readTasks`. */
function toCard(row: pg.QueryResultRow): TaskCard {
  const recorded = (row.verdicts ?? {}) as Record<string, string>;
  // Only the run the row names. A released row names none, so it counts
  // nothing — which is the point: between a release and the next attempt
  // reaching the same point there is no live verdict to report, and the
  // card used to report the dead one anyway (#78).
  const mine = row.run_id ? `${row.run_id as string}:` : null;
  const verdicts = mine
    ? Object.entries(recorded)
        .filter(([key]) => key.startsWith(mine))
        .map(([, verdict]) => verdict)
    : [];
  const count = (v: string) => verdicts.filter((x) => x === v).length;
  // Summed on read, for the reason the map exists: one pass may buy more
  // than one round, and an operator asking what diagnosis cost means all of
  // it. Null rather than 0 when nothing was spent — nothing bought and
  // something bought for free are different facts, and only one of them has
  // ever happened.
  const spent = Object.values((row.repair_costs ?? {}) as Record<string, number | null>).filter(
    (v): v is number => typeof v === "number",
  );
  return {
    taskId: row.task_id,
    project: row.project,
    issue: row.issue,
    title: row.title ?? `#${row.issue}`,
    kind: row.kind ?? "unknown",
    state: row.state as TaskState,
    tier: row.tier,
    runId: row.run_id,
    turns: row.turns,
    costUsd: row.cost_usd,
    passed: count("passed"),
    failed: count("failed"),
    waived: count("waived"),
    approved: count("approved"),
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
    blocked: row.blocked === true,
    needs: row.needs ?? null,
    // Written from a parsed payload and read back as it was written, so the
    // shape is the event's rather than this reader's guess about it.
    diagnosis: (row.diagnosis as BlockDiagnosis | null) ?? null,
    asked: row.asked === true,
    answer: (row.answer as TaskCard["answer"]) ?? null,
    awaitingSha: row.awaiting_sha,
    awaitingApproval: row.awaiting_sha !== null,
    repairPending: row.repair_pending === true,
    repairCostUsd: spent.length > 0 ? spent.reduce((a, b) => a + b, 0) : null,
  };
}

/** A `finding_backlog` row → a backlog entry. Unchanged from `readBacklog`. */
function toEntry(row: pg.QueryResultRow): BacklogEntry {
  return {
    key: row.key,
    project: row.project,
    issue: row.issue,
    taskId: row.task_id,
    runId: row.run_id,
    gate: row.gate,
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
  };
}

export interface PostgresProjectionStoreOptions {
  /** Pooled connection. Transaction mode is fine: a transaction is one checkout. */
  url?: string;
  /** Connections. Two is enough for a runner: one transaction and one read. */
  max?: number;
}

export function createPostgresProjectionStore(
  options: PostgresProjectionStoreOptions = {},
): ProjectionStore {
  const pool = new pg.Pool({ connectionString: options.url ?? postgresUrl(), max: options.max ?? 2 });

  return {
    async transact(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await fn(ctxFor(client));
        await client.query("commit");
        return result;
      } catch (err) {
        await client.query("rollback").catch(() => {
          // The connection is already gone; the transaction died with it.
        });
        throw err;
      } finally {
        client.release();
      }
    },

    async checkpoint(name) {
      const r = await pool.query<{ last_seq: string }>(
        "select last_seq::text as last_seq from checkpoints where name = $1",
        [name],
      );
      return BigInt(r.rows[0]?.last_seq ?? "0");
    },

    async advance(ctx, name, seq) {
      await ctx.query(ADVANCE_CHECKPOINT, [name, seq.toString()]);
    },

    async register(ctx, name) {
      await ctx.query(REGISTER_CHECKPOINT, [name]);
    },

    async rewind(ctx, name) {
      await ctx.query(RESET_CHECKPOINT, [name]);
    },

    async columnsOf(tables) {
      const live = new Map<string, ReadonlySet<string>>();
      if (tables.length === 0) return live;
      const r = await pool.query<{ table_name: string; column_name: string }>(
        `select table_name, column_name from information_schema.columns
         where table_schema = current_schema() and table_name = any($1::text[])`,
        [[...tables]],
      );
      for (const row of r.rows) {
        const set = (live.get(row.table_name) as Set<string> | undefined) ?? new Set<string>();
        set.add(row.column_name);
        live.set(row.table_name, set);
      }
      return live;
    },

    async lag(name) {
      const r = await pool.query<{ last_seq: string; head_seq: string; updated_at: Date | null }>(
        `select coalesce(c.last_seq, 0)::text as last_seq,
                (select coalesce(max(seq), 0) from events)::text as head_seq,
                c.updated_at
         from (select 1) one
         left join checkpoints c on c.name = $1`,
        [name],
      );
      const row = r.rows[0];
      const lastSeq = BigInt(row?.last_seq ?? "0");
      const headSeq = BigInt(row?.head_seq ?? "0");
      return { name, lastSeq, headSeq, lag: headSeq - lastSeq, updatedAt: row?.updated_at ?? null };
    },

    async lags(): Promise<ProjectionLag[]> {
      const r = await pool.query<{
        name: string;
        last_seq: string;
        head_seq: string;
        updated_at: Date | null;
      }>(
        `select c.name,
                c.last_seq::text as last_seq,
                (select coalesce(max(seq), 0) from events)::text as head_seq,
                c.updated_at
         from checkpoints c
         order by c.name`,
      );
      return r.rows.map((row) => {
        const lastSeq = BigInt(row.last_seq);
        const headSeq = BigInt(row.head_seq);
        return { name: row.name, lastSeq, headSeq, lag: headSeq - lastSeq, updatedAt: row.updated_at };
      });
    },

    async tasks(query: TaskQuery) {
      const args: unknown[] = [query.retentionDays];
      let where = `where (t.closed_at is null or t.closed_at > now() - ($1 || ' days')::interval)`;
      if (query.project) {
        args.push(query.project);
        where += ` and t.project = $2`;
      }

      const r = await pool.query(
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
      );
      return r.rows.map(toCard);
    },

    async taskProjects(query) {
      const r = await pool.query<{ project: string }>(
        `select distinct project
         from task_view
         where (closed_at is null or closed_at > now() - ($1 || ' days')::interval)
         order by project`,
        [query.retentionDays],
      );
      return r.rows.map((row) => row.project);
    },

    async backlog(query: BacklogQuery) {
      const where: string[] = [];
      const args: unknown[] = [];
      for (const [column, value] of [
        ["project", query.project],
        ["status", query.status],
        ["key", query.key],
      ] as const) {
        if (value === undefined) continue;
        args.push(value);
        where.push(`${column} = $${args.length}`);
      }
      try {
        const r = await pool.query(
          `select * from finding_backlog
           ${where.length > 0 ? `where ${where.join(" and ")}` : ""}
           order by project, raised_seq`,
          args,
        );
        return r.rows.map(toEntry);
      } catch (err) {
        // A database no projector has ever started has no table, and that is an
        // empty backlog rather than a failure.
        if ((err as { code?: string }).code === "42P01") return [];
        throw err;
      }
    },

    async close() {
      await pool.end();
    },
  };
}
