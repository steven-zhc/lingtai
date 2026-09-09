/**
 * `task_view` — the one projection.
 *
 * It replaces `board` and `queue`. One row per task Lingtai
 * has touched, holding the latest state and the metadata a card shows, and
 * nothing else: the board's list view is a `select` against this table and no
 * second query ([0012](../../../doc/decisions/0012-one-task-view.md)).
 *
 * ## What is deliberately not here
 *
 * **Gate evidence, review findings, the diff.** All of
 * it is read from the event stream when somebody opens one task. A list view
 * and a detail view have opposite economics — the list is read constantly and
 * needs to be cheap, the detail is read rarely by one person about one task,
 * and folding a few dozen events on the spot is imperceptible. Building a table
 * for the second is paying continuously for an occasional read.
 *
 * The old `board` projection carried all of it, and the card grew heavy for
 * exactly that reason: what is available gets rendered. Moving detail behind a
 * task id makes a card's contents a decision instead of a consequence.
 *
 * ## Two rules that keep a rebuild honest
 *
 * **Every timestamp comes from `event.at`, never from `now()`.** A projection
 * whose rows depend on the clock cannot be rebuilt to the same table twice,
 * which would cost the property that lets a projection's shape change freely at
 * all. That property is load-bearing here, because this table's shape is
 * expected to move.
 *
 * **Retention is the reader's job.** `closed_at` is recorded and every row is
 * kept; `readTasks` filters. The two-day window is a `where` clause, so it is
 * configurable without a rebuild and a rebuild does not depend on when it ran.
 *
 * ## Counting
 *
 * Increments are guarded by `updated_seq <` rather than `<=`, so a replay lands
 * on the same numbers. Gate verdicts are a keyed map rather than a list, for
 * the same reason: assignment is idempotent and appending is not. Only the
 * verdict is kept — the evidence that came with it is detail.
 *
 * That key includes the run (#78). Keying it `point:action` alone bought
 * replay-safety and quietly gave up scope: a second attempt overwrote the same
 * cells, and in the window between a release and the next attempt reaching the
 * same point the card asserted a verdict no live run held. `wi-lingtai-59` read
 * `1 passed · attempt 2` while attempt 1's only gate belonged to a run an
 * operator had killed hours earlier. Keying by run keeps both properties:
 * assignment is still idempotent, and `readTasks` shows only the run the card
 * names.
 */
import type { BlockDiagnosis, LabelState, PayloadOf } from "@lingtai/domain";
import { parseWorkItemStream } from "@lingtai/domain";
import { databaseUrl } from "@lingtai/env";
import type { Projection, ProjectionContext } from "./projection.ts";
import pg from "pg";

/**
 * Where a task is.
 *
 * Every one of these now comes from a fold — `queued` used to be written
 * straight into the table by `syncQueued`, with no event behind it, which is
 * why a queue change reached nobody (#56). A task is `queued` because the log
 * says it was released or unblocked, or because it has no row at all and
 * GitHub is offering it.
 */
export type TaskState = LabelState;

export const TASK_VIEW_TABLE = "task_view";

/** How long a landed task stays on the board. A query, not a rebuild. */
export const DEFAULT_RETENTION_DAYS = 2;

