/**
 * What a conductor is allowed to see, on the real log (#163).
 *
 * A repository can be recorded and not yet conducted: the wizard appends
 * `ProjectOnboardingStarted` and the recipe lands in a pull request some time
 * later. Nothing must take work from it in between — not because a guard was
 * added, but because `loadProjects()` has filtered on `isRegistered` since
 * before any of this existed, and `isRegistered` reads a `configHash` that only
 * a resolved recipe can supply.
 *
 * **So this asserts what is already true, so that it stays true.** The failure
 * it is written against is a later edit that makes `loadProjects` return every
 * project stream — which would look harmless, pass every other test, and hand
 * the daemon a repository with no recipe, no gates and no limits.
 *
 * Against the real store rather than a memory one: `listProjectStreams` is SQL
 * over `events`, and the thing under test is the whole road from a row to a
 * state.
 */
import { projectStream } from "@lingtai/domain";
import { createDb, createEventStore, type Db, directDatabaseUrl, type EventStore } from "@lingtai/event-store";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadAllProjects, loadPendingProjects, loadProject, loadProjects } from "../src/projects.ts";

const PENDING = `esctest${crypto.randomUUID().slice(0, 6)}`;
const LIVE = `esctest${crypto.randomUUID().slice(0, 6)}`;

let client: Db;
let store: EventStore;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  await store.append(projectStream(PENDING), 0, [
    {
      type: "ProjectOnboardingStarted",
      actor: "human:esctest",
      data: { slug: `steven-zhc/${PENDING}`, base: "develop", by: "human:esctest" },
    },
  ]);
  await store.append(projectStream(LIVE), 0, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: { project: LIVE, owner: "steven-zhc", base: "main", configHash: "h", fromSha: "s" },
    },
  ]);
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [
      [projectStream(PENDING), projectStream(LIVE)],
    ]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

describe("the projects a conductor may take work from", () => {
  it("does not include one whose recipe has not landed", async () => {
    const names = (await loadProjects(store)).map((p) => p.project);

    expect(names).not.toContain(PENDING);
    expect(names).toContain(LIVE);
  });

  /**
   * The other half, and the reason the first is not simply "it is missing":
   * the pending project *is* on the log and *is* readable. It is withheld from
   * the conductor and offered to the board, which is a different fact from not
   * being there.
   */
  it("offers it to the board instead, with the slug and the branch Recheck needs", async () => {
    const pending = (await loadPendingProjects(store)).find((p) => p.project === PENDING);

    expect(pending).toBeDefined();
    expect(pending?.owner).toBe("steven-zhc");
    expect(pending?.base).toBe("develop");
    expect((await loadPendingProjects(store)).map((p) => p.project)).not.toContain(LIVE);
  });

  /** Every stream is on exactly one of the two lists, which is what makes them a line. */
  it("splits the register in two, with nothing on both sides and nothing lost", async () => {
    const [all, live, pending] = await Promise.all([
      loadAllProjects(store),
      loadProjects(store),
      loadPendingProjects(store),
    ]);
    const named = all.filter((p) => p.project !== null);

    expect(live.length + pending.length).toBe(named.length);
    expect(live.map((p) => p.project).filter((n) => pending.some((p) => p.project === n))).toEqual([]);
  });

  /** `loadProject` is the same line asked about one name — the board's actions read through it. */
  it("gives no single project back for a pending name either", async () => {
    expect(await loadProject(PENDING, store)).toBeNull();
    expect((await loadProject(LIVE, store))?.project).toBe(LIVE);
  });
});
