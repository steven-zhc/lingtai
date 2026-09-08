/**
 * `task_view`, against the real store.
 *
 * It spans all three aggregates — the task's own stream, the run's, and the
 * integration lane's — so the seed writes to all of them and the cases assert
 * what a card ends up saying.
 *
 * Two properties matter more than the rest:
 *
 * **Rebuilding changes nothing.** This is what makes the table's shape free to
 * change, and it is why every timestamp here comes from the event rather than
 * from `now()`.
 *
 * **Retention is a query.** A landed task falling out of the window must still
 * be a row. Deleting it would make the projection depend on when it last ran.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationStream } from "@lingtai/domain";
import { createProjectionRunner, readTasks, taskViewProjection } from "../src/index.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>();
let client: Db;
let store: EventStore;

const wi = (n: number) => {
  const id = `wi-${PROJECT}-${n}`;
  created.add(id);
  return id;
};
const run = (n: number) => {
  const id = `run-${PROJECT}-${n}`;
  created.add(id);
  return id;
};

const discovered = (n: number, title: string, kind = "bug") => ({
  type: "WorkItemDiscovered",
  actor: "github",
  data: {
    project: PROJECT,
    source: "github-issue" as const,
    externalRef: String(n),
    title,
    kind,
    labels: [],
  },
});

/**
 * A second run id for the same issue, so two attempts can be told apart.
 *
 * `run(n)` is one per issue, which is fine while an issue is only ever run once
 * — and the whole of #78 is what happens when it is not.
 */
const attempt = (n: number, which: string) => {
  const id = `run-${PROJECT}-${n}${which}`;
  created.add(id);
  return id;
};

const claimedWith = (runId: string) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId, worker: "w", leaseUntilMs: Date.now() + 60_000, title: null, kind: null },
});

const claimed = (n: number) => claimedWith(run(n));

const released = (runId: string, reason: string) => ({
  type: "WorkItemReleased",
  actor: "conductor",
  data: { runId, reason },
});

const KILLED = "the run was killed by an operator timeout before it produced anything";

const passed = (runId: string, point: string, action: string, onSha: string) => ({
  type: "GatePassed",
  actor: "conductor",
  data: { gate: point, action, runId, onSha, evidence: "exit 0" },
});

const started = (n: number) => ({
  type: "RunStarted",
  actor: "conductor",
  data: {
    workItemId: wi(n),
    runtime: "claude-code",
    model: "m",
    promptVersion: "p",
    baseSha: "base000",
    configHash: "c",
    worktree: "/tmp/wt",
  },
});