export const taskViewProjection: Projection = {
  name: "task_view",

  async create(ctx) {
    await ctx.query(`
      create table if not exists task_view (
        task_id      text primary key,
        project      text not null,
        issue        text not null,
        -- Null means not known yet. The reader renders the fallback, so a
        -- claim that carries no title cannot overwrite one that GitHub gave.
        title        text,
        kind         text,
        state        text not null,
        tier         text not null default 'guarded',

        run_id       text,
        turns        int,
        cost_usd     double precision,

        base_sha     text,
        head_sha     text,
        files        int,
        insertions   int,
        deletions    int,

        -- { "run-abc:proposed:build": "passed" }. A map, so replaying is
        -- assignment rather than appending; keyed by the run that produced the
        -- verdict, so an attempt that is over cannot lend its verdicts to the
        -- next one. Evidence is not here on purpose.
        gates        jsonb not null default '{}'::jsonb,

        -- One line for the card: what it is waiting on, or why it stopped.
        note         text,

        -- The sha the open question is about, and null when nothing is being
        -- asked. Written from ApprovalRequested.onSha, which is the value
        -- approve() compares a caller's onSha against.
        --
        -- Not head_sha. That one is what the last run *produced*, and it is a
        -- different fact: the two agree right up until a branch is repaired and
        -- approval re-requested on a new head, and then the board sent the
        -- produced sha, approve() refused it as stale, and the same approval
        -- through the CLI — which sends no sha at all — landed. Two answers to
        -- one question (#92).
        --
        -- Whether a person is being asked something is read off this rather
        -- than kept beside it: a card cannot then offer Approve without the sha
        -- Approve needs. That is the "waiting, and there is a head sha"
        -- inference #84 replaced, and this is what it should have been replaced
        -- with.
        awaiting_sha text,

        -- Which kind of hold this is: 'judgement' when the decision is
        -- genuinely a person's, 'acknowledgement' when something failed and
        -- nobody has decided what to do. Null on a block that did not say —
        -- every block written before #83 — and the card renders one of those
        -- exactly as it always did.
        needs        text,

        -- { what, done, raw, recommendation }, as WorkItemBlocked.diagnosis.
        -- One column rather than five, because it is written and cleared as one
        -- thing: a block either carries a diagnosis or does not, and half a
        -- diagnosis is not a state the card has to render.
        --
        -- Null is the common case and has to stay cheap to ask about: every
        -- block on the log right now has only a question.
        diagnosis    jsonb,

        -- Whether a person is holding a *question*, as opposed to being in the
        -- waiting lane for some other reason. The lane also holds a dispatch
        -- that was refused and a run that asked something mid-flight, and
        -- neither of those is an item anybody can hand back — offering a
        -- control that would refuse is the shape #58 records and #84 must not
        -- reintroduce.
        blocked      boolean not null default false,

        -- A repair bought and not yet claimed. It exempts the row from the
        -- queue's backoff: that guard exists to stop *blind* retries, and a
        -- repair is told what went wrong and bounded by construction (0025 §3).
        repair_pending boolean not null default false,
        -- Which run is the repair, so its spend is counted apart from the
        -- work's. Set by the claim that consumes repair_pending.
        repair_run_id  text,
        -- { "run-abc": 1.42 }. A map for the reason the gates column is one:
        -- assignment replays to the same number and += does not.
        repair_costs   jsonb not null default '{}'::jsonb,

        -- Retention and ordering. From the event's own clock, never now().
        updated_at   timestamptz not null,
        closed_at    timestamptz,

        -- The backoff #43 needs. In the table rather than in memory, because an
        -- in-memory set forgets on restart and the loop it prevents costs money:
        -- the old harness re-ran two tickets five times for roughly $29.
        attempts        int not null default 0,
        last_attempt_at timestamptz,

        updated_seq  bigint not null
      )`);
    await ctx.query("create index if not exists task_view_state_idx on task_view (project, state)");
    await ctx.query("create index if not exists task_view_closed_idx on task_view (closed_at)");

    // Which run belongs to which task. Run events arrive on their own stream and
    // name the task only at WorkItemClaimed or RunStarted.
    await ctx.query(`
      create table if not exists task_view_run (
        run_id  text primary key,
        task_id text not null
      )`);
  },

  async reset(ctx) {
    // Dropped, not truncated. This table's shape is expected to change, and
    // `create table if not exists` would silently keep the old columns.
    await ctx.query("drop table if exists task_view");
    await ctx.query("drop table if exists task_view_run");
  },

  async apply(events, ctx) {
    for (const event of events) {
      const seq = event.seq.toString();
      const at = event.at;

      switch (event.type) {

        // ---- the task's own stream ----

        /**
         * Still handled, though nothing appends it any more (#41): the queue is
         * read from GitHub now. Logs written before that change still contain
         * these, and a projection that cannot replay its own history is not a
         * projection.
         */
        case "WorkItemDiscovered": {
          const d = event.data as PayloadOf<"WorkItemDiscovered">;
          await upsert(ctx, event.streamId, seq, at, {
            project: d.project,
            issue: d.externalRef,
            title: d.title,
            kind: d.kind,
            state: "queued",
          });
          break;
        }

        case "WorkItemClaimed": {
          const d = event.data as PayloadOf<"WorkItemClaimed">;
          await linkRun(ctx, d.runId, event.streamId);
          // The claim creates the row, not just updates it. With the queue out
          // of the log there is no earlier event to have made one, so an UPDATE
          // here would leave every running and landed task with no row after a
          // rebuild — they would vanish from the board, and GitHub could not
          // supply them because it only lists what is still open.
          const { project, issue } = splitTaskId(event.streamId);
          // One statement, counting the attempt as it goes. Two statements
          // cannot work here: whichever runs first writes `updated_seq = seq`,
          // and the second is guarded on `updated_seq` being lower, so the
          // counter silently never moves. That is exactly the shape of bug
          // that leaves a backoff looking implemented and doing nothing.
          await upsert(ctx, event.streamId, seq, at, {
            project,
            issue,
            title: d.title,
            kind: d.kind,
            state: "running",
            runId: d.runId,
            attempt: true,
          });
          break;
        }

        case "WorkItemReleased": {
          const d = event.data as PayloadOf<"WorkItemReleased">;
          // The reason becomes the card's line. A release is an attempt that
          // ended without landing, and it used to leave no mark at all: a run
          // killed from outside fails no gate, so the card came back to Queued
          // with nothing to say and read like work nobody had started (#78).
          // Clearing `run_id` is also what scopes the gate pills — the card no
          // longer names a run, so it shows no verdicts.
          await set(ctx, event.streamId, seq, at, {
            state: "queued",
            run_id: null,
            note: d.reason,
            blocked: false,
            needs: null,
            diagnosis: null,
          });
          break;
        }

        case "WorkItemBlocked": {
          const d = event.data as PayloadOf<"WorkItemBlocked">;
          // The question is still the card's line, unchanged. What the block
          // now *may* carry beside it is which kind of hold it is and a
          // diagnosis; both are null on every block written before #83, and a
          // null one leaves the row exactly as this case has always left it.
          await set(ctx, event.streamId, seq, at, {
            state: "waiting",
            note: d.question,
            blocked: true,
            needs: d.needs,
            diagnosis: d.diagnosis === null ? null : JSON.stringify(d.diagnosis),
          });
          break;
        }

        case "WorkItemUnblocked":
          await set(ctx, event.streamId, seq, at, {
            state: "queued",
            note: null,
            awaiting_sha: null,
            blocked: false,
            // The hold is answered, so the diagnosis of it goes with the
            // question. Leaving it would put last week's failure on a card
            // nobody is being asked about.
            needs: null,
            diagnosis: null,
          });
          break;

        /**
         * A failure bought an agent. The row is still `running` here — the
         * release that follows moves it to `queued` and writes the note — so
         * the only thing to record is the exemption from the backoff.
         */
        case "RepairRequested":
          await set(ctx, event.streamId, seq, at, { repair_pending: true });
          break;

        case "WorkItemLanded": {
          const d = event.data as PayloadOf<"WorkItemLanded">;
          await set(ctx, event.streamId, seq, at, {
            state: "landed",
            note: d.mergeCommit,
            closed_at: at,
            awaiting_sha: null,
            blocked: false,
            // Landed answers whatever was being held. A diagnosis that outlived
            // the merge would be a failure reported on finished work.
            needs: null,
            diagnosis: null,
          });
          break;
        }

        case "DispatchRefused": {
          const d = event.data as PayloadOf<"DispatchRefused">;
          // An upsert, because this can be a task's first event: it refuses
          // before anything is claimed, and nothing is appended when an issue
          // is merely seen. An UPDATE would leave the refusal unreadable, which
          // is the failure it exists to report.
          const { project: p, issue: i } = splitTaskId(event.streamId);
          await upsert(ctx, event.streamId, seq, at, {
            project: p,
            issue: i,
            title: null,
            kind: null,
            state: "waiting",
          });
          await set(ctx, event.streamId, seq, at, {
            note: `needs ${d.requiredTier}; ${d.runtime} is missing ${d.missing.join(", ")}`,
          });
          break;
        }

        // ---- the run's stream ----

        case "RunStarted": {
          const d = event.data as PayloadOf<"RunStarted">;
          await linkRun(ctx, event.streamId, d.workItemId);
          await viaRun(ctx, event.streamId, seq, at, {
            state: "running",
            run_id: event.streamId,
            base_sha: d.baseSha,
          });
          break;
        }


        case "RunAwaitingInput": {
          const d = event.data as PayloadOf<"RunAwaitingInput">;
          await viaRun(ctx, event.streamId, seq, at, { state: "waiting", note: d.prompt });
          break;
        }

        case "RunProducedDiff": {
          const d = event.data as PayloadOf<"RunProducedDiff">;
          await viaRun(ctx, event.streamId, seq, at, {
            head_sha: d.headSha,
            files: d.files,
            insertions: d.insertions,
            deletions: d.deletions,
          });
          break;
        }

        case "RunProposedCompletion": {
          const d = event.data as PayloadOf<"RunProposedCompletion">;
          await viaRun(ctx, event.streamId, seq, at, { state: "gates", head_sha: d.headSha });
          break;
        }

        /**
         * Turns and cost — and a repair's cost is not the work's.
         *
         * "An operator must be able to see what diagnosis is costing them"
         * (#84), which a single `cost_usd` cannot say: a default-on agent whose
         * spend is folded into the number beside it is an invisible bill. So a
         * run that is this item's repair writes into `repair_costs` and leaves
         * `cost_usd` alone, and the card shows the two apart.
         *
         * One statement rather than a read-then-write, because which of the two
         * columns to write is a fact the row holds and the projector does not.
         */
        case "RunFinished": {
          const d = event.data as PayloadOf<"RunFinished">;
          await viaRunQuery(
            ctx,
            event.streamId,
            `update task_view
             set turns = $4::int,
                 cost_usd = case when repair_run_id = $5 then cost_usd else $6::double precision end,
                 repair_costs = case when repair_run_id = $5
                                     then repair_costs || jsonb_build_object($5::text, $6::double precision)
                                     else repair_costs end,
                 updated_at = $3,
                 updated_seq = $2::bigint
             where task_id = $1 and updated_seq <= $2::bigint`,
            [seq, at, d.turns, event.streamId, d.costUsd],
          );
          break;
        }

        case "RunFailed": {
          const d = event.data as PayloadOf<"RunFailed">;
          await viaRun(ctx, event.streamId, seq, at, {
            state: "waiting",
            note: `${d.kind}: ${d.detail}`,
          });
          break;
        }

        case "GatePassed":
        case "GateFailed":
        case "GateWaived":
        case "ApprovalRequested":
        case "ApprovalGranted":
        case "ApprovalRevoked": {
          // Keyed `run:point:action`. The point is there because two points can
          // run an action of the same name; the run is there because two
          // attempts can run the same point, and without it the second silently
          // inherited the first's verdicts (#78).
          const d = event.data as { gate: string; action: string; onSha: string; question?: string };
          const verdict = VERDICT[event.type];
          if (verdict) await setGate(ctx, event.streamId, seq, at, `${d.gate}:${d.action}`, verdict);
          if (event.type === "ApprovalRequested") {
            await viaRun(ctx, event.streamId, seq, at, {
              state: "waiting",
              note: (event.data as PayloadOf<"ApprovalRequested">).question,
              // The card may offer Approve, and this is the sha it must send:
              // the one the run is asking about, not the one it produced. A
              // re-request on a repaired head moves this and leaves `head_sha`
              // where it was, which is the divergence #92 is about.
              awaiting_sha: d.onSha,
            });
          }
          // Granted spends it; revoked opens it again — the run reducer says the
          // same, and the card has to agree with the thing that will refuse it.
          if (event.type === "ApprovalGranted") {
            await viaRun(ctx, event.streamId, seq, at, { awaiting_sha: null });
          }
          if (event.type === "ApprovalRevoked") {
            // On the sha the withdrawal names, which is the one the reducer puts
            // the run back to awaiting.
            await viaRun(ctx, event.streamId, seq, at, { awaiting_sha: d.onSha });
          }
          break;
        }

        // ---- the integration lane ----

        case "IntegrationRefused": {
          const d = event.data as PayloadOf<"IntegrationRefused">;
          await set(ctx, d.workItemId, seq, at, {
            state: "waiting",
            note: `${d.reason}: ${d.detail}`,
            // The approval, if there was one, has been spent on this attempt.
            // The run is back to `gating` and `approve()` refuses it — so the
            // card must stop offering a button that cannot work (#84).
            awaiting_sha: null,
          });
          break;
        }

        case "IntegrationSucceeded": {
          const d = event.data as PayloadOf<"IntegrationSucceeded">;
          await set(ctx, d.workItemId, seq, at, {
            state: "landed",
            note: d.mergeCommit,
            closed_at: at,
            awaiting_sha: null,
            blocked: false,
            // Landed answers whatever was being held. A diagnosis that outlived
            // the merge would be a failure reported on finished work.
            needs: null,
            diagnosis: null,
          });
          break;
        }

        default:
          break;
      }
    }
  },
};

