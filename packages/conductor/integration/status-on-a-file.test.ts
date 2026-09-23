/**
 * `lingtai status` on a machine with no Postgres (#221).
 *
 * **This is the first command anybody types and it was the first failure.**
 * `status()` begins `await loadProjects()`, which began `listProjectStreams()`,
 * which was `new pg.Client({ connectionString: postgresUrl() })` — so on the
 * machine [#179](https://github.com/steven-zhc/lingtai/issues/179) exists for,
 * the answer to *what is runnable* was a connection error before a line of the
 * command ran. #179's eighth pass named it in review and nothing in the fold's
 * hand-written list of what-needs-Postgres mentioned it, which is the defect
 * [0055](../../../doc/decisions/0055-two-implementations-chosen-at-init.md) §1
 * is about: a set maintained by memory rather than by a type.
 *
 * **The absence is what is asserted.** Every name this code could read a
 * connection string from is removed for the duration, so `postgresUrl()`
 * refuses — which means a Postgres reached for anywhere on this path, including
 * at import, fails the test rather than quietly working on the machine that
 * happens to have one. `machineDatabaseUrl`'s `~/.lingtai/config.yml` fallback
 * is already off under `VITEST` (`machineUrlIfReadable`), so a developer's own
 * file cannot stand in either.
 *
 * It does **not** assert that `lingtai status` picks the file-backed log — it
 * does not, and must not: choosing the store is #179's and this ticket blocks
 * it. What it asserts is that the road is open, which is the half that was
 * closed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePayload, projectStream } from "@lingtai/domain";
import { postgresUrl } from "@lingtai/env";
import { createSqliteLog, openSqliteLog } from "@lingtai/event-store/sqlite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAllProjects, loadProject, loadProjects } from "../src/projects.ts";

const dirs: string[] = [];
const opened: { close(): void }[] = [];

function freshLog() {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-status-"));
  dirs.push(dir);
  const path = join(dir, "log.db");
  const db = openSqliteLog(path);
  opened.push(db);
  return createSqliteLog({ db, path });
}

const LIVE = "esctest-live";
const PENDING = "esctest-pending";

let log: ReturnType<typeof freshLog>;

beforeAll(async () => {
  // Every name `postgresUrl()` and `directPostgresUrl()` read. With these gone
  // a stray `createDb()` throws by name, which is the point of the test.
  for (const name of [
    "LINGTAI_DATABASE_URL",
    "LINGTAI_DIRECT_DATABASE_URL",
    "LINGTAI_TEST_DATABASE_URL",
    "LINGTAI_TEST_DIRECT_DATABASE_URL",
  ]) {
    vi.stubEnv(name, undefined as unknown as string);
  }

  log = freshLog();
  await log.store.append(projectStream(LIVE), 0, [
    {
      type: "ProjectConfigured",
      actor: "conductor",
      data: parsePayload("ProjectConfigured", {
        project: LIVE,
        owner: "steven-zhc",
        base: "main",
        configHash: "h",
        fromSha: "s",
      }),
    },
  ]);
  await log.store.append(projectStream(PENDING), 0, [
    {
      type: "ProjectOnboardingStarted",
      actor: "human:esctest",
      data: parsePayload("ProjectOnboardingStarted", {
        slug: `steven-zhc/${PENDING}`,
        base: "develop",
        by: "human:esctest",
      }),
    },
  ]);
});

afterAll(() => {
  vi.unstubAllEnvs();
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("what lingtai status asks first, on a machine with no Postgres", () => {
  it("refuses to name a connection at all, so nothing here can quietly have one", () => {
    // The guard on the guard: if this ever stops throwing, every assertion
    // below proves only that the machine running them has a database.
    // `postgresUrl` reads the environment when it is called, so the stubbing
    // above is in force here.
    expect(() => postgresUrl()).toThrow();
  });

  it("lists the projects a conductor may take work from", async () => {
    const names = (await loadProjects(log)).map((p) => p.project);

    expect(names).toEqual([LIVE]);
  });

  it("reads the whole register, pending projects included", async () => {
    const all = await loadAllProjects(log);

    expect(all.map((p) => p.project).sort()).toEqual([LIVE, PENDING].sort());
  });

  it("answers about one project by name", async () => {
    expect((await loadProject(LIVE, log.store))?.base).toBe("main");
    // Recorded and not yet registered, so the conductor is told nothing — the
    // rule `integration/projects.test.ts` pins against the real store.
    expect(await loadProject(PENDING, log.store)).toBeNull();
  });
});
