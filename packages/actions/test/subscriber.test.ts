/**
 * A subscriber that is a command, against real processes.
 *
 * Nothing is mocked here for the reason nothing is mocked in `gate.test.ts`: a
 * subscriber is a command, a stdin and an exit code, and a test that stubs the
 * command tests none of them. What matters is that the event arrives on stdin
 * as something the receiving process can parse, that the process is given the
 * names the recipe declared **and nothing else**, and that every way of
 * failing comes back as a rejection — because that is what `deliver` turns
 * into `PluginFailed` (0037 §7).
 */
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Envelope } from "@lingtai/domain";
import type { Subscriber } from "@lingtai/recipe";
import { describe, expect, it } from "vitest";
import { subscribersFromRecipe, wireEvent } from "../src/index.ts";

const runnable = { PATH: process.env["PATH"] ?? "" };

const event = (type: string, streamId = "wi-lingtai-125"): Envelope => ({
  seq: 4821n,
  streamId,
  version: 7,
  type,
  schemaVer: 1,
  data: { mergeCommit: "9f2c", base: "main" },
  actor: "conductor",
  causation: 4820n,
  at: new Date("2026-09-10T12:00:00.000Z"),
});

const declare = (over: Partial<Subscriber> = {}): Subscriber => ({
  name: "telegram",
  on: ["WorkItemLanded", "WorkItemBlocked"],
  run: "exit 0",
  env: [],
  ...over,
});

const build = (declared: Subscriber, env: Record<string, string> = runnable) =>
  subscribersFromRecipe("lingtai", [declared], { env: () => env, cwd: tmpdir() })[0]!;

describe("what a subscriber is offered", () => {
  it("takes the types it declared and no others", () => {
    const telegram = build(declare());
    expect(telegram.wants(event("WorkItemLanded"))).toBe(true);
    expect(telegram.wants(event("WorkItemBlocked"))).toBe(true);
    expect(telegram.wants(event("RunStarted"))).toBe(false);
  });

  it("takes its own project's events, not another project's", () => {
    const telegram = build(declare());
    expect(telegram.wants(event("WorkItemLanded", "wi-lingtai-125"))).toBe(true);
    expect(telegram.wants(event("WorkItemLanded", "wi-admin-4"))).toBe(false);
  });

  it("takes an event that names no project, which belongs to the installation", () => {
    // A pause is `ctl-conductor`, and a stream-name parse that stripped the
    // prefix would read its project as "ctl" and deliver it to nobody.
    const paused = build(declare({ on: ["ConductorPaused"] }));
    expect(paused.wants(event("ConductorPaused", "ctl-conductor"))).toBe(true);
  });
});

describe("the conversation with the process", () => {
  it("hands the event over as JSON on stdin, seq included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingtai-sub-"));
    const file = join(dir, "stdin.json");
    const telegram = build(declare({ run: `cat > ${file}` }));

    await telegram.consider(event("WorkItemLanded"));

    const written = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    expect(written["type"]).toBe("WorkItemLanded");
    expect(written["streamId"]).toBe("wi-lingtai-125");
    // A bigint cannot be stringified, so both of these are decimal strings and
    // a subscriber that expected numbers would be the one to change.
    expect(written["seq"]).toBe("4821");
    expect(written["causation"]).toBe("4820");
    expect(written["at"]).toBe("2026-09-10T12:00:00.000Z");
  });

  it("refuses to make an envelope JSON cannot carry", () => {
    // The regression this file exists for: `JSON.stringify` throws on a
    // bigint, so an envelope sent as it stands would fail on every event —
    // inside the boundary, where it reads as a broken extension.
    expect(() => JSON.stringify(event("WorkItemLanded"))).toThrow(TypeError);
    expect(() => JSON.stringify(wireEvent(event("WorkItemLanded")))).not.toThrow();
  });

  /**
   * 0037 §1, for a subscriber rather than a gate action.
   *
   * *"A Telegram bot token must reach the Telegram extension and nothing
   * else."* Both halves in one test, as in `gate.test.ts`: an environment that
   * is empty proves nothing and one that is full proves nothing either.
   */
  it("reads what it declared and cannot read the log's own name beside it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingtai-sub-"));
    const file = join(dir, "env.txt");
    const telegram = build(
      declare({ run: `echo "declared=[\${TELEGRAM_BOT_TOKEN-}] other=[\${LINGTAI_DATABASE_URL-}]" > ${file}` }),
      { ...runnable, TELEGRAM_BOT_TOKEN: "bot-token" },
    );

    // This process holds the log's connection string while the child runs,
    // which is the daemon's situation exactly.
    process.env["LINGTAI_DATABASE_URL"] = "postgres://the-log";
    try {
      await telegram.consider(event("WorkItemLanded"));
    } finally {
      delete process.env["LINGTAI_DATABASE_URL"];
    }

    expect(await readFile(file, "utf8")).toBe("declared=[bot-token] other=[]\n");
  });
});

describe("a failure is a rejection, which is what becomes an event", () => {
  it("rejects with the evidence when the command exits non-zero", async () => {
    const telegram = build(declare({ run: "echo 'telegram refused: chat not found' >&2; exit 1" }));
    await expect(telegram.consider(event("WorkItemLanded"))).rejects.toThrow(/chat not found/);
  });

  it("rejects when the command does not exist, naming it", async () => {
    const telegram = build(declare({ run: "definitely-not-a-command" }));
    await expect(telegram.consider(event("WorkItemLanded"))).rejects.toThrow(
      /definitely-not-a-command/,
    );
  });

  it("rejects when the process is killed mid-event", async () => {
    // The ticket's own case: somebody kills the extension while it is working.
    // It is a signal rather than an exit code, and what must not happen is the
    // promise never settling — the follower would be waiting on a process that
    // is already gone.
    const telegram = build(declare({ run: "kill -9 $$" }));
    await expect(telegram.consider(event("WorkItemLanded"))).rejects.toThrow();
  });

  it("rejects when it hangs, rather than never settling", async () => {
    const telegram = subscribersFromRecipe("lingtai", [declare({ run: "sleep 30" })], {
      env: () => runnable,
      cwd: tmpdir(),
      timeoutMs: 200,
    })[0]!;
    await expect(telegram.consider(event("WorkItemLanded"))).rejects.toThrow(/timed out/);
  });

  it("resolves on exit 0, so a working subscriber records nothing", async () => {
    const telegram = build(declare({ run: "exit 0" }));
    await expect(telegram.consider(event("WorkItemLanded"))).resolves.toBeUndefined();
  });
});