/**
 * What a card counts a gate event as.
 *
 * Six events, five verdicts, and the distinctions are the point. `waived` and
 * `approved` used to both be `passed`, which made a person overriding a red
 * build indistinguishable from a green one — the distinction a waiver records
 * who and why for (#78). A machine ran it and it went green, a machine ran it
 * and it went red, and a person said so anyway are three different facts.
 */
const VERDICT: Record<string, string> = {
  GatePassed: "passed",
  GateFailed: "failed",
  GateWaived: "waived",
  ApprovalRequested: "pending",
  ApprovalGranted: "approved",
  ApprovalRevoked: "pending",
};

// ----------------------------------------------------------------- write ----

/**
 * `wi-nextloom-ai-admin-155` → project `nextloom-ai-admin`, issue `155`.
 *
 * Safe to parse because the same code writes it (`wi-${project}-${ref}`), and
 * splitting at the *last* hyphen is what makes a project name containing
 * hyphens survive — which every one of them does.
 */
function splitTaskId(taskId: string): { project: string; issue: string } {
  // A projection must fold anything the log holds, including an id it cannot
  // parse — hence the fallback rather than a null the caller has to handle.
  return parseWorkItemStream(taskId) ?? { project: taskId.replace(/^wi-/, ""), issue: "" };
}

