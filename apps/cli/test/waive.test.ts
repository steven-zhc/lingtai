/**
 * `lingtai waive`, against the real log.
 *
 * `waive` was a decision the board could take and the CLI could not (#129), and
 * the property that matters is not that the command exists — it is that the two
 * ways of taking the decision leave the same thing behind. So the last test
 * folds the item with the board's own `claimsOf`/`foldRun`/`standingOf`, sends
 * what `Decide` sends from that — `gates[0]` and `headSha` — through the call
 * `waiveGate` makes, and compares envelopes.
 *
 * The rest are the cases an earlier attempt refused and should not have: a gate
 * a dead run left `running`, and a gate the run planned and never reported —
 * the one waiver `gate-audit.ts` names as what closes `landedWithoutGatePoints`.
 *
 * Real events, throwaway project, as every database-touching test here does.
 */
import { waive } from "@lingtai/conductor";
import { directDatabaseUrl } from "@lingtai/env";
import { GATE_POINTS, parsePayload, projectStream, workItemStream } from "@lingtai/domain";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { userInfo } from "node:os";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claimsOf, foldRun, standingOf } from "../../board/src/lib/task.ts";
import { waiveCommand } from "../src/waive.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>([projectStream(PROJECT)]);
const SHA = "a".repeat(40);
/** What the board's `waiveGate` records, which is the local account (0007). */
const ACTOR = `human:${userInfo().username}`;

