/**
 * The three answers in the live world that turn on whether a log is configured
 * (#213): `logConfigured`, `conducting`, and the drain.
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

/** A `Live` that records what was asked of it, so *not asked* is a thing a test can see. */
function outside(env: NodeJS.ProcessEnv): { live: Live; asked: string[]; lines: string[] } {
  const asked: string[] = [];
  const lines: string[] = [];
  const live: Live = {
    env,
    log: (line) => lines.push(line),
    holder: async () => {
      asked.push("lock");
      return "human:steven";
    },
    drain: async (reason, despiteDoctor): Promise<Drained> => {
      asked.push(`drain ${reason} ${String(despiteDoctor)}`);
      return { ok: true, after: async () => {} };
    },
  };
  return { live, asked, lines };
}

describe("logConfigured", () => {
  it("is false with nothing configured and true with a log, and neither is an exception", () => {
    expect(liveWorld("/v/1/lingtai", outside({}).live).logConfigured()).toBe(false);
    expect(liveWorld("/v/1/lingtai", outside({ LINGTAI_DATABASE_URL: URL_ }).live).logConfigured()).toBe(true);
  });

  /**
   * `lingtai uninstall`'s remedy is `LINGTAI_DATABASE_URL=<its log> lingtai
   * uninstall`, and its other one is *unset `LINGTAI_DATABASE_URL`*. Both are
   * only remedies while that variable is what this answer turns on.
   */
  it("turns on the variable the uninstall's two remedies name", () => {
    const world = (env: NodeJS.ProcessEnv): boolean => liveWorld("/v/1/lingtai", outside(env).live).logConfigured();
    expect(world({ LINGTAI_DATABASE_URL: URL_ })).toBe(true);
    expect(world({})).toBe(false);
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
   * `@lingtai/env/lock`. `@lingtai/daemon` itself cannot be asked — its index
   * reaches `@lingtai/event-store`, whose process-wide client calls
   * `postgresUrl()` at import — so the gate this replaced was, in the end,
   * about the import and never about the lock.
   *
   * A child process because that is what a module's import cost is measured in,
   * and `dir` so the probe never reads the operator's own lock.
   */
  it("reads the lock with nothing configured, where the daemon's index cannot even load", () => {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-lock-"));
    const script = join(dir, "probe.mjs");
    const module = (file: string) =>
      JSON.stringify(pathToFileURL(join(repoRoot(), "packages", "daemon", "src", file)).href);
    writeFileSync(
      script,
      `const { conductorLockHolder } = await import(${module("lock.ts")});\n` +
        `console.log(JSON.stringify(await conductorLockHolder({ dir: ${JSON.stringify(dir)} })));\n` +
        `try { await import(${module("index.ts")}); console.log("index loaded"); }\n` +
        `catch (err) { console.log("index refused: " + err.message.split("\\n")[0]); }\n`,
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
    expect(said[1]).toContain("index refused");
    expect(said[1]).toContain("LINGTAI_DATABASE_URL is not set");
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
  it("drains where a log is configured, and says nothing of its own", async () => {
    const o = outside({ LINGTAI_DATABASE_URL: URL_ });
    expect(await liveDrain("upgrading", false, o.live)).toEqual({ ok: true, after: expect.any(Function) });
    expect(o.asked).toEqual(["drain upgrading false"]);
    expect(o.lines).toEqual([]);
  });

  it("says so and goes on where none is, reaching neither the doctor nor the daemon", async () => {
    const o = outside({});
    const drained = await liveDrain("upgrading", false, o.live);
    expect(drained.ok).toBe(true);
    expect(o.lines).toEqual(["no log is configured here, so nothing conducts from it — nothing to drain"]);
    expect(o.asked).toEqual([]);
  });

  it("is what the world's own drain is, so an upgrade takes the same path", async () => {
    const o = outside({});
    await liveWorld("/v/1/lingtai", o.live).drain("upgrading", true);
    expect(o.lines).toEqual(["no log is configured here, so nothing conducts from it — nothing to drain"]);

    const configured = outside({ LINGTAI_DATABASE_URL: URL_ });
    await liveWorld("/v/1/lingtai", configured.live).drain("upgrading", true);
    expect(configured.asked).toEqual(["drain upgrading true"]);
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
