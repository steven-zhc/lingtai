/**
 * The three answers in the live world that turn on this machine's log (#213,
 * #214): `logWhere`, `conducting`, and the drain.
 *
 * Each of them was a one-line `try { databaseUrl() } catch` — *is there a log*
 * asked as *does the Postgres getter throw*. Nothing typed that, so #179's
 * reviewer found one of the three in round one and another in round four, and
 * there was no moment where the migration was done because nothing enumerated
 * what done was. These three are that enumeration.
 *
 * Each case asserts the same two things: the answer, and that **nothing behind
 * the log was reached** to produce it. A version that catches the getter would
 * pass the first and fail the second, which is what the `catch` blocks never
 * had anyone check.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "@lingtai/env";
import { describe, expect, it } from "vitest";
import type { Drained } from "../src/install.ts";
import { liveDrain, liveWorld, type Live } from "../src/world.ts";

const URL_ = "postgresql://u:p@db.example.com:5432/postgres";

/**
 * A `Live` that records what was asked of it, so *not asked* is a thing a test
 * can see.
 *
 * `holds` is who the lock says is conducting, because since #214 that is what
 * the drain turns on: a machine with no store written and a daemon on it is the
 * case `lingtai upgrade` used to move the shim under.
 */
function outside(
  env: NodeJS.ProcessEnv,
  holds: string | null = "human:steven",
): { live: Live; asked: string[]; lines: string[] } {
  const asked: string[] = [];
  const lines: string[] = [];
  const live: Live = {
    env,
    log: (line) => lines.push(line),
    holder: async () => {
      asked.push("lock");
      return holds;
    },
    drain: async (reason, despiteDoctor): Promise<Drained> => {
      asked.push(`drain ${reason} ${String(despiteDoctor)}`);
      return { ok: true, after: async () => {} };
    },
  };
  return { live, asked, lines };
}

/**
 * **Where the log is, and not whether Postgres is configured** (#214).
 *
 * `logConfigured()` answered that second question under the first one's name.
 * The two were the same set of machines until #179 landed a store that is a
 * file: on a machine that wrote `store: sqlite` it said `false`, and `lingtai
 * uninstall` therefore removed the log without a word about it while printing
 * a paragraph about a GitHub App it could not remove.
 */
describe("logWhere", () => {
  const where = (env: NodeJS.ProcessEnv) => liveWorld("/v/1/lingtai", outside(env).live).logWhere();

  it("is nothing with nothing configured, and elsewhere with a Postgres URL", () => {
    expect(where({})).toEqual({ kind: "none" });
    expect(where({ LINGTAI_DATABASE_URL: URL_ })).toEqual({ kind: "elsewhere" });
  });

  /**
   * `lingtai uninstall`'s remedy is `LINGTAI_DATABASE_URL=<its log> lingtai
   * uninstall`, and its other one is *unset `LINGTAI_DATABASE_URL`*. Both are
   * only remedies while `elsewhere` is what that variable produces.
   */
  it("turns on the variable the uninstall's two remedies name", () => {
    expect(where({ LINGTAI_DATABASE_URL: URL_ }).kind).toBe("elsewhere");
    expect(where({}).kind).toBe("none");
  });

  /**
   * The machine the whole ticket is about: `database.store: sqlite`, no URL
   * anywhere, and a log that is a file **inside what `lingtai uninstall`
   * removes**. Named, with its path, so the command has something to say.
   */
  it("names the file on a machine that wrote store: sqlite", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-where-"));
    writeFileSync(join(home, "config.yml"), "database:\n  store: sqlite\n");

    expect(where({ LINGTAI_HOME: home })).toEqual({ kind: "file", path: join(home, "lingtai.db") });
  });

  /**
   * A refusal still reads the URL, so a machine `storeChoice` calls *not set
   * up* (0056 §2) — a `config.yml` with a `database.url` and no
   * `database.store` — goes on being told its log is somewhere else, exactly
   * as `logConfigured()` told it. Only a written `sqlite` takes the new branch.
   *
   * The variable is the half a handed-in environment can reach;
   * `postgresUrlIfSet` reads the machine file only for the real
   * `process.env` (`machineUrlIfReadable`), which
   * `packages/env/test/env.test.ts` covers.
   */
  it("falls back to the URL read, so a machine with no written store is still elsewhere", () => {
    expect(where({ LINGTAI_DATABASE_URL: URL_ })).toEqual({ kind: "elsewhere" });
  });
});