async function linkRun(ctx: ProjectionContext, runId: string, taskId: string): Promise<void> {
  await ctx.query(
    `insert into task_view_run (run_id, task_id) values ($1, $2)
     on conflict (run_id) do update set task_id = excluded.task_id`,
    [runId, taskId],
  );
}

/**
 * Creates the row if it is not there, updates it if it is.
 *
 * Needed because no single event is guaranteed to come first. Today the claim
 * always is; a projection that assumed so would break the first time a task
 * acquired an event before it — and a rebuild of a partial log has to work.
 */
async function upsert(
  ctx: ProjectionContext,
  taskId: string,
  seq: string,
  at: Date,
  values: {
    project: string;
    issue: string;
    /** Null when the caller does not know it. Never overwrites one that is known. */
    title: string | null;
    kind: string | null;
    state: TaskState;
    runId?: string;
    /** True when this event is a fresh attempt, so the backoff can count it. */
    attempt?: boolean;
  },
): Promise<void> {
  const n = values.attempt ? 1 : 0;
  await ctx.query(
    // `coalesce` in both directions: a claim that carries no title must not
    // replace a real one with `#155`, and a row created by a claim must still
    // say something. Whoever knows the title wins, in either order of arrival.
    `insert into task_view
       (task_id, project, issue, title, kind, state, run_id, attempts, last_attempt_at,
        updated_at, updated_seq)
     values ($1, $2, $3, $4, $5, $6, $9, $10, case when $10::int > 0 then $7::timestamptz end, $7, $8::bigint)
     on conflict (task_id) do update
       set title = coalesce(excluded.title, task_view.title),
           kind = coalesce(excluded.kind, task_view.kind),
           state = excluded.state,
           run_id = coalesce(excluded.run_id, task_view.run_id),
           attempts = task_view.attempts + $10::int,
           last_attempt_at = case when $10::int > 0 then excluded.updated_at else task_view.last_attempt_at end,
           note = case when $10::int > 0 then null else task_view.note end,
           -- A fresh attempt is nobody's question yet.
           awaiting_sha = case when $10::int > 0 then null else task_view.awaiting_sha end,
           blocked = case when $10::int > 0 then false else task_view.blocked end,
           -- And nobody's failure yet either. The diagnosis belongs to the block
           -- it explained; carrying it into the next attempt would put the last
           -- run's conflict on a card that is running.
           needs = case when $10::int > 0 then null else task_view.needs end,
           diagnosis = case when $10::int > 0 then null else task_view.diagnosis end,
           -- The claim is what consumes a pending repair, exactly as the fold
           -- in work-item.ts does: this run *is* the repair, and naming it here
           -- is what lets its spend be counted apart from the work's.
           repair_run_id = case when $10::int > 0 and task_view.repair_pending
                                then excluded.run_id else task_view.repair_run_id end,
           repair_pending = case when $10::int > 0 then false else task_view.repair_pending end,
           updated_at = excluded.updated_at,
           updated_seq = excluded.updated_seq
     where task_view.updated_seq < excluded.updated_seq`,
    [taskId, values.project, values.issue, values.title, values.kind, values.state, at, seq,
     values.runId ?? null, n],
  );
}

