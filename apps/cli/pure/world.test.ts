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

  it("answers null where none is, without asking the lock at all", async () => {
    const o = outside({});
    expect(await liveWorld("/v/1/lingtai", o.live).conducting()).toBeNull();
    // The lock lives in the log. Reaching it would mean loading `@lingtai/daemon`
    // on a machine that has just been installed, which is what `entry.ts` exists
    // to avoid.
    expect(o.asked).toEqual([]);
  });
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
