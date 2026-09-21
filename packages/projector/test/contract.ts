/**
 * What a `ProjectionStore` is, stated once and run against every implementation.
 *
 * **This file is why there can be two of them** (#219). An interface with one
 * implementation is a shape; an interface with two and no contract is a pair of
 * codebases that agree until the day they do not. So the behaviours are written
 * down here, once, and both stores are run against them:
 *
 * - `test/projection.test.ts` runs it against Postgres, where a database is
 *   available. That run is what says the real `task_view` answers this way.
 * - `pure/sqlite.test.ts` runs it against `createSqliteProjectionStore`, where
 *   none is. That run is what says a laptop with nothing installed gets the
 *   same board.
 *
 * It is written against **properties, not a database** — the rule that let
 * `event-store/test/contract.ts` be passed unchanged by a store written months
 * later (#178). Nothing here names a dialect, a connection or a driver. What it
 * names is the five things the ticket does: read the checkpoint, apply a batch
 * atomically, rebuild from zero, read for the board, and two clients racing.
 *
 * **The log is the caller's.** A store answers *how far behind the log am I*,
 * and which log that is depends on the database it shares — Postgres's
 * `events`, or the same file the SQLite log is in. So `lag` is asserted as a
 * relation between the checkpoint and whatever head the fixture's store can
 * see, and never as an absolute.
 */
import { describe, expect, it } from "vitest";
import type { Envelope } from "@lingtai/domain";
import type { EventStore, Waker } from "@lingtai/event-store";
import { backlogProjection } from "../src/backlog.ts";
import { createProjectionRunner } from "../src/projection.ts";
import type { Projection, ProjectionStore } from "../src/store.ts";
import { taskViewProjection } from "../src/task-view.ts";

/**
 * The subject of the runner assertions: a projection that exists only here.
 *
 * Owned by the contract for the reason `projection.test.ts` owns its own —
 * those tests are about the *machinery*, and borrowing a real projection
 * couples them to something that may be deleted. It also keeps the rebuild
 * cheap: a replay costs the log's length, and this one writes on one event
 * type.
 */
export const CONTRACT_TABLE = "projection_contract_touches";

/**
 * Everything this contract leaves in a database it does not own.
 *
 * A caller running it against a shared Postgres removes these when it is done;
 * a stale checkpoint is not litter but a projection `lingtai doctor` reports as
 * thousands of events behind.
 */
export const CONTRACT_TABLES = [CONTRACT_TABLE] as const;
export const CONTRACT_CHECKPOINTS = [
  CONTRACT_TABLE,
  "projection_contract_ledger",
] as const;

export const contractProjection: Projection = {
  name: CONTRACT_TABLE,

  async create(ctx) {
    await ctx.query(
      `create table if not exists ${CONTRACT_TABLE} (
         seq     bigint primary key,
         run_id  text not null,
         path    text not null
       )`,
    );
  },

  async reset(ctx) {
    await ctx.query(`drop table if exists ${CONTRACT_TABLE}`);
  },

  async apply(events, ctx) {
    for (const event of events) {
      if (event.type !== "RunTouchedFile") continue;
      const d = event.data as { path: string };
      // Keyed on `seq`, which is what makes a replay and a second projector
      // land on the same table: `do nothing` is the cheap idempotence the
      // interface asks every fold for.
      await ctx.query(
        `insert into ${CONTRACT_TABLE} (seq, run_id, path) values ($1::bigint, $2, $3)
         on conflict (seq) do nothing`,
        [event.seq.toString(), event.streamId, d.path],
      );
    }
  },
};

/**
 * A waker that never wakes anybody.
 *
 * Every assertion here appends first and starts a runner afterwards, so what is
 * under test is the catch-up read and never the nudge — and what a nudge is
 * belongs to the *log*, which this contract deliberately does not name.
 * `wake-contract.ts` is where a waker is held to anything.
 */
export const IDLE_WAKER: Waker = {
  open: () => ({ ready: Promise.resolve(), close() {} }),
};

export interface ProjectionFixture {
  /** The store under test. */
  store: ProjectionStore;
  /** A second store over the same tables — what "two clients" means. */
  another(): Promise<ProjectionStore>;
  /** The log the fold reads. Whatever log the fixture's store shares a database with. */
  events: EventStore;
  /**
   * A stream id nothing else in the log uses, handed back after whatever
   * cleans up has been told about it.
   */
  stream(kind: "wi" | "run", suffix: string): string;
  /** A project name nothing else in the database uses. */
  project: string;
  /** Closes everything this fixture opened. Never the tables. */
  close(): Promise<void>;
}

const touched = (path: string) => ({
  type: "RunTouchedFile",
  actor: "conductor",
  data: { path, op: "write" as const },
});

