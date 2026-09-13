/**
 * A pass's refusal, on the real log (#148).
 *
 * A daemon started at `cc6e856` refused every sweep of `lingtai` for hours over
 * a recipe its frozen schema could not read, and `events` held nothing about it.
 * These drive the per-project half of a pass — the part that decides what
 * reaches the log — with each project's work stood in for, since what is under
 * test is the record and the isolation, not GitHub.
 *
 * Every sweep re-reads the project streams, as `conductorPass` does, so the
 * "once" below comes from the log and not from anything this process remembers.
 */
import { loadProject } from "@lingtai/conductor";
import { projectStream } from "@lingtai/domain";
import { createDb, createEventStore, type Db, directDatabaseUrl, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PassOutcome, conductProjects } from "../src/conduct.ts";

const BROKEN = `esctest${crypto.randomUUID().slice(0, 6)}`;
const HEALTHY = `esctest${crypto.randomUUID().slice(0, 6)}`;
const REFUSAL = `lingtai: .lingtai/config.yaml on main is not valid:\n  env: Unrecognized key: "refuseHosts"`;
const OLD = "cc6e856".padEnd(40, "0");
const NEW = "be9fd26".padEnd(40, "0");

let client: Db;
let store: EventStore;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  for (const project of [BROKEN, HEALTHY]) {
    await store.append(projectStream(project), 0, [
      {
        type: "ProjectConfigured",
        actor: "conductor",
        data: { project, owner: "steven-zhc", base: "main", configHash: "h", fromSha: "s" },
      },
    ]);
  }
});

// Now rather than at the global teardown: `doctor`'s own test asserts the
// database is green, and an unrecovered refusal left here would be red there.
afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [[projectStream(BROKEN), projectStream(HEALTHY)]]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

/** One sweep over both projects, BROKEN throwing while `broken`. */
async function sweep(broken: boolean, codeSha: string, worked: string[] = []): Promise<PassOutcome> {
  const projects = [(await loadProject(BROKEN, store))!, (await loadProject(HEALTHY, store))!];
  return conductProjects({
    projects,
    codeSha,
    store,
    outcome: { projects: 0, ran: 0, refused: [] },
    log: () => {},
    work: async (project, where) => {
      where.ref = "main";
      if (project.project === BROKEN && broken) throw new Error(REFUSAL);
      worked.push(project.project!);
      return "looked";
    },
  });
}

const types = async (project: string) => (await store.read(projectStream(project))).map((e) => e.type);

describe("a pass that refuses a project", () => {
  it("records the refusal once across N sweeps, works the other project each time, and records the recovery once", async () => {
    const worked: string[] = [];
    const N = 5;
    for (let i = 0; i < N; i++) {
      // Returning at all is the daemon not exiting: the refusal stayed inside
      // the pass, which reported it and went on to the next project.
      const outcome = await sweep(true, OLD, worked);
      expect(outcome.projects).toBe(2);
      expect(outcome.refused).toEqual([{ project: BROKEN, detail: REFUSAL }]);
    }

    expect(worked).toEqual(Array(N).fill(HEALTHY));
    expect(await types(BROKEN)).toEqual(["ProjectConfigured", "ProjectRefused"]);
    // The project that was worked has nothing to say, and says nothing.
    expect(await types(HEALTHY)).toEqual(["ProjectConfigured"]);
    expect((await store.read(projectStream(BROKEN)))[1]!.data).toEqual({
      project: BROKEN,
      detail: REFUSAL,
      ref: "main",
      codeSha: OLD,
    });

    // A restart into new code: the recipe resolves, and the log says it stopped.
    for (let i = 0; i < N; i++) await sweep(false, NEW);
    expect(await types(BROKEN)).toEqual(["ProjectConfigured", "ProjectRefused", "ProjectRecovered"]);
    expect((await store.read(projectStream(BROKEN)))[2]!.data).toEqual({ project: BROKEN, ref: "main", codeSha: NEW });
    expect((await loadProject(BROKEN, store))!.refused).toBeNull();
    expect(await types(HEALTHY)).toEqual(["ProjectConfigured"]);
  });

  it("appends nothing for a project it looked away from without reading anything", async () => {
    const before = await types(HEALTHY);
    await conductProjects({
      projects: [(await loadProject(HEALTHY, store))!],
      codeSha: OLD,
      store,
      outcome: { projects: 0, ran: 0, refused: [] },
      log: () => {},
      work: async () => "looked-away",
    });
    expect(await types(HEALTHY)).toEqual(before);
  });
});