describe("conducting", () => {
  it("asks the lock where a log is configured", async () => {
    const o = outside({ LINGTAI_DATABASE_URL: URL_ });
    expect(await liveWorld("/v/1/lingtai", o.live).conducting()).toBe("human:steven");
    expect(o.asked).toEqual(["lock"]);
  });

  /**
   * The case the separation found. A daemon run from a checkout reads that
   * checkout's `.env.local`, so the installed copy can have no
   * `LINGTAI_DATABASE_URL` while a conductor is live — and its worktrees,
   * recipe and run logs are under the home `lingtai uninstall` would remove.
   *
   * The lock is a file under `~/.lingtai/locks/` since #193 and needs no
   * database to read, so *no log here* is not a reason to answer null about it.
   * Answering null is what put `install.ts` one `--nothing-conducts` away from
   * deleting a running conductor's worktrees.
   */
  it("asks the lock where no log is configured too, because the lock is a file (#193)", async () => {
    const o = outside({});
    expect(await liveWorld("/v/1/lingtai", o.live).conducting()).toBe("human:steven");
    expect(o.asked).toEqual(["lock"]);
  });

  /**
   * And the live `holder` can answer there, which is the whole of the claim
   * above: it imports `@lingtai/daemon/lock`, whose only dependency is
   * `@lingtai/env/lock`.
   *
   * **`@lingtai/daemon`'s index now loads there too, and that is #179.** It
   * used to be the counter-example this test carried — its index reaches
   * `@lingtai/event-store`, whose process-wide client called `postgresUrl()`
   * *at import* — so the gate this replaced was, in the end, about the import
   * and never about the lock. The store is a written choice now
   * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md)), and
   * a choice is read when a store is opened rather than when a module is
   * loaded.
   *
   * **What must not have moved is the refusal**, and the second half asserts
   * it: on a machine that has written nothing, the first use is refused by
   * name and names `lingtai init` — never defaulted to SQLite, which would
   * open a second, empty log and report every append into it as success
   * (0056 §2).
   *
   * A child process because that is what a module's import cost is measured in,
   * and `dir` so the probe never reads the operator's own lock.
   */
  it("reads the lock with nothing configured, where the daemon's index now loads and its first use is refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-lock-"));
    const script = join(dir, "probe.mjs");
    const module = (file: string) =>
      JSON.stringify(pathToFileURL(join(repoRoot(), "packages", "daemon", "src", file)).href);
    writeFileSync(
      script,
      `const { conductorLockHolder } = await import(${module("lock.ts")});\n` +
        `console.log(JSON.stringify(await conductorLockHolder({ dir: ${JSON.stringify(dir)} })));\n` +
        `try { await import(${module("index.ts")}); console.log("index loaded"); }\n` +
        `catch (err) { console.log("index refused: " + err.message.split("\\n")[0]); }\n` +
        `const { readStatus } = await import(${module("control.ts")});\n` +
        `try { await readStatus(); console.log("status answered"); }\n` +
        `catch (err) { console.log("first use refused: " + err.message.split("\\n")[0]); }\n`,
    );
    const ran = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      // Empty is absent to `optional`, and present to dotenv — so the
      // checkout's own `.env.local` cannot configure a log for this probe.
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, LINGTAI_HOME: dir, LINGTAI_DATABASE_URL: "" },
    });

    expect(ran.status).toBe(0);
    const said = ran.stdout.trim().split("\n");
    expect(said[0]).toBe("null");
    expect(said[1]).toBe("index loaded");
    expect(said[2]).toContain("first use refused");
    expect(said[2]).toContain("which store it runs");
    expect(said[2]).toContain("lingtai init");
    /**
     * **The only test in this file that spawns, and the default timeout is not
     * its bound.** Nothing above asserts a duration — the claims are an exit
     * status and two lines of stdout — so what the 5s default actually measures
     * is a cold Node start plus type-stripping the daemon's whole import graph,
     * on whatever machine happened to run it.
     *
     * It takes ~1.9s idle, which reads as 2.6× of headroom and is not: under
     * `pnpm -r` beside `apps/release`'s binary builds and `install.test.ts`'s
     * spawning, the same pass reported `import 66.28s` against 25–32s idle, and
     * this timed out at 5s. That red gate refused `#215`, whose diff does not
     * touch this import graph — measured head against base, three runs each,
     * 0.50–0.75s either way.
     *
     * **A longer bound weakens nothing here** and stops a loaded machine
     * refusing a diff for something the diff did not do.
     */
  }, 30_000);
});