let client: Db;
let store: EventStore;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  await store.append(projectStream(PROJECT), 0, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: parsePayload("ProjectConfigured", {
        project: PROJECT,
        owner: "esc",
        base: "main",
        configHash: "seeded",
        fromSha: SHA,
      }),
    },
  ]);
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...created]]);
    await c.query("delete from task_view where project = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

const gateEvent = (type: "GateRequested" | "GateStarted" | "GateFailed", runId: string) => ({
  type,
  actor: "conductor",
  data: parsePayload(type, {
    gate: "proposed",
    action: "build",
    runId,
    onSha: SHA,
    ...(type === "GateFailed" ? { evidence: "the importer suite, again", findings: [] } : {}),
  }),
});

/**
 * One item whose run planned `proposed:build` and `merge:review`, produced a
 * diff, and then left `proposed:build` in one of three states:
 *
 * - `failed` — the case the command exists for.
 * - `hung` — `GateRequested`, `GateStarted`, then the run failed on a timeout.
 *   Nothing will ever append a verdict for that gate.
 * - `unreported` — no gate event at all, as `landedWithoutGatePoints` finds.
 */
async function gatedRun(
  issue: number,
  outcome: "failed" | "hung" | "unreported" = "failed",
): Promise<{ workItemId: string; runId: string }> {
  const workItemId = workItemStream(PROJECT, issue);
  const runId = `run-${PROJECT}-${issue}`;
  created.add(workItemId);
  created.add(runId);

  await store.append(workItemId, 0, [
    {
      type: "WorkItemDiscovered",
      actor: "github",
      data: parsePayload("WorkItemDiscovered", {
        project: PROJECT,
        source: "manual",
        externalRef: String(issue),
        title: "the importer",
        kind: "bug",
        labels: [],
      }),
    },
    {
      type: "WorkItemClaimed",
      actor: "conductor",
      data: parsePayload("WorkItemClaimed", { runId, worker: "w1", title: "the importer", kind: "bug" }),
    },
  ]);

  await store.append(runId, 0, [
    {
      type: "RunStarted",
      actor: "conductor",
      data: parsePayload("RunStarted", {
        workItemId,
        runtime: "claude-code",
        model: "",
        promptVersion: "ticket@1",
        baseSha: SHA,
        configHash: "seeded",
        worktree: "/tmp/none",
        invocation: null,
      }),
    },
    {
      type: "GatesResolved",
      actor: "conductor",
      data: parsePayload("GatesResolved", {
        runId,
        configHash: "seeded",
        points: GATE_POINTS.map((gate) => ({
          gate,
          actions: gate === "proposed" ? ["build"] : gate === "merge" ? ["review"] : [],
        })),
      }),
    },
    {
      type: "RunProducedDiff",
      actor: "conductor",
      data: parsePayload("RunProducedDiff", {
        branch: `agent/${issue}`,
        headSha: SHA,
        files: 1,
        insertions: 1,
        deletions: 0,
      }),
    },
    ...(outcome === "failed" ? [gateEvent("GateFailed", runId)] : []),
    ...(outcome === "hung"
      ? [
          gateEvent("GateRequested", runId),
          gateEvent("GateStarted", runId),
          {
            type: "RunFailed",
            actor: "conductor",
            data: parsePayload("RunFailed", { kind: "timeout", detail: "wall limit" }),
          },
        ]
      : []),
  ]);

  return { workItemId, runId };
}

const waived = async (runId: string) => (await store.read(runId)).filter((e) => e.type === "GateWaived");

async function said(options: Parameters<typeof waiveCommand>[0]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const code = await waiveCommand(options, (line) => lines.push(line));
  return { code, out: lines.join("\n") };
}

describe("lingtai waive", () => {
  it("appends the waiver on the head it read, carrying who and why", async () => {
    const { runId } = await gatedRun(1);
    const reason = "unrelated flake in the importer suite";

    const { code, out } = await said({ project: PROJECT, issue: 1, gate: "proposed:build", reason, store });

    expect(code).toBe(0);
    const events = await waived(runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.actor).toBe(ACTOR);
    expect(events[0]!.data).toMatchObject({ gate: "proposed", action: "build", runId, onSha: SHA, by: ACTOR, reason });
    expect(out).toContain("waived");
  });

  /**
   * A person at a prompt typed the gate from memory. The refusal lists every
   * gate there is and what each says, planned ones included, so the next
   * attempt is spelled right without opening a browser.
   */
  it("refuses a gate that is not there, naming the gates there are", async () => {
    const { runId } = await gatedRun(2);

    const { code, out } = await said({ project: PROJECT, issue: 2, gate: "proposed:tests", reason: "flaky", store });

    expect(code).toBe(1);
    expect(out).toContain('no gate named "proposed:tests"');
    expect(out).toContain("proposed:build (failed)");
    expect(out).toContain("merge:review (planned, no verdict)");
    expect(await waived(runId)).toHaveLength(0);
  });

  /**
   * The scan whose service is down, after the run gave up on it. `GateStarted`
   * is the last word that gate will ever get, so refusing until a verdict lands
   * would be refusing for ever.
   */
  it("waives a gate a dead run left running, and says it was running", async () => {
    const { runId } = await gatedRun(3, "hung");

    const { code, out } = await said({
      project: PROJECT,
      issue: 3,
      gate: "proposed:build",
      reason: "the scanner is down",
      store,
    });

    expect(code).toBe(0);
    expect(out).toContain("proposed:build is running with no verdict");
    expect(await waived(runId)).toHaveLength(1);
  });

  /** What `gate-audit.ts` says closes a `landedWithoutGatePoints` failure. */
  it("waives a gate the run planned and never reported", async () => {
    const { runId } = await gatedRun(4, "unreported");

    const { code } = await said({
      project: PROJECT,
      issue: 4,
      gate: "merge:review",
      reason: "landed before merge gates ran; I have read the diff",
      store,
    });

    expect(code).toBe(0);
    expect((await waived(runId))[0]!.data).toMatchObject({ gate: "merge", action: "review", onSha: SHA });
  });

  /**
   * *Recorded, never silent* is the whole of `GateWaived`'s justification, so a
   * blank reason is a refusal and not a default, and the exit code says usage.
   */
  it("refuses a blank reason rather than writing one", async () => {
    const { runId } = await gatedRun(5);

    const { code, out } = await said({ project: PROJECT, issue: 5, gate: "proposed:build", reason: "  ", store });

    expect(code).toBe(2);
    expect(out).toContain("a waiver needs a reason");
    expect(await waived(runId)).toHaveLength(0);
  });

  /**
   * The gates were listed on one head; if the branch moves before the append,
   * the waiver is for a diff nobody read. The command's `onSha` makes `waive()`
   * refuse that, as it refuses the board's stale click.
   */
  it("refuses when the head moves between reading the gates and appending", async () => {
    const { runId } = await gatedRun(6);
    let moved = false;
    const moving: EventStore = {
      ...store,
      read: async (stream, ...rest) => {
        const events = await store.read(stream, ...rest);
        if (stream === runId && !moved) {
          moved = true;
          await store.append(runId, events.at(-1)!.version, [
            {
              type: "RunProducedDiff",
              actor: "conductor",
              data: parsePayload("RunProducedDiff", {
                branch: "agent/6",
                headSha: "b".repeat(40),
                files: 2,
                insertions: 2,
                deletions: 0,
              }),
            },
          ]);
        }
        return events;
      },
    };

    const { code, out } = await said({
      project: PROJECT,
      issue: 6,
      gate: "proposed:build",
      reason: "flaky",
      store: moving,
    });

    expect(code).toBe(1);
    expect(out).toContain("bbbbbbb");
    expect(await waived(runId)).toHaveLength(0);
  });

  it("leaves a waiver a board click cannot be told apart from", async () => {
    const fromCli = await gatedRun(7);
    const fromBoard = await gatedRun(8);
    const reason = "the scan's service is down; I have read the diff";

    // What the board's card would send, folded the way the board folds it:
    // `Decide` gets `gates={standing.failed}` and `headSha={standing.headSha}`
    // and calls `waiveGate({ gate: gates[0] ?? "build", onSha: headSha })`.
    const own = await store.read(fromBoard.workItemId);
    const runs = await Promise.all(
      claimsOf(own).map(async (c, i) => foldRun(c, i + 1, await store.read(c.runId))),
    );
    const standing = standingOf(own, runs);
    const gate = standing.failed[0] ?? "build";
    expect(gate).toBe("proposed:build");

    expect((await said({ project: PROJECT, issue: 7, gate, reason, store })).code).toBe(0);
    // `waiveGate`'s own call, argument for argument.
    const board = await waive({
      project: PROJECT,
      issue: 8,
      gate,
      by: ACTOR,
      reason,
      onSha: standing.headSha ?? "",
      store,
    });
    expect(board.ok).toBe(true);

    const cli = (await waived(fromCli.runId))[0]!;
    const fromCard = (await waived(fromBoard.runId))[0]!;
    expect(cli.type).toBe(fromCard.type);
    expect(cli.actor).toBe(fromCard.actor);
    // The run id is the one field that must differ — these are two items.
    const payload = (e: { data: unknown }) => ({ ...(e.data as object), runId: "" });
    expect(payload(cli)).toEqual(payload(fromCard));
  });
});
