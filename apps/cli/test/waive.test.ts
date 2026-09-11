/**
 * The escape hatch, from the side that did not have it.
 *
 * `waive` was a decision the board could take and the CLI could not (#129), and
 * the property that matters is not that the command exists — it is that the two
 * ways of taking the decision leave the same thing behind. A log where a waiver
 * carries *how it was clicked* is a log that has to be read twice, and the
 * board's own header says why: "there is no board-specific state and no second
 * write path".
 *
 * So the last test here runs the two paths side by side. The board's is
 * `waive()` and `actor()` from `@lingtai/conductor/decide` — the same import
 * `actions.ts:29` makes, called with the arguments `waiveGate` passes — because
 * a `"use server"` module cannot be imported outside Next. What is compared is
 * the whole envelope but its position: type, actor and payload.
 *
 * **`actor()` is imported and never re-spelled.** An earlier version of this
 * file spelled the actor expression out itself and compared the CLI's waiver
 * against that, which would have gone on passing had the board and the CLI
 * drifted to two different actors — it asserted a constant, not the property in
 * its own name. There is now one `actor()`, living beside the decisions, and
 * the board, the command and this test all name it rather than restate it.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { actor, waive } from "@lingtai/conductor/decide";
import { parsePayload, projectStream, workItemStream } from "@lingtai/domain";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waiveCommand } from "../src/waive.ts";

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
const created = new Set<string>([projectStream(PROJECT)]);
const SHA = "a".repeat(40);
/** The one function both paths call for the same person (0007). */
const BY = actor();

let client: Db;
let store: EventStore;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  // Registered, because both `lingtai waive` and the board refuse a project
  // they cannot find rather than appending to a stream nobody manages.
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
}, 120_000);

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

/**
 * One item whose run produced a diff and then said something about a gate on
 * it.
 *
 * `"failed"` is the case the command exists for. `"running"` is the one that
 * looks like it and is not: `GateRequested` then `GateStarted` and nothing
 * further, which is what a scan whose service is down leaves behind while you
 * are reaching for the escape hatch.
 */
async function gatedRun(
  issue: number,
  outcome: "failed" | "running" = "failed",
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
      data: parsePayload("WorkItemClaimed", {
        runId,
        worker: "w1",
        title: "the importer",
        kind: "bug",
      }),
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
    ...(outcome === "failed"
      ? ([
          {
            type: "GateFailed",
            actor: "conductor",
            data: parsePayload("GateFailed", {
              gate: "proposed",
              action: "build",
              runId,
              onSha: SHA,
              evidence: "the importer suite, again",
              findings: [],
            }),
          },
        ] as const)
      : ([
          {
            type: "GateRequested",
            actor: "conductor",
            data: parsePayload("GateRequested", {
              gate: "proposed",
              action: "build",
              runId,
              onSha: SHA,
            }),
          },
          {
            type: "GateStarted",
            actor: "conductor",
            data: parsePayload("GateStarted", {
              gate: "proposed",
              action: "build",
              runId,
              onSha: SHA,
            }),
          },
        ] as const)),
  ]);

  return { workItemId, runId };
}

const waived = async (runId: string) =>
  (await store.read(runId)).filter((e) => e.type === "GateWaived");

describe("lingtai waive", () => {
  it("appends the waiver, carrying who and why", async () => {
    const { runId } = await gatedRun(1);
    const said: string[] = [];

    const code = await waiveCommand(
      {
        project: PROJECT,
        issue: 1,
        gate: "proposed:build",
        reason: "unrelated flake in the importer suite",
        store,
      },
      (line) => said.push(line),
    );

    expect(code).toBe(0);
    const events = await waived(runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toMatchObject({
      gate: "proposed",
      action: "build",
      runId,
      onSha: SHA,
      by: BY,
      reason: "unrelated flake in the importer suite",
    });
    expect(said.join("\n")).toContain("waived");
  }, 60_000);

  /**
   * The refusal that makes the command usable without a browser. A person at a
   * prompt typed the gate from memory; sending them back to the board to find
   * out what it is called is the trip this command exists to remove.
   */
  it("refuses a gate with no verdict, naming the verdicts there are", async () => {
    const { runId } = await gatedRun(2);
    const said: string[] = [];

    const code = await waiveCommand(
      { project: PROJECT, issue: 2, gate: "proposed:tests", reason: "flaky", store },
      (line) => said.push(line),
    );

    expect(code).toBe(1);
    expect(said.join("\n")).toContain('no gate named "proposed:tests"');
    expect(said.join("\n")).toContain("proposed:build (failed)");
    expect(await waived(runId)).toHaveLength(0);
  }, 60_000);

  /**
   * The refusal the first version of this command did not make.
   *
   * `GateVerdict` has five values and only three are verdicts. A gate that is
   * `running` is in the fold — so a check for "is this gate here?" passes — and
   * has decided nothing. The fold keys every gate event under `point:action`
   * and keeps the last, so a waiver appended now is overwritten by the gate's
   * own verdict minutes later: the waiver is in the log and the card says
   * `failed`. The refusal names the state rather than pretending the gate is
   * missing, because the person is looking at a hung scan, not a typo.
   */
  it("refuses a gate that is still running, naming that it is running", async () => {
    const { runId } = await gatedRun(6, "running");
    const said: string[] = [];

    const code = await waiveCommand(
      { project: PROJECT, issue: 6, gate: "proposed:build", reason: "the scanner is down", store },
      (line) => said.push(line),
    );

    expect(code).toBe(1);
    expect(said.join("\n")).toContain("proposed:build is running, not decided");
    expect(await waived(runId)).toHaveLength(0);
  }, 60_000);

  /**
   * *Recorded, never silent* is the whole of `GateWaived`'s justification, so a
   * blank reason is a refusal and not a default. `--reject` fills one in; this
   * must not, and the exit code says usage rather than failure.
   */
  it("refuses a blank reason rather than writing one", async () => {
    const { runId } = await gatedRun(3);
    const said: string[] = [];

    const code = await waiveCommand(
      { project: PROJECT, issue: 3, gate: "proposed:build", reason: "   ", store },
      (line) => said.push(line),
    );

    expect(code).toBe(2);
    expect(said.join("\n")).toContain("a waiver needs a reason");
    expect(await waived(runId)).toHaveLength(0);
  }, 60_000);

  /**
   * The property the whole ticket is about: two people, one at a prompt and one
   * at a card, leave the log in the same state.
   */
  it("leaves a waiver a board click cannot be told apart from", async () => {
    const fromCli = await gatedRun(4);
    const fromBoard = await gatedRun(5);
    const reason = "the scan's service is down; I have read the diff";

    await waiveCommand(
      { project: PROJECT, issue: 4, gate: "proposed:build", reason, store },
      () => {},
    );
    // `waiveGate`'s own call, argument for argument: the gate the card
    // rendered, the actor the board computes, and the sha it was showing.
    await waive({
      project: PROJECT,
      issue: 5,
      gate: "proposed:build",
      by: BY,
      reason,
      onSha: SHA,
      store,
    });

    const cli = (await waived(fromCli.runId))[0]!;
    const board = (await waived(fromBoard.runId))[0]!;

    expect(cli.type).toBe(board.type);
    expect(cli.actor).toBe(board.actor);
    // The run id is the one thing that must differ — these are two items — so
    // it is the one field normalised before the payloads are compared.
    const payload = (e: { data: unknown }) => ({ ...(e.data as object), runId: "" });
    expect(payload(cli)).toEqual(payload(board));
  }, 60_000);
});
