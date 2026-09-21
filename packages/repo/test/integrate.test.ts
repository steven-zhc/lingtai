/**
 * The integrator, against real git and the real event store.
 *
 * One rule is under test above all others: **no path returns without an event.**
 * The old loop's `integrate()` had six `return 1`s and not one emitted anything;
 * #58 and #59 re-ran five times for about $29 while a dirty checkout of `main`
 * went unreported. So every case below asserts the typed reason *and* that the
 * reason reached the log.
 *
 * The remote is a bare repository in a temp directory. Real git, real merges,
 * real conflicts, no network.
 */
import { integrationStream } from "@lingtai/domain";
import { directPostgresUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureMirror, integrate } from "../src/index.ts";

const exec = promisify(execFile);
const authored = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const g = (args: string[], cwd: string) =>
  exec("git", args, { cwd, env: { ...process.env, ...authored } });

let root: string;
let originPath: string;
let work: string;
let home: string;
const streams = new Set<string>();

const PROJECT = `esctest${crypto.randomUUID().slice(0, 6)}`;
let client: Db;
let store: EventStore;

/** A fresh origin with `develop` and one commit, and a fresh mirror for it. */
async function freshOrigin(): Promise<void> {
  await rm(originPath, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
  await rm(join(home, "repos"), { recursive: true, force: true });
  await rm(join(home, "worktrees"), { recursive: true, force: true });

  await exec("git", ["init", "-q", "-b", "develop", work]);
  await writeFile(join(work, "README.md"), "hello\n");
  await g(["add", "-A"], work);
  await g(["commit", "-qm", "first"], work);
  await exec("git", ["clone", "-q", "--bare", work, originPath]);
  await g(["remote", "add", "origin", originPath], work).catch(() => {});
}

/** Adds a branch to origin with the given file contents. */
async function branchWith(branch: string, files: Record<string, string>): Promise<void> {
  await g(["checkout", "-q", "-B", branch, "develop"], work);
  for (const [path, body] of Object.entries(files)) {
    const full = join(work, path);
    await exec("mkdir", ["-p", join(full, "..")]);
    await writeFile(full, body);
  }
  await g(["add", "-A"], work);
  await g(["commit", "-qm", `work on ${branch}`], work);
  await g(["push", "-q", "origin", branch], work);
  await g(["checkout", "-q", "develop"], work);
}

const base = () => ({
  project: PROJECT,
  owner: "steven-zhc",
  repo: PROJECT,
  base: "develop",
  workItemId: `wi-${PROJECT}-1`,
  headSha: "0".repeat(40),
  gatesPassed: true,
  home,
  store,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "lingtai-integrate-"));
  originPath = join(root, "origin.git");
  work = join(root, "work");
  home = join(root, "home");
  client = createDb();
  store = createEventStore(client);
  streams.add(integrationStream(PROJECT, "develop"));
});

beforeEach(async () => {
  await freshOrigin();
  await ensureMirror({ project: PROJECT, owner: "x", repo: PROJECT, remote: originPath, home });
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directPostgresUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1::text[])", [[...streams]]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
  await rm(root, { recursive: true, force: true });
});

/** Every event on the lane, so a test can assert what was recorded. */
async function lane(): Promise<{ type: string; data: Record<string, unknown> }[]> {
  const events = await store.read(integrationStream(PROJECT, "develop"));
  return events.map((e) => ({ type: e.type, data: e.data as Record<string, unknown> }));
}