/**
 * Updates a row by task id.
 *
 * `updated_seq` guards a replay: events arrive in seq order, so a write carrying
 * an earlier seq is a bug rather than something to apply.
 */
async function set(
  ctx: ProjectionContext,
  taskId: string,
  seq: string,
  at: Date,
  values: Record<string, unknown>,
): Promise<void> {
  const entries = Object.entries(values);
  const sets = entries.map(([k], i) => `${k} = $${i + 4}`).join(", ");
  await ctx.query(
    `update task_view set ${sets}, updated_at = $3, updated_seq = $2::bigint
     where task_id = $1 and updated_seq <= $2::bigint`,
    [taskId, seq, at, ...entries.map(([, v]) => v)],
  );
}

/** The same, for an event that arrived on a run's stream. */
async function viaRun(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  at: Date,
  values: Record<string, unknown>,
): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>(
    "select task_id from task_view_run where run_id = $1",
    [runId],
  );
  const taskId = rows[0]?.task_id;
  // A run whose start was never seen has no row to update. That is a gap in the
  // log, not a reason to invent a task.
  if (taskId) await set(ctx, taskId, seq, at, values);
}

/**
 * The same lookup, for a write `set` cannot express.
 *
 * One case needs it: which column a run's cost lands in depends on the row's
 * own `repair_run_id`, which the projector does not know and must not read
 * separately — a read-then-write would be two statements over a value that
 * decides money, and the second could see a different row than the first.
 *
 * `$1` is the task id, `$2` the seq and `$3` the timestamp; the caller's own
 * parameters start at `$4`.
 */
