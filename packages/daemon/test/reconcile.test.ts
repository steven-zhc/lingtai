/**
 * Reconciliation, against the real store and a real directory.
 *
 * The property that matters is not "it deletes things" but **which** things: a
 * live run's worktree must survive, because deleting one is worse than leaving
 * a dead one. So the fixture has both, side by side, and the assertion is about
 * the pair.
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectRunnable } from "@lingtai/conductor/queue";
import type { ProjectState } from "@lingtai/domain";
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { createProjectionRunner, taskViewProjection } from "@lingtai/projector";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exists, findOrphans, reconcile } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;
let home: string;

const wt = (runId: string) => join(home, "worktrees", PROJECT, runId);

async function plant(runId: string): Promise<void> {
  await mkdir(wt(runId), { recursive: true });
  await writeFile(join(wt(runId), "file.txt"), "work in progress");
}

/**
 * A claim, by a named conductor. `worker` is the whole of what recovery reads
 * now (0027), so every fixture here has to say who took it.
 */
const claim = (runId: string, worker: string, title: string | null = null) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId, worker, title, kind: "bug" },
});

/** This conductor, and the one it replaced. Two pids, one at a time. */
const ME = "local:11111";
const DEAD = "local:22222";

const started = (taskId: string) => ({
  type: "RunStarted",
  actor: "conductor",
  data: {
    workItemId: taskId,
    runtime: "claude-code",
    model: "m",
    promptVersion: "p",
    baseSha: "base000",
    configHash: "c",
    worktree: "/tmp/wt",
    invocation: null,
  },
});

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  home = await mkdtemp(join(tmpdir(), "lingtai-reconcile-"));
}, 120_000);

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    for (const id of created) await c.query("delete from events where stream_id = $1", [id]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("reconciliation", () => {
  it("removes a worktree the log says is finished, and leaves a live one alone", async () => {
    const dead = `run-${PROJECT}-dead`;
    const live = `run-${PROJECT}-live`;
    const deadTask = `wi-${PROJECT}-1`;
    const liveTask = `wi-${PROJECT}-2`;
    for (const id of [dead, live, deadTask, liveTask]) created.add(id);

    // Landed: the run is over, the directory is not.
    await store.append(deadTask, 0, [
      claim(dead, ME),
      { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234", base: "develop" } },
    ]);
    await store.append(dead, 0, [started(deadTask)]);

    // Still claimed, by this conductor. An agent between tool calls looks
    // exactly like this, and deleting its worktree would be the worst thing
    // this could do.
    await store.append(liveTask, 0, [claim(live, ME)]);
    await store.append(live, 0, [started(liveTask)]);

    await plant(dead);
    await plant(live);

    const found = await reconcile({ home, store, worker: ME });

    expect(found.map((f) => f.stream)).toEqual([dead]);
    expect(found[0]!.action).toBe("removed");
    expect(await exists(wt(dead))).toBe(false);
    expect(await exists(wt(live))).toBe(true);
  });

  /**
   * The claim that used to be recovered by waiting. Its lease has not lapsed —
   * there is no lease — and the worktree is orphaned anyway, because the
   * conductor named on the claim is not the one running this pass.
   */
  it("treats a claim by another conductor as finished", async () => {
    const stale = `run-${PROJECT}-stale`;
    const staleTask = `wi-${PROJECT}-3`;
    created.add(stale);
    created.add(staleTask);

    await store.append(staleTask, 0, [claim(stale, DEAD)]);
    await store.append(stale, 0, [started(staleTask)]);
    await plant(stale);

    // Nothing about the claim itself says it is dead — the claim check works
    // that out from the lock and hands the answer over.
    expect((await findOrphans({ home, store, dryRun: true })).map((f) => f.stream)).not.toContain(
      stale,
    );

    const found = await findOrphans({
      home,
      store,
      dryRun: true,
      abandoned: new Set([staleTask]),
    });
    expect(found.map((f) => f.stream)).toContain(stale);
    // Still there: dryRun reports, it does not act. A doctor that changed what
    // it was checking would describe a state that no longer exists.
    expect(await exists(wt(stale))).toBe(true);
  });

  /**
   * A worktree whose run never said what it was for is a mystery, and deleting
   * mysteries is how you stop being able to explain them.
   */
  it("reports a worktree it cannot attribute, and does not remove it", async () => {
    const nameless = `run-${PROJECT}-nameless`;
    await plant(nameless);

    const found = await reconcile({ home, store, worker: ME });
    const it_ = found.find((f) => f.stream === nameless);

    expect(it_?.action).toBe("reported");
    expect(await exists(wt(nameless))).toBe(true);
  });

  it("appends nothing when there is nothing to say", async () => {
    const quiet = await mkdtemp(join(tmpdir(), "lingtai-quiet-"));
    const before = (await store.read("ctl-conductor")).length;

    const found = await reconcile({ home: quiet, store, worker: ME });

    expect(found).toEqual([]);
    // An empty Reconciled on every startup would be noise in the one place
    // noise is expensive.
    expect((await store.read("ctl-conductor")).length).toBe(before);
  });
});

/**
 * #87, and the reason 0027 deleted the lease.
 *
 * The timeline in the ADR: a conductor was restarted, the agent it had spawned
 * died with it, and the startup reconcile that would have noticed ran *before*
 * the lease it was consulting expired. The restart was simultaneously the act
 * that orphaned the claim and the only check for orphaned claims, so the miss
 * was structural rather than unlucky, and the ticket left circulation for good.
 *
 * The property proved here is the one that makes that impossible: **nothing is
 * waited for.** The claim is written and recovered inside the same test, with
 * no clock injected and no window to sit out, because what decides it is who
 * holds `lingtai:daemon` and not how old the claim is.
 */
describe("a conductor that replaces a dead one", () => {
  /** Its own worktree root, so the claim check is the only thing under test. */
  let quiet: string;
  beforeAll(async () => {
    quiet = await mkdtemp(join(tmpdir(), "lingtai-inherit-"));
  });

  /** The projection has to exist before the queue can subtract from it. */
  async function build(): Promise<void> {
    const runner = createProjectionRunner({ projection: taskViewProjection, store });
    try {
      await runner.start();
    } finally {
      await runner.close();
    }
  }

  it("releases the claim it inherited, and the ticket is offered on the next pass", async () => {
    const project = `esctest${crypto.randomUUID().slice(0, 6)}`;
    const projects: ProjectState[] = [
      {
        project,
        owner: "steven-zhc",
        base: "main",
        configHash: "seeded",
        fromSha: "0".repeat(40),
        version: 1,
        lastSeq: null,
      },
    ];
    const taskId = `wi-${project}-87`;
    const runId = `run-${project}-orphan`;
    created.add(taskId);
    created.add(runId);

    // The killed conductor took it and never came back. Nothing released it,
    // and nothing was ever going to. Its worktree is still on disk holding a
    // branch checked out, which is why both halves have to happen in one pass.
    await store.append(taskId, 0, [claim(runId, DEAD, "three claims, the last orphaned")]);
    await store.append(runId, 0, [started(taskId)]);
    const orphanTree = join(quiet, "worktrees", project, runId);
    await mkdir(orphanTree, { recursive: true });
    await writeFile(join(orphanTree, "file.txt"), "work in progress");
    await build();

    const offered = [{ ref: "87", title: "three claims, the last orphaned", kind: "bug" }];
    // Out of circulation: `task_view` folds a claim as `running`, and the queue
    // offers nothing that is not `queued`. `backoffMs: 0` so the only thing
    // being tested is the claim — a blind retry is 0028's subject, not this one.
    expect(await selectRunnable({ project, offered, kinds: ["bug"], backoffMs: 0 })).toEqual([]);

    // The new conductor starts. It holds the lock, so it is the only conductor,
    // so `local:22222` is dead — whatever any timestamp says.
    const found = await reconcile({ home: quiet, store, worker: ME, projects });

    const release = found.find((f) => f.stream === taskId);
    expect(release?.action).toBe("released");
    // Cites the lock, not a clock.
    expect(release?.expected).toContain("lingtai:daemon");

    // And the directory went with it, in the same pass — a worktree left
    // holding `agent/87` would stop git updating that ref on the next attempt.
    expect(found.find((f) => f.stream === runId)?.action).toBe("removed");
    expect(await exists(orphanTree)).toBe(false);

    // An appended event, never a recomputation: `rebuild task_view` replays
    // this same row and reaches the same answer, which it could not do if
    // `queued` were a function of the current time.
    const types = (await store.read(taskId)).map((e) => e.type);
    expect(types).toEqual(["WorkItemClaimed", "WorkItemReleased"]);

    await build();
    expect(
      (await selectRunnable({ project, offered, kinds: ["bug"], backoffMs: 0 })).map((r) => r.issue),
    ).toEqual(["87"]);
  });

  /** The other half of the proof: this conductor's own claims are not foreign. */
  it("leaves its own claim alone", async () => {
    const project = `esctest${crypto.randomUUID().slice(0, 6)}`;
    const projects: ProjectState[] = [
      {
        project,
        owner: "steven-zhc",
        base: "main",
        configHash: "seeded",
        fromSha: "0".repeat(40),
        version: 1,
        lastSeq: null,
      },
    ];
    const taskId = `wi-${project}-1`;
    created.add(taskId);
    await store.append(taskId, 0, [claim(`run-${project}-mine`, ME)]);

    const found = await reconcile({ home: quiet, store, worker: ME, projects });

    expect(found.find((f) => f.stream === taskId)).toBeUndefined();
    expect((await store.read(taskId)).map((e) => e.type)).toEqual(["WorkItemClaimed"]);
  });
});
