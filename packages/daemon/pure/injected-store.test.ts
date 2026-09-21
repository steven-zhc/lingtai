/**
 * A pass reads the streams it found out of the log it found them in (#220).
 *
 * `DaemonStore` answers two questions about the log — *which streams* and *how
 * far has it got* — and names the log itself, `events`. A caller that supplies
 * one and no `store` is naming one system, and a pass that took the ids from it
 * and folded them out of the process-wide Postgres would be reading two.
 *
 * **That failure is silent, which is why it is asserted here rather than left
 * to the reader.** `read()` of a stream the log does not hold is not an error,
 * it is `[]`; `[]` folds to a work item that is not claimed; and a claim check
 * over ids from another log reports *nothing is wrong* about every one of them.
 * The claim of a killed daemon then holds its ticket at `running` for ever,
 * which is #87 with the repair for #87 installed and looking healthy.
 *
 * No database: the log is `createMemoryEventStore` and the store around it is
 * the seam. A pass that reached for Postgres anyway would either refuse at
 * `postgresUrl()` or go and ask a log this test never wrote to, and both show
 * up here as a query the store below was never asked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectState } from "@lingtai/domain";
import type { EventStore } from "@lingtai/event-store/store";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { afterAll, describe, expect, it } from "vitest";
import { releaseForeignClaims, reconcile } from "../src/reconcile.ts";
import type { DaemonStore, StreamQuery } from "../src/store.ts";

const PROJECT = "pureproj";
const CLAIMED = `wi-${PROJECT}-117`;

const project: ProjectState = {
  project: PROJECT,
  owner: "steven-zhc",
  base: "main",
  configHash: "seeded",
  fromSha: "0".repeat(40),
  refused: null,
  version: 1,
  lastSeq: null,
};

const dirs: string[] = [];

/** A home with nothing in it, so the worktree and run-log scans find nothing. */
function emptyHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-injected-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A store over a log in an array, which records what it was asked.
 *
 * `streams()` answers from the ids the test seeded rather than by scanning,
 * because what is under test is *which store is asked* and not how either
 * implementation spells a `like` — that is `test/contract.ts`'s.
 */
function recordingStore(events: EventStore, ids: string[]) {
  const asked: StreamQuery[] = [];
  const store: DaemonStore = {
    events,
    async create() {},
    async beat() {},
    async status() {
      return null;
    },
    async head() {
      return 0n;
    },
    async streams(query) {
      asked.push(query);
      // Only the claim query has an answer: `converge`'s asks for five types
      // under `wi-%`, and this log holds nothing it would change.
      return query.types.includes("WorkItemClaimed") && query.types.length === 1 ? [...ids] : [];
    },
    async close() {},
  };
  return { store, asked };
}

async function logWithAClaim(): Promise<EventStore> {
  const events = createMemoryEventStore();
  await events.append(CLAIMED, 0, [
    {
      type: "WorkItemClaimed",
      actor: "conductor",
      // A worker that is not this pass's, which is the whole of what makes the
      // claim dead (0027): this conductor holds the lock, so nobody else is
      // conducting.
      data: { runId: "run-dead", worker: "otherhost:23673", title: null, kind: "bug" },
    },
  ]);
  return events;
}

describe("a pass given a store reads that store's log", () => {
  it("folds the claim out of the log the stream id came from", async () => {
    const events = await logWithAClaim();
    const { store, asked } = recordingStore(events, [CLAIMED]);

    const findings = await releaseForeignClaims({
      daemonStore: store,
      projects: [project],
      worker: "local:1",
      dryRun: true,
    });

    // Asked this store, and folded this store's log. Reading the process-wide
    // Postgres instead returns `[]` for `wi-pureproj-117`, and an empty fold is
    // not `claimed` — so the orphan is reported as no orphan at all.
    expect(asked).toEqual([{ prefixes: [`wi-${PROJECT}-%`], types: ["WorkItemClaimed"] }]);
    expect(findings.map((f) => f.stream)).toEqual([CLAIMED]);
    expect(findings[0]!.actual).toContain("otherhost:23673");
  });

  it("hands the same store to the converge half of the pass", async () => {
    const events = await logWithAClaim();
    const { store, asked } = recordingStore(events, [CLAIMED]);

    await reconcile({
      daemonStore: store,
      projects: [project],
      worker: "local:1",
      dryRun: true,
      home: emptyHome(),
      // Enough for the GitHub check to run rather than be skipped. No client is
      // registered, so nothing is written even if a divergence were found.
      github: { projects: [project], clients: new Map() },
    });

    // Both halves of one pass, through one store. Without the option being
    // forwarded, `findIssueDrift` builds a Postgres store of its own: on a
    // machine that has configured none the whole pass refuses at
    // `postgresUrl()`, and on one that has, it asks a log this pass has
    // nothing to do with.
    expect(asked).toHaveLength(2);
    expect(asked[1]!.prefixes).toEqual(["wi-%"]);
    expect(asked[1]!.types).toContain("WorkItemLanded");
  });
});