describe("integrate", () => {
  it("merges a clean branch and records the merge commit", async () => {
    await branchWith("agent/1", { "src/a.ts": "export const a = 1;\n" });

    const before = (await lane()).length;
    const result = await integrate({ ...base(), branch: "agent/1" });

    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;

    const events = (await lane()).slice(before);
    expect(events.map((e) => e.type)).toEqual(["IntegrationAttempted", "IntegrationSucceeded"]);
    expect(events[1]!.data["mergeCommit"]).toBe(result.mergeCommit);

    // And it really landed on the base branch at origin.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).toContain("work on agent/1");
  });

  it("refuses a conflict with the file that conflicted", async () => {
    await branchWith("agent/2", { "README.md": "from the agent\n" });
    // The base moves underneath it, touching the same file.
    await writeFile(join(work, "README.md"), "from develop\n");
    await g(["add", "-A"], work);
    await g(["commit", "-qm", "base moved"], work);
    await g(["push", "-q", "origin", "develop"], work);

    const before = (await lane()).length;
    const result = await integrate({ ...base(), branch: "agent/2" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("conflict");
    expect(result.detail).toContain("README.md");

    const refusal = (await lane()).slice(before).find((e) => e.type === "IntegrationRefused");
    expect(refusal?.data["reason"]).toBe("conflict");
  });

  it("refuses a branch with nothing to merge", async () => {
    await g(["push", "-q", "origin", "develop:refs/heads/agent/3"], work);

    const result = await integrate({ ...base(), branch: "agent/3" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no-commits");
    expect((await lane()).at(-1)?.data["reason"]).toBe("no-commits");
  });

  /** The hold that caught #117: a migration is applied by a person who read it. */
  it("holds a diff that adds migration files", async () => {
    await branchWith("agent/4", {
      "prisma/migrations/20260901_add_index/migration.sql": "create index x on y (z);\n",
    });

    const result = await integrate({ ...base(), branch: "agent/4" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("pending-migration");
    expect(result.detail).toContain("migration.sql");
    expect((await lane()).at(-1)?.data["reason"]).toBe("pending-migration");
  });

  it("refuses when a gate already said no, and does not merge", async () => {
    await branchWith("agent/5", { "src/b.ts": "export const b = 1;\n" });

    const result = await integrate({
      ...base(),
      branch: "agent/5",
      gatesPassed: false,
      gateDetail: "build exited 1",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("gate-failed");
    expect(result.detail).toContain("build exited 1");

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("work on agent/5");
  });

  it("refuses when verification after merging the base in fails", async () => {
    await branchWith("agent/6", { "src/c.ts": "export const c = 1;\n" });

    const result = await integrate({
      ...base(),
      branch: "agent/6",
      verify: async () => ({ ok: false, evidence: "3 tests failed" }),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The gates ran against the agent's head; this is the different question of
    // whether it still works beside what landed since.
    expect(result.reason).toBe("gate-failed");
    expect(result.detail).toContain("3 tests failed");

    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).not.toContain("work on agent/6");
  });

  /**
   * **Git is what makes the merge safe, and the lane holds no lock** (#194).
   *
   * Two integrations computed against one `develop` both reach the push. The
   * ref update is atomic: one lands, and the other is rejected as not a
   * fast-forward — a refusal on the log with a reason a person can act on,
   * rather than a throw or a retry loop. The lock only ever bought the loser a
   * cheaper way of being told.
   *
   * The first is held at `verify`, after it has merged the base in and before
   * it pushes, so both are computed against the same base — the overlap the
   * lock used to make impossible.
   */
  it("races two integrations on one base: one lands and the other is refused at the push", async () => {
    await branchWith("agent/7", { "src/d.ts": "export const d = 1;\n" });
    await branchWith("agent/8", { "src/e.ts": "export const e = 1;\n" });

    let releaseFirst: () => void = () => {};
    const gate = new Promise<void>((r) => (releaseFirst = r));

    const first = integrate({
      ...base(),
      branch: "agent/7",
      verify: async () => {
        await gate;
        return { ok: true, evidence: "" };
      },
    });

    // Long enough for the first to have cut its worktree and merged the base in.
    await new Promise((r) => setTimeout(r, 1_500));
    const second = await integrate({ ...base(), branch: "agent/8" });
    expect(second.ok, JSON.stringify(second)).toBe(true);

    releaseFirst();
    const loser = await first;

    // Both terminated, which is the first thing removing a lock has to keep.
    expect(loser.ok, JSON.stringify(loser)).toBe(false);
    if (loser.ok) return;
    expect(loser.reason).toBe("push-rejected");
    // The reason names the push, and carries git's own words about it.
    expect(loser.detail).toContain("develop");
    expect(loser.detail).toMatch(/rejected/i);

    const refusals = (await lane()).filter((e) => e.type === "IntegrationRefused");
    expect(refusals.some((r) => r.data["reason"] === "push-rejected")).toBe(true);

    // And exactly one of the two is on the base branch.
    const log = await exec("git", ["log", "--oneline", "develop"], { cwd: originPath });
    expect(log.stdout).toContain("work on agent/8");
    expect(log.stdout).not.toContain("work on agent/7");
  });

  /**
   * The worktree is the only thing the scope holds now, and it still unwinds.
   * A fixed `integrator-<base>` was safe only while the lock meant one
   * integration on a base at a time, so the race above would have had the two
   * of them standing in one directory.
   */
  it("leaves no worktree behind, and never two integrations in one directory", async () => {
    await branchWith("agent/9", { "src/f.ts": "export const f = 1;\n" });

    const result = await integrate({ ...base(), branch: "agent/9" });
    expect(result.ok, JSON.stringify(result)).toBe(true);

    const registered = await exec("git", ["worktree", "list", "--porcelain"], {
      cwd: join(home, "repos", `${PROJECT}.git`),
    });
    expect(registered.stdout).not.toContain("integrator-");
  });

  it("never returns without an event, whatever happened", async () => {
    // Every case above asserts its own event; this asserts the invariant across
    // all of them: the lane has exactly one terminal event per attempt.
    const events = await lane();
    const attempts = events.filter((e) => e.type === "IntegrationAttempted").length;
    const terminal = events.filter(
      (e) => e.type === "IntegrationRefused" || e.type === "IntegrationSucceeded",
    ).length;

    // One terminal per attempt exactly. Nothing refuses before it attempts any
    // more — `lane-busy` was the only path that did, and the lane takes no lock
    // to be refused by (#194).
    expect(terminal).toBe(attempts);
    expect(attempts).toBeGreaterThan(0);
  });
});