async function viaRunQuery(
  ctx: ProjectionContext,
  runId: string,
  sql: string,
  values: readonly unknown[],
): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>(
    "select task_id from task_view_run where run_id = $1",
    [runId],
  );
  const taskId = rows[0]?.task_id;
  if (!taskId) return;
  await ctx.query(sql, [taskId, ...values]);
}

/**
 * Assignment into a keyed map, so replaying is idempotent without a guard.
 *
 * The run is part of the key, not just the lookup: the cell a verdict lands in
 * belongs to the attempt that produced it, so a later attempt starts on a fresh
 * set rather than overwriting a dead one. `readTasks` then shows the cells
 * belonging to the run the row names, and nothing else.
 */
async function setGate(
  ctx: ProjectionContext,
  runId: string,
  seq: string,
  at: Date,
  point: string,
  verdict: string,
): Promise<void> {
  const rows = await ctx.query<{ task_id: string }>(
    "select task_id from task_view_run where run_id = $1",
    [runId],
  );
  const taskId = rows[0]?.task_id;
  if (!taskId) return;
  const gate = `${runId}:${point}`;
  await ctx.query(
    `update task_view
     set gates = gates || jsonb_build_object($3::text, $4::text),
         updated_at = $5,
         updated_seq = greatest(updated_seq, $2::bigint)
     where task_id = $1`,
    [taskId, seq, gate, verdict, at],
  );
}