const claimed = (runId: string, title: string) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId, worker: "contract:1", title, kind: "tech-debt" },
});

const started = (workItemId: string) => ({
  type: "RunStarted",
  actor: "conductor",
  data: {
    workItemId,
    runtime: "claude-code" as const,
    model: "test",
    promptVersion: "1",
    baseSha: "0".repeat(40),
    configHash: "c0ffee",
    worktree: "/tmp/contract",
    invocation: null,
  },
});

const gatePassed = (runId: string, findings: unknown[] = []) => ({
  type: "GatePassed",
  actor: "conductor",
  data: {
    gate: "proposed" as const,
    action: "build",
    runId,
    onSha: "a".repeat(40),
    evidence: "green",
    findings,
  },
});

const blocked = (question: string) => ({
  type: "WorkItemBlocked",
  actor: "conductor",
  data: {
    question,
    needsFrom: "human" as const,
    runId: null,
    needs: "judgement" as const,
    diagnosis: { what: "the branch does not merge", done: null, raw: null, recommendation: null },
  },
});

const minor = {
  file: "packages/projector/src/store.ts",
  line: 12,
  claim: "the interface has no second implementation",
  failureScenario: "a machine with no Postgres has no board",
  severity: "minor" as const,
};

export function describeProjectionStoreContract(
  name: string,
  make: () => Promise<ProjectionFixture>,
): void {
  /** Rows of the contract's own table, through whatever store is under test. */
  const touches = (f: ProjectionFixture, runId: string): Promise<{ path: string }[]> =>
    f.store.transact((ctx) =>
      ctx.query<{ path: string }>(
        `select path from ${CONTRACT_TABLE} where run_id = $1 order by seq`,
        [runId],
      ),
    );

  const made = async (
    f: ProjectionFixture,
    projection: Projection,
    events: readonly Envelope[],
  ): Promise<void> => {
    await f.store.transact((ctx) => projection.create(ctx));
    await f.store.transact((ctx) => projection.apply(events, ctx));
  };

  describe(`${name}: the projection store contract`, () => {
    // ------------------------------------------------- read the checkpoint ----

    it("says zero about a projection nobody has run", async () => {
      const f = await make();
      try {
        expect(await f.store.checkpoint("projection_contract_never_started")).toBe(0n);
      } finally {
        await f.close();
      }
    });

    it("registers a checkpoint at zero, and never moves one that has read", async () => {
      // The reason `register` is not `advance(0)`: a projection with nothing to
      // do must be distinguishable from one nobody ever started, and restarting
      // one that has read must not rewind it.
      const f = await make();
      const n = "projection_contract_ledger";
      try {
        await f.store.transact((ctx) => f.store.register(ctx, n));
        expect(await f.store.checkpoint(n)).toBe(0n);

        await f.store.transact((ctx) => f.store.advance(ctx, n, 7n));
        expect(await f.store.checkpoint(n)).toBe(7n);

        await f.store.transact((ctx) => f.store.register(ctx, n));
        expect(await f.store.checkpoint(n)).toBe(7n);

        // And `rewind` is the one thing that does move it back, which is what
        // makes a rebuild a replay rather than a repair.
        await f.store.transact((ctx) => f.store.rewind(ctx, n));
        expect(await f.store.checkpoint(n)).toBe(0n);
      } finally {
        await f.close();
      }
    });

    it("reports a checkpoint's lag against the head it can see", async () => {
      const f = await make();
      const n = "projection_contract_ledger";
      try {
        await f.store.transact((ctx) => f.store.advance(ctx, n, 3n));

        const lag = await f.store.lag(n);
        expect(lag.name).toBe(n);
        expect(lag.lastSeq).toBe(3n);
        expect(lag.lag).toBe(lag.headSeq - lag.lastSeq);
        expect(lag.updatedAt).toBeInstanceOf(Date);

        // And the same fact, found rather than asked for: this is what
        // `lingtai doctor` reports, and a projection missing from it is one
        // nobody can see has stopped.
        const all = await f.store.lags();
        expect(all.find((l) => l.name === n)?.lastSeq).toBe(3n);
      } finally {
        await f.close();
      }
    });

    // --------------------------------------------- apply a batch atomically ----

    it("commits a fold and its checkpoint together", async () => {
      const f = await make();
      const run = f.stream("run", "atomic");
      try {
        const written = await f.events.append(run, 0, [touched("a.ts"), touched("b.ts")]);
        await f.store.transact(async (ctx) => {
          await contractProjection.create(ctx);
          await contractProjection.apply(written, ctx);
          await f.store.advance(ctx, CONTRACT_TABLE, written[1]!.seq);
        });

        expect((await touches(f, run)).map((r) => r.path)).toEqual(["a.ts", "b.ts"]);
        expect(await f.store.checkpoint(CONTRACT_TABLE)).toBe(written[1]!.seq);
      } finally {
        await f.close();
      }
    });

    it("leaves neither the rows nor the checkpoint behind when the fold throws", async () => {
      // The whole correctness argument in one assertion. A crash between the
      // writes and the checkpoint either loses a batch or applies it twice; the
      // only way out is that there is no "between".
      const f = await make();
      const run = f.stream("run", "rollback");
      try {
        const first = await f.events.append(run, 0, [touched("kept.ts")]);
        await f.store.transact(async (ctx) => {
          await contractProjection.create(ctx);
          await contractProjection.apply(first, ctx);
          await f.store.advance(ctx, CONTRACT_TABLE, first[0]!.seq);
        });

        const second = await f.events.append(run, 1, [touched("lost.ts")]);
        await expect(
          f.store.transact(async (ctx) => {
            await contractProjection.apply(second, ctx);
            await f.store.advance(ctx, CONTRACT_TABLE, second[0]!.seq);
            throw new Error("the fold changed its mind");
          }),
        ).rejects.toThrow("changed its mind");

        expect((await touches(f, run)).map((r) => r.path)).toEqual(["kept.ts"]);
        expect(await f.store.checkpoint(CONTRACT_TABLE)).toBe(first[0]!.seq);
      } finally {
        await f.close();
      }
    });

    // ------------------------------------------------------ rebuild from zero ----

    it("rebuilds to the same table it built incrementally", async () => {
      // What makes a projection's shape free to change: changing one costs a
      // replay, not a migration. `lingtai projection rebuild <name>` is this.
      const f = await make();
      const run = f.stream("run", "rebuild");
      try {
        await f.events.append(run, 0, [touched("one.ts"), touched("two.ts")]);
        const runner = createProjectionRunner({
          projection: contractProjection,
          store: f.events,
          into: f.store,
          waker: IDLE_WAKER,
        });
        await runner.start();
        const incremental = await touches(f, run);
        const caughtUp = await f.store.checkpoint(CONTRACT_TABLE);
        expect(incremental.map((r) => r.path)).toEqual(["one.ts", "two.ts"]);

        await runner.rebuild();

        expect(await touches(f, run)).toEqual(incremental);
        expect(await f.store.checkpoint(CONTRACT_TABLE)).toBe(caughtUp);
        await runner.close();
      } finally {
        await f.close();
      }
    });

    it("drops what the DDL made, so a shape that changed can be replayed into", async () => {
      // `reset` removes rather than empties. Truncating kept the old columns
      // for ever, and the runner then died on the first write to a column the
      // table did not have — reported as "stopped before it caught up", which
      // names nothing.
      const f = await make();
      try {
        await f.store.transact((ctx) => contractProjection.create(ctx));
        expect((await f.store.columnsOf([CONTRACT_TABLE])).has(CONTRACT_TABLE)).toBe(true);

        await f.store.transact((ctx) => contractProjection.reset(ctx));
        expect((await f.store.columnsOf([CONTRACT_TABLE])).has(CONTRACT_TABLE)).toBe(false);
      } finally {
        await f.close();
      }
    });

    it("names the columns a table has, and leaves out one that is not there", async () => {
      // The catalogue read behind the shape check (#84). It has to say *absent*
      // rather than *drifted* about a table `create` has not made yet.
      const f = await make();
      try {
        await f.store.transact((ctx) => contractProjection.create(ctx));

        const live = await f.store.columnsOf([CONTRACT_TABLE, "projection_contract_absent"]);
        expect([...(live.get(CONTRACT_TABLE) ?? [])].sort()).toEqual(["path", "run_id", "seq"]);
        expect(live.has("projection_contract_absent")).toBe(false);
      } finally {
        await f.close();
      }
    });

    // ------------------------------------------------------ read for the board ----

    it("hands the board a card with the run's own verdicts on it", async () => {
      const f = await make();
      const task = f.stream("wi", "41");
      const run = f.stream("run", "card");
      try {
        const written = [
          ...(await f.events.append(task, 0, [claimed(run, "a card the board renders")])),
          ...(await f.events.append(run, 0, [gatePassed(run)])),
        ];
        await made(f, taskViewProjection, written);

        const cards = await f.store.tasks({ project: f.project, retentionDays: 3650 });
        expect(cards).toHaveLength(1);
        const card = cards[0]!;
        expect(card.taskId).toBe(task);
        expect(card.project).toBe(f.project);
        expect(card.title).toBe("a card the board renders");
        expect(card.kind).toBe("tech-debt");
        expect(card.state).toBe("running");
        expect(card.runId).toBe(run);
        expect(card.attempts).toBe(1);
        // The gates column is a map keyed by the run, so a card counts the
        // verdicts of the attempt it names and of no other (#78).
        expect(card.gatesPassed).toBe(1);
        expect(card.gatesFailed).toBe(0);
        expect(card.updatedAt).toBeInstanceOf(Date);
        expect(card.closedAt).toBeNull();
        expect(card.blocked).toBe(false);
        expect(card.awaitingApproval).toBe(false);
        expect(card.repairCostUsd).toBeNull();

        expect(await f.store.taskProjects({ retentionDays: 3650 })).toContain(f.project);
      } finally {
        await f.close();
      }
    });

    it("hands the board what a person is being asked, and what was diagnosed", async () => {
      // The other half of a card's shape: the flags and the payload column. A
      // store that lost either would render a hold as an ordinary wait.
      const f = await make();
      const task = f.stream("wi", "42");
      try {
        const written = await f.events.append(task, 0, [blocked("which base branch?")]);
        await made(f, taskViewProjection, written);

        const card = (await f.store.tasks({ project: f.project, retentionDays: 3650 }))[0]!;
        expect(card.state).toBe("waiting");
        expect(card.note).toBe("which base branch?");
        expect(card.blocked).toBe(true);
        expect(card.asked).toBe(true);
        expect(card.needs).toBe("judgement");
        expect(card.diagnosis?.what).toBe("the branch does not merge");
        expect(card.diagnosis?.done).toBeNull();
      } finally {
        await f.close();
      }
    });

    it("hands the backlog the minors a passing gate raised, and filters them", async () => {
      const f = await make();
      const task = f.stream("wi", "43");
      const run = f.stream("run", "backlog");
      try {
        const written = await f.events.append(run, 0, [started(task), gatePassed(run, [minor])]);
        await made(f, backlogProjection, written);

        const entries = await f.store.backlog({ project: f.project });
        expect(entries).toHaveLength(1);
        const entry = entries[0]!;
        expect(entry.issue).toBe("43");
        expect(entry.taskId).toBe(task);
        expect(entry.runId).toBe(run);
        expect(entry.gate).toBe("proposed");
        expect(entry.action).toBe("build");
        expect(entry.severity).toBe("minor");
        expect(entry.claim).toBe(minor.claim);
        expect(entry.line).toBe(12);
        expect(entry.status).toBe("open");
        expect(entry.decidedBy).toBeNull();
        expect(entry.raisedAt).toBeInstanceOf(Date);
        expect(entry.raisedSeq).toBe(written[1]!.seq.toString());

        expect(await f.store.backlog({ project: f.project, key: entry.key })).toEqual(entries);
        expect(await f.store.backlog({ project: f.project, status: "declined" })).toEqual([]);
      } finally {
        await f.close();
      }
    });

    it("reads an empty board rather than failing, when nothing has been folded", async () => {
      const f = await make();
      try {
        expect(await f.store.tasks({ project: `${f.project}-nobody`, retentionDays: 3650 })).toEqual(
          [],
        );
        expect(await f.store.backlog({ project: `${f.project}-nobody` })).toEqual([]);
      } finally {
        await f.close();
      }
    });

    // ------------------------------------------------------ two clients racing ----

    it("converges when two projectors follow one log", async () => {
      // 0022: every process that appends holds a projector, so two of them on
      // one log is the ordinary case and not an edge. What makes it safe is the
      // fold being idempotent and the checkpoint being transactional — neither
      // of which is a property of one database, which is why it is asserted
      // here and not in one implementation's tests.
      const f = await make();
      const second = await f.another();
      const run = f.stream("run", "race");
      try {
        await f.events.append(run, 0, [touched("x.ts"), touched("y.ts"), touched("z.ts")]);
        // The table first, once. Two `create table if not exists` racing is a
        // question about the *catalogue*, which is the one database-specific
        // thing on this path and not what converging means — what is under test
        // is two folds and two checkpoints over one log.
        await f.store.transact(async (ctx) => {
          await contractProjection.create(ctx);
          await f.store.register(ctx, CONTRACT_TABLE);
        });

        const runners = [f.store, second].map((into) =>
          createProjectionRunner({
            projection: contractProjection,
            store: f.events,
            into,
            waker: IDLE_WAKER,
          }),
        );
        await Promise.all(runners.map((r) => r.start()));

        // Once each, not twice: both projectors read the same events and one of
        // them applied every one of them a second time.
        expect((await touches(f, run)).map((r) => r.path)).toEqual(["x.ts", "y.ts", "z.ts"]);
        expect(await f.store.checkpoint(CONTRACT_TABLE)).toBe(
          await second.checkpoint(CONTRACT_TABLE),
        );

        await Promise.all(runners.map((r) => r.close()));
      } finally {
        // Not `second.close()`: `another()` is the fixture's to open and the
        // fixture's to close.
        await f.close();
      }
    });
  });
}
