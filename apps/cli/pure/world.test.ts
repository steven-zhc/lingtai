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
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
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
    expect(where({ LINGTAI_DATABASE_URL: URL_ })).toEqual({
      kind: "elsewhere",
      named: "LINGTAI_DATABASE_URL names",
    });
  });

  /**
   * **And the sentence is only true on one of the two machines with a log
   * elsewhere** (#214). An operator who typed a URL into `lingtai init` has it
   * in `~/.lingtai/config.yml` and nothing exported, so *the database
   * LINGTAI_DATABASE_URL names* is a line pointing at an unset variable —
   * printed after the `rmSync` that took the file which held the answer. The
   * URL itself is what still names that database afterwards, redacted because
   * `redactUrl` is the one rule about printing one.
   */
  it("names a config.yml's database by its URL, because that file is what the removal takes", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-typed-"));
    writeFileSync(join(home, "config.yml"), `database:\n  store: postgres\n  url: ${URL_}\n`);

    expect(where({ LINGTAI_HOME: home })).toEqual({
      kind: "elsewhere",
      named: "at postgresql://u:***@db.example.com:5432/postgres",
    });
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
    // Content nothing reads: whether the log is there is the whole question.
    writeFileSync(join(home, "lingtai.db"), "");

    expect(where({ LINGTAI_HOME: home })).toEqual({
      kind: "file",
      path: join(home, "lingtai.db"),
      alsoElsewhere: false,
    });
  });

  /**
   * **A path is not a file** (#214). `lingtai init` writes `store: sqlite` and
   * stops — the log is created on first open — so the machine it leaves behind
   * has a chosen store and nothing at the path. `file` there had `uninstall`
   * telling an operator who changed their mind that it was destroying every
   * event this machine recorded, and that they could not be recovered, about a
   * file that never existed.
   */
  it("says nothing of a chosen sqlite whose log has never been opened", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-unopened-"));
    writeFileSync(join(home, "config.yml"), "database:\n  store: sqlite\n");

    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
    expect(where({ LINGTAI_HOME: home })).toEqual({ kind: "none" });
  });

  /**
   * **The blocker: a chosen Postgres with the old log still sitting there**
   * (#214).
   *
   * 0056 §3's documented way to move a machine to Postgres is to *export*
   * `LINGTAI_DATABASE_URL` — launchd, a container, a shell rc — rather than to
   * edit `config.yml`, and `storeChoice` takes that variable before it ever
   * opens the file. So this machine is `{store:"postgres", where:"environment"}`
   * with `store: sqlite` still written and the whole of its old log in
   * `lingtai.db`. Asked only under a refusal, the file was never looked for:
   * `uninstall` deleted it and printed *the database LINGTAI_DATABASE_URL names
   * is untouched*, and 0055 §3 says the Postgres log started empty rather than
   * carrying anything over, so that file was the only copy.
   *
   * Both facts, because the command has two things to say and neither may be
   * said in the other's words.
   */
  it("names the file a chosen Postgres left behind, and says the server is there too", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-switched-"));
    writeFileSync(join(home, "config.yml"), "database:\n  store: sqlite\n");
    writeFileSync(join(home, "lingtai.db"), "");

    expect(where({ LINGTAI_HOME: home, LINGTAI_DATABASE_URL: URL_ })).toEqual({
      kind: "file",
      path: join(home, "lingtai.db"),
      alsoElsewhere: true,
    });
  });

  /**
   * And the same machine whose `config.yml` was rewritten to `store: postgres`
   * instead of the variable being exported, with the old file still in place.
   * The written choice is not what decides whether a file is there.
   */
  it("names it for a written store: postgres as well", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-rewritten-"));
    writeFileSync(join(home, "config.yml"), `database:\n  store: postgres\n  url: ${URL_}\n`);
    writeFileSync(join(home, "lingtai.db"), "");

    expect(where({ LINGTAI_HOME: home })).toEqual({
      kind: "file",
      path: join(home, "lingtai.db"),
      alsoElsewhere: true,
    });
  });

  /**
   * **The refusals, which are where the log is in front of you and the choice
   * is not.**
   *
   * A machine that wrote `store: sqlite` and later added a `database.url` to
   * the same file, halfway to Postgres, is `two keys` — and its log is still
   * the file it has been recording into all along. Asked `logConfigured()`
   * there, the answer is `true`, because the `database.url` it just refused
   * over is the URL that read finds: `elsewhere`, about a log two lines above
   * an `rmSync` that takes it (#214).
   */
  it("names the file under a two keys refusal, where the log is the one being destroyed", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-two-keys-"));
    writeFileSync(join(home, "config.yml"), `database:\n  store: sqlite\n  url: ${URL_}\n`);
    // Content nothing reads: whether the log is there is the whole question.
    writeFileSync(join(home, "lingtai.db"), "");

    // `alsoElsewhere` is `false` for the reason the probe at the end of this
    // block gives, and not because the URL in that file is nothing: a
    // handed-in environment never has the machine file read for a URL, so
    // in-process the refusal's `logConfigured()` half cannot answer.
    expect(where({ LINGTAI_HOME: home })).toEqual({
      kind: "file",
      path: join(home, "lingtai.db"),
      alsoElsewhere: false,
    });
  });

  /**
   * And the same machine with its `config.yml` truncated mid-write, which is
   * the case `storeChoice` is total *for*: `unreadable` says nothing about the
   * store, `logConfigured()` answers `false` because there is no URL left to
   * read, and `none` would have let `lingtai uninstall --yes` delete the log
   * without one word about it.
   */
  it("names the file under an unreadable config.yml too, which is the one storeChoice is total for", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-unreadable-"));
    writeFileSync(join(home, "config.yml"), "database:\n  store: sqli");
    // Content nothing reads: whether the log is there is the whole question.
    writeFileSync(join(home, "lingtai.db"), "");

    expect(where({ LINGTAI_HOME: home })).toEqual({
      kind: "file",
      path: join(home, "lingtai.db"),
      alsoElsewhere: false,
    });
  });

  /**
   * Only *no file* is nothing to lose. A machine `storeChoice` calls **not set
   * up** (0056 §2) — a `config.yml` with a `database.url` and no
   * `database.store` — has never opened a log here, so the question left is the
   * one `logConfigured()` always answered, and the answer is the one it gave.
   */
  it("falls back to the URL read where the refusal has left no file behind", () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-no-store-"));
    writeFileSync(join(home, "config.yml"), `database:\n  url: ${URL_}\n`);

    expect(where({ LINGTAI_HOME: home })).toEqual({ kind: "none" });
  });

  /**
   * **And that fallback is `logConfigured()` and not a constant**, which is a
   * claim no handed-in environment can check: `postgresUrlIfSet` reads the
   * machine's `config.yml` only for the real `process.env`
   * (`machineUrlIfReadable`), so in-process the refusal with no file is
   * `none` whatever that file says.
   *
   * So: a child, whose `process.env` really is this machine's, whose
   * `config.yml` names a `database.url` and no `database.store`, and whose
   * `~/.lingtai` holds no log. `elsewhere` there is the sentence `lingtai
   * uninstall` prints about a Postgres log it leaves standing, and its two
   * remedies both name that URL.
   *
   * `LINGTAI_DATABASE_URL` empty for the reason the probe below gives: absent
   * to `optional`, present to dotenv, so the checkout's `.env.local` cannot be
   * what answers this.
   */
  it("reads that URL from the machine file, on a process whose environment is a machine's", () => {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-refused-"));
    writeFileSync(join(dir, "config.yml"), `database:\n  url: ${URL_}\n`);
    const script = join(dir, "probe.mjs");
    const world = JSON.stringify(pathToFileURL(join(repoRoot(), "apps", "cli", "src", "world.ts")).href);
    writeFileSync(
      script,
      `const { logLocation } = await import(${world});\n` +
        `console.log(JSON.stringify(logLocation(process.env)));\n`,
    );
    const ran = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: { PATH: process.env["PATH"] ?? "", HOME: dir, LINGTAI_HOME: dir, LINGTAI_DATABASE_URL: "" },
    });

    expect(ran.stderr).toBe("");
    expect(ran.status).toBe(0);
    // And named by that URL and not by the empty variable: the file it was read
    // from is inside what the removal takes.
    expect(JSON.parse(ran.stdout.trim())).toEqual({
      kind: "elsewhere",
      named: "at postgresql://u:***@db.example.com:5432/postgres",
    });
  }, 30_000);
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

  /**
   * **And a written store is what that turns on, not a file that exists**
   * (#214). `logWhere` above answers `none` for a chosen SQLite whose log has
   * never been opened, because there is nothing there for an uninstall to
   * destroy — and this machine has still chosen a store, so its doctor gate and
   * a drain somebody left standing are its own. Asking `logWhere` here would
   * skip the drain on it and say *this machine has written no store*, which is
   * a sentence its `config.yml` disproves.
   */
  it("reaches the drain on a machine that chose sqlite and has not opened the log", async () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-unopened-drain-"));
    writeFileSync(join(home, "config.yml"), "database:\n  store: sqlite\n");
    const o = outside({ LINGTAI_HOME: home }, null);

    expect(existsSync(join(home, "lingtai.db"))).toBe(false);
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