// ------------------------------------------------------------------ read ----

export interface TaskCard {
  taskId: string;
  project: string;
  issue: string;
  title: string;
  kind: string;
  state: TaskState;
  tier: string;
  runId: string | null;
  turns: number | null;
  costUsd: number | null;
  /**
   * Verdicts from the run this card names, and no other. Four counts rather
   * than two, because a person's word is not a gate's: `gatesWaived` is an
   * override of a failure and `gatesApproved` is a human answering a `human`
   * action. Counting either as passed made the card say the opposite of what
   * happened.
   */
  gatesPassed: number;
  gatesFailed: number;
  gatesWaived: number;
  gatesApproved: number;
  baseSha: string | null;
  headSha: string | null;
  files: number | null;
  insertions: number | null;
  deletions: number | null;
  note: string | null;
  updatedAt: Date;
  closedAt: Date | null;
  attempts: number;
  lastAttemptAt: Date | null;
  /**
   * Whether a person is holding a question. `waiting` says which lane the card
   * is in; this says whether there is anything on it to answer.
   */
  blocked: boolean;
  /**
   * Which kind of hold it is: a person's `judgement`, or a failure that needs
   * `acknowledgement`. Null on a block that did not say, which is every one
   * written before #83 — and a card with a null here reads as it always did.
   */
  needs: "judgement" | "acknowledgement" | null;
  /**
   * What happened, what was done about it, and what is recommended.
   *
   * Null when nobody has diagnosed it. The card and `lingtai status` read this
   * one value, which is what stops the two of them describing the same block
   * differently — the failure this repository keeps finding.
   */
  diagnosis: BlockDiagnosis | null;
  /**
   * The sha the open question is about, and null when there is none.
   *
   * This is what a control has to send, not `headSha`: `approve()` binds its
   * verdict to what the run is *asking* about, and the card was sending what
   * the run *produced* (#92). They differ the moment a branch is repaired and
   * approval re-requested on a new head.
   */
  awaitingSha: string | null;
  /**
   * Whether a person is being asked something, rather than merely left holding
   * it. `waiting` says where the card sits; this says whether Approve can work.
   *
   * Read off `awaitingSha` rather than stored beside it, so the card cannot
   * offer Approve without the sha Approve needs.
   */
  awaitingApproval: boolean;
  /** A repair bought and not yet claimed. Exempt from the queue's backoff. */
  repairPending: boolean;
  /**
   * What diagnosis has cost, apart from the work. Null when nothing has been
   * spent on one — which is most cards, and has to read as absence rather than
   * as zero.
   */
  repairCostUsd: number | null;
}