async function seed(): Promise<void> {
  // 1 — queued and nothing else.
  await store.append(wi(1), 0, [discovered(1, "still waiting")]);

  // 2 — running, guard tripped twice, cost recorded.
  await store.append(wi(2), 0, [discovered(2, "a race in the importer"), claimed(2)]);
  await store.append(run(2), 0, [
    started(2),
    { type: "RunFinished", actor: "conductor", data: { exitCode: 0, turns: 63, durationMs: 100, costUsd: 5.42 } },
  ]);

  // 3 — at the gates, one passed and one failed.
  await store.append(wi(3), 0, [discovered(3, "gates in progress", "feature"), claimed(3)]);
  await store.append(run(3), 0, [
    started(3),
    { type: "RunProducedDiff", actor: "conductor", data: { branch: "agent/3", headSha: "sha-a", files: 3, insertions: 40, deletions: 2 } },
    { type: "RunProposedCompletion", actor: "conductor", data: { headSha: "sha-a" } },
    { type: "GatePassed", actor: "conductor", data: { gate: "proposed", action: "build", runId: run(3), onSha: "sha-a", evidence: "exit 0" } },
    { type: "GateFailed", actor: "conductor", data: { gate: "proposed", action: "review", runId: run(3), onSha: "sha-a", evidence: "two findings", findings: [] } },
  ]);

  // 4 — refused by the integrator.
  await store.append(wi(4), 0, [discovered(4, "will not merge")]);
  const lane = integrationStream(PROJECT, "develop");
  created.add(lane);
  await store.append(lane, 0, [
    { type: "IntegrationAttempted", actor: "conductor", data: { workItemId: wi(4), branch: "agent/4", headSha: "sha" } },
    {
      type: "IntegrationRefused",
      actor: "conductor",
      data: { workItemId: wi(4), branch: "agent/4", reason: "dirty-base", detail: "uncommitted changes" },
    },
  ]);

  // 5 — landed.
  await store.append(wi(5), 0, [
    discovered(5, "landed a while ago"),
    { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234def", base: "develop" } },
  ]);

  // 6 — attempt 1 passed a gate and was then killed from outside. Attempt 2
  //     arrives in `secondAttempt`, after the rebuild, so the window this is
  //     about is folded the way production folds it.
  await store.append(wi(6), 0, [discovered(6, "killed, then run again"), claimedWith(attempt(6, "a"))]);
  await store.append(attempt(6, "a"), 0, [started(6), passed(attempt(6, "a"), "prepared", "install", "sha-6a")]);

  // 7 — the same kill, with nothing after it: still in the queue, and the only
  //     thing it has to show for the attempt is the sentence the release gave.
  await store.append(wi(7), 0, [discovered(7, "killed and not picked up again"), claimedWith(attempt(7, "a"))]);
  await store.append(attempt(7, "a"), 0, [started(7), passed(attempt(7, "a"), "prepared", "install", "sha-7")]);
  await store.append(wi(7), 2, [released(attempt(7, "a"), KILLED)]);

  // 8 — a person's word, twice: a red build waived, and the merge approved.
  await store.append(wi(8), 0, [discovered(8, "overridden by a person"), claimed(8)]);
  await store.append(run(8), 0, [
    started(8),
    { type: "RunProposedCompletion", actor: "conductor", data: { headSha: "sha-8" } },
    {
      type: "GateFailed",
      actor: "conductor",
      data: { gate: "proposed", action: "build", runId: run(8), onSha: "sha-8", evidence: "exit 1", findings: [] },
    },
    {
      type: "GateWaived",
      actor: "human:steven",
      data: { gate: "proposed", action: "build", runId: run(8), onSha: "sha-8", by: "human:steven", reason: "known flake" },
    },
    {
      type: "ApprovalGranted",
      actor: "human:steven",
      data: { gate: "merge", action: "human", runId: run(8), onSha: "sha-8", by: "human:steven", note: "" },
    },
  ]);

  // 9 — approved, the merge hit a conflict, and the failure bought an agent.
  //     The whole of #84 in one stream: the approval is spent, the item goes
  //     back to the queue as a repair, and the repair's spend is its own.
  await store.append(wi(9), 0, [discovered(9, "approved, then conflicted"), claimedWith(attempt(9, "a"))]);
  await store.append(attempt(9, "a"), 0, [
    started(9),
    { type: "RunProposedCompletion", actor: "conductor", data: { headSha: "sha-9a" } },
    {
      type: "ApprovalRequested",
      actor: "conductor",
      data: { gate: "merge", action: "approval", runId: attempt(9, "a"), onSha: "sha-9a", question: "Merge?", artifacts: [] },
    },
    { type: "RunFinished", actor: "conductor", data: { exitCode: 0, turns: 20, durationMs: 10, costUsd: 2.1 } },
    {
      type: "ApprovalGranted",
      actor: "human:steven",
      data: { gate: "merge", action: "approval", runId: attempt(9, "a"), onSha: "sha-9a", by: "human:steven", note: "" },
    },
  ]);
  await store.append(lane, 2, [
    {
      type: "IntegrationRefused",
      actor: "conductor",
      data: { workItemId: wi(9), branch: "agent/9", reason: "conflict", detail: "agent/9 does not merge into develop: page.tsx" },
    },
  ]);
  await store.append(wi(9), 2, [
    {
      type: "RepairRequested",
      actor: "conductor",
      data: {
        runId: attempt(9, "a"),
        reason: "conflict",
        detail: "agent/9 does not merge into develop: page.tsx",
        fingerprint: "0123456789ab",
        attempt: 1,
      },
    },
    released(attempt(9, "a"), "repairing conflict (attempt 1)"),
    claimedWith(attempt(9, "b")),
  ]);
  await store.append(attempt(9, "b"), 0, [
    started(9),
    { type: "RunFinished", actor: "conductor", data: { exitCode: 0, turns: 9, durationMs: 10, costUsd: 0.75 } },
  ]);
}

/** Appended after the rebuild, so `fold` is what folds it. */
async function secondAttempt(): Promise<void> {
  await store.append(wi(6), 2, [released(attempt(6, "a"), KILLED)]);
  await store.append(wi(6), 3, [claimedWith(attempt(6, "b"))]);
  await store.append(attempt(6, "b"), 0, [started(6)]);
}

async function build(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store });
  try {
    await runner.rebuild();
  } finally {
    await runner.close();
  }
}