describe("the drain", () => {
  it("drains where a conductor holds the lock, and says nothing of its own", async () => {
    const o = outside({ LINGTAI_DATABASE_URL: URL_ });
    expect(await liveDrain("upgrading", false, o.live)).toEqual({ ok: true, after: expect.any(Function) });
    expect(o.asked).toEqual(["lock", "drain upgrading false"]);
    expect(o.lines).toEqual([]);
  });

  it("says so and goes on where nothing conducts and no store is written, reaching neither the doctor nor the daemon", async () => {
    const o = outside({}, null);
    const drained = await liveDrain("upgrading", false, o.live);
    expect(drained.ok).toBe(true);
    expect(o.lines).toEqual([
      "nothing holds the conductor lock and this machine has written no store — nothing to drain",
    ]);
    expect(o.asked).toEqual(["lock"]);
  });

  /**
   * **The bug this replaced** (#214). `liveDrain` decided there was nothing to
   * drain from `logConfigured()`, which is `false` on a machine that wrote
   * `store: sqlite` — so `lingtai upgrade` reported a drain that never happened
   * and repointed the shim under a live conductor. 0042's rule is that a
   * refusal comes before the drain because a refusal after the drain is a
   * system that is down; this was no refusal, no drain, and the shim moved.
   *
   * The lock is a file under `~/.lingtai/locks/` since #193 and answers with no
   * database, which is why it is the thing to ask.
   */
  it("drains a machine whose store is a file, while a daemon holds the lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-drain-"));
    writeFileSync(join(home, "config.yml"), "database:\n  store: sqlite\n");
    const o = outside({ LINGTAI_HOME: home });

    expect(await liveDrain("upgrading", false, o.live)).toEqual({ ok: true, after: expect.any(Function) });
    expect(o.asked).toEqual(["lock", "drain upgrading false"]);
    expect(o.lines).toEqual([]);
  });

  /**
   * A held lock is not the only reason to reach the drain: `drainForUpgrade`
   * runs the doctor gate and adopts a drain this person left standing, both of
   * which want a log even where nothing holds the lock this second. So a
   * machine with a store and no conductor goes through, and `drainForUpgrade`
   * is what says *nothing is conducting* — with the log in front of it.
   */
  it("reaches the drain on a configured machine that nothing is conducting", async () => {
    const o = outside({ LINGTAI_DATABASE_URL: URL_ }, null);

    await liveDrain("upgrading", false, o.live);

    expect(o.asked).toEqual(["lock", "drain upgrading false"]);
    expect(o.lines).toEqual([]);
  });

  it("is what the world's own drain is, so an upgrade takes the same path", async () => {
    const o = outside({}, null);
    await liveWorld("/v/1/lingtai", o.live).drain("upgrading", true);
    expect(o.lines).toEqual([
      "nothing holds the conductor lock and this machine has written no store — nothing to drain",
    ]);

    const configured = outside({ LINGTAI_DATABASE_URL: URL_ });
    await liveWorld("/v/1/lingtai", configured.live).drain("upgrading", true);
    expect(configured.asked).toEqual(["lock", "drain upgrading true"]);
  });
});

/**
 * The world moved out of `entry.ts` so these tests could exist, and `self` is
 * the one thing that could not move with it: an upgrade compares it with the
 * shim, and `import.meta.filename` here would name this module rather than the
 * file the process was started from.
 */
describe("self", () => {
  it("is what it was handed, not this module", () => {
    const world = liveWorld("/v/versions/0.4.0/lingtai", outside({}).live);
    expect(world.self).toBe("/v/versions/0.4.0/lingtai");
  });
});