/**
 * One sentence of a hold, and which of the four it is.
 *
 * Typed parts rather than formatted lines, so the card and `lingtai status` can
 * render the same sentences differently without keeping their own copies of the
 * words. That is what #83's last condition asks for: *two places that disagree
 * about why something is blocked is the failure this repository keeps finding* —
 * so the wording is decided once, here, beside the field it is read from.
 */
export interface HoldLine {
  part: "needs" | "what" | "did" | "rec";
  text: string;
}

/**
 * What is known about a hold, in the order an operator uses it.
 *
 * Empty for a block that carries only a question — every block written before
 * #83 — which is what makes those render exactly as they did: the question is
 * the card's `note` and is not this function's business.
 *
 * `diagnosis.raw` is deliberately **not** here. It is the git output verbatim,
 * it belongs behind a disclosure rather than in a sentence, and a reader that
 * cannot collapse it should link to the log instead of pasting a hundred lines
 * into a queue listing.
 */
export function describeHold(card: Pick<TaskCard, "needs" | "diagnosis">): HoldLine[] {
  const lines: HoldLine[] = [];
  if (card.needs !== null) {
    lines.push({
      part: "needs",
      text:
        card.needs === "judgement"
          ? "your judgement is needed"
          : "a failure needs acknowledging",
    });
  }
  const d = card.diagnosis;
  if (d === null) return lines;
  lines.push({ part: "what", text: d.what });
  if (d.done !== null) lines.push({ part: "did", text: d.done });
  if (d.recommendation !== null) {
    lines.push({
      part: "rec",
      text: `recommends ${d.recommendation.action} — ${d.recommendation.why}`,
    });
  }
  return lines;
}

export interface ReadTasksOptions {
  project?: string;
  /**
   * How long a landed task stays visible. Here rather than in the projection,
   * so changing it is a different query and not a rebuild — and so a rebuild
   * does not depend on when it ran.
   */
  retentionDays?: number;
  url?: string;
}

export async function readTasks(options: ReadTasksOptions = {}): Promise<TaskCard[]> {
  const client = new pg.Client({ connectionString: options.url ?? databaseUrl() });
  await client.connect();
  try {
    const days = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const args: unknown[] = [days];
    let where = `where (t.closed_at is null or t.closed_at > now() - ($1 || ' days')::interval)`;
    if (options.project) {
      args.push(options.project);
      where += ` and t.project = $2`;
    }

    const r = await client.query(
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

    return r.rows.map((row) => {
      const gates = (row.gates ?? {}) as Record<string, string>;
      // Only the run the row names. A released row names none, so it counts
      // nothing — which is the point: between a release and the next attempt
      // reaching the same point there is no live verdict to report, and the
      // card used to report the dead one anyway (#78).
      const mine = row.run_id ? `${row.run_id as string}:` : null;
      const verdicts = mine
        ? Object.entries(gates)
            .filter(([key]) => key.startsWith(mine))
            .map(([, verdict]) => verdict)
        : [];
      const count = (v: string) => verdicts.filter((x) => x === v).length;
      // Summed on read, for the reason the map exists: one item may buy more
      // than one repair, and an operator asking what diagnosis cost means all
      // of it. Null rather than 0 when nothing was spent — no repair and a free
      // repair are different facts, and only one of them has ever happened.
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
        gatesPassed: count("passed"),
        gatesFailed: count("failed"),
        gatesWaived: count("waived"),
        gatesApproved: count("approved"),
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
        blocked: row.blocked === true,
        needs: row.needs ?? null,
        // Written from a parsed payload and read back as it was written, so the
        // shape is the event's rather than this reader's guess about it.
        diagnosis: (row.diagnosis as BlockDiagnosis | null) ?? null,
        awaitingSha: row.awaiting_sha,
        awaitingApproval: row.awaiting_sha !== null,
        repairPending: row.repair_pending === true,
        repairCostUsd: spent.length > 0 ? spent.reduce((a, b) => a + b, 0) : null,
      };
    });
  } finally {
    await client.end();
  }
}