/** Forward from the checkpoint, which is what a live projector does. */
async function fold(): Promise<void> {
  const runner = createProjectionRunner({ projection: taskViewProjection, store });
  try {
    await runner.start();
  } finally {
    await runner.close();
  }
}

const card = (tasks: Awaited<ReturnType<typeof readTasks>>, n: number) =>
  tasks.find((t) => t.issue === String(n));

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  await seed();
  await build();
  // Half the history is rebuilt and half is folded forward, so the rebuild case
  // below compares the two paths rather than a rebuild against itself.
  await secondAttempt();
  await fold();
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

describe("task_view", () => {
  it("puts each task in the state its stream says it is in", async () => {
    const tasks = await readTasks({ project: PROJECT });

    expect(card(tasks, 1)?.state).toBe("queued");
    expect(card(tasks, 2)?.state).toBe("running");
    expect(card(tasks, 3)?.state).toBe("gates");
    expect(card(tasks, 4)?.state).toBe("waiting");
    expect(card(tasks, 5)?.state).toBe("landed");
  });

  it("carries what a card shows and leaves the rest in the log", async () => {
    const tasks = await readTasks({ project: PROJECT });

    const two = card(tasks, 2)!;
    expect(two.turns).toBe(63);
    expect(two.costUsd).toBeCloseTo(5.42);
    // No tier on the card any more: it is the recipe's (ADR 0016 §7), and the
    // board does not read recipes.

    const three = card(tasks, 3)!;
    expect(three.gatesPassed).toBe(1);
    expect(three.gatesFailed).toBe(1);
    expect(three.headSha).toBe("sha-a");
    expect(three.files).toBe(3);
  });

  it("records the attempt, which is what a backoff reads", async () => {
    const tasks = await readTasks({ project: PROJECT });
    const two = card(tasks, 2)!;

    // In the table rather than in memory: an in-memory set forgets on restart,
    // and the loop it prevents cost the old harness roughly $29.
    expect(two.attempts).toBe(1);
    expect(two.lastAttemptAt).toBeInstanceOf(Date);
    expect(card(tasks, 1)!.attempts).toBe(0);
  });

  it("says why a task is waiting, in one line", async () => {
    const tasks = await readTasks({ project: PROJECT });
    expect(card(tasks, 4)!.note).toContain("dirty-base");
  });

  /**
   * #78. `wi-lingtai-59` read `1 passed · attempt 2` on the board, and the pass
   * belonged to attempt 1 — a run an operator had killed eleven hours earlier,
   * which produced nothing. The verdicts were keyed `point:action` with no run
   * in the key, so the map was one shared set of cells and nothing ever cleared
   * it.
   */
  it("counts only the gates of the run the card names", async () => {
    const tasks = await readTasks({ project: PROJECT });
    const six = card(tasks, 6)!;

    expect(six.attempts).toBe(2);
    expect(six.runId).toBe(`run-${PROJECT}-6b`);
    // Attempt 2 has reached no gate. Attempt 1's `prepared:install` is still in
    // the map, against the run that earned it, and is not this card's.
    expect(six.gatesPassed).toBe(0);
    expect(six.gatesFailed).toBe(0);
  });

  /**
   * A run killed from outside fails no gate, so `gatesFailed` stayed 0 and the
   * card came back to Queued with a green pill and nothing else — a ticket that
   * had burned money and produced nothing, looking like a fresh one.
   */
  it("marks a task whose attempt ended without landing", async () => {
    const tasks = await readTasks({ project: PROJECT });
    const seven = card(tasks, 7)!;

    expect(seven.state).toBe("queued");
    // No run named, so no verdict is this card's to show.
    expect(seven.runId).toBeNull();
    expect(seven.gatesPassed).toBe(0);
    // The sentence the release already carried.
    expect(seven.note).toBe(KILLED);
  });

  /**
   * A waiver records who and why precisely because it is not a pass. Counting
   * it as one threw away the distinction the record exists for — and the same
   * held for a human approval, which is not a build going green either.
   */
  it("does not read a person's word as a gate that ran", async () => {
    const tasks = await readTasks({ project: PROJECT });
    const eight = card(tasks, 8)!;

    expect(eight.gatesPassed).toBe(0);
    // The waiver replaced the failure in its own cell: one verdict per point
    // per run, and the latest one is what stands.
    expect(eight.gatesFailed).toBe(0);
    expect(eight.gatesWaived).toBe(1);
    expect(eight.gatesApproved).toBe(1);
  });

  /**
   * The dead end `#84` is about, as the card sees it.
   *
   * "Waiting, and there is a head sha" was true of this row while `approve()`
   * would refuse every click — the approval had been spent on the merge that
   * conflicted, and the run was back to `gating`. Sitting in the column and
   * being asked a question are two facts, and the card now carries both.
   */
  it("stops offering an approval once the merge that consumed it failed", async () => {
    const tasks = await readTasks({ project: PROJECT, retentionDays: 3650 });
    const nine = card(tasks, 9)!;

    expect(nine.awaitingApproval).toBe(false);
    // And the repair it bought has been claimed, so the exemption is spent too.
    expect(nine.repairPending).toBe(false);
    // Queued again, and therefore nobody's question at the moment.
    expect(nine.blocked).toBe(false);

    // The lane holds more than questions: a refused dispatch is `waiting` and
    // is not an item anybody can hand back, so the card must not offer to.
    expect(card(tasks, 4)!.state).toBe("waiting");
    expect(card(tasks, 4)!.blocked).toBe(false);
  });

  /**
   * What diagnosis costs, apart from the work.
   *
   * A repair is on by default and spends an agent without being asked again, so
   * folding its cost into the number beside it would make it an invisible bill.
   */
  it("counts a repair's spend separately from the work's", async () => {
    const tasks = await readTasks({ project: PROJECT, retentionDays: 3650 });
    const nine = card(tasks, 9)!;

    expect(nine.costUsd).toBe(2.1);
    expect(nine.repairCostUsd).toBe(0.75);
    // And a card that never bought one says nothing rather than zero: no repair
    // and a free repair are different facts.
    expect(card(tasks, 2)!.repairCostUsd).toBeNull();
  });

  /**
   * The property that makes this table's shape free to change. It only holds
   * because every timestamp comes from `event.at` — a projection that read the
   * clock would produce different rows on every rebuild, and the workflow for
   * changing a projection would stop being "rebuild it".
   *
   * `before` is genuinely the two paths mixed: `beforeAll` rebuilds most of the
   * history and then folds the rest forward from the checkpoint. That is what
   * makes this a claim about the incremental path and not a rebuild compared
   * with itself — and it is the claim the run-scoped gate keys have to survive,
   * since assignment into a keyed map is the only reason a replay lands on the
   * same numbers.
   */
  it("rebuilds to exactly what the incremental path produced", async () => {
    const before = await readTasks({ project: PROJECT });
    await build();
    const after = await readTasks({ project: PROJECT });

    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  /**
   * Retention filters, it does not delete. If the projection dropped old rows
   * its contents would depend on when it last ran, and a rebuild would no longer
   * reproduce itself.
   */
  it("filters a landed task out of the window while keeping its row", async () => {
    const visible = await readTasks({ project: PROJECT, retentionDays: 0 });
    expect(card(visible, 5)).toBeUndefined();
    // Still queued and running tasks — the filter is about closed ones only.
    expect(card(visible, 1)).toBeDefined();

    const kept = await readTasks({ project: PROJECT, retentionDays: 3650 });
    expect(card(kept, 5)?.note).toBe("abc1234def");
  });
});
