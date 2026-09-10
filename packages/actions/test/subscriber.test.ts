/**
 * The subscriber runner, against real processes.
 *
 * No stub for the spawning: everything worth asserting here is about what one
 * process can do to another — reading stdin or not reading it, exiting 3, being
 * killed, holding a variable it was never given. A fake `spawn` would pass all
 * five while proving none of them.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSubscriber, subscriberPayload } from "../src/index.ts";
import type { Subscriber } from "@lingtai/recipe";
import type { Envelope } from "@lingtai/domain";

const dir = mkdtempSync(join(tmpdir(), "lingtai-subscriber-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const event = (over: Partial<Envelope> = {}): Envelope => ({
  seq: 4231n,
  streamId: "wi-lingtai-126",
  version: 7,
  type: "WorkItemLanded",
  schemaVer: 1,
  data: { mergeCommit: "abc1234def", base: "main" },
  actor: "conductor",
  causation: 4230n,
  at: new Date("2026-09-10T09:12:44.000Z"),
  ...over,
});

const spec = (over: Partial<Subscriber>): Subscriber => ({
  name: "test",
  on: ["WorkItemLanded"],
  run: "true",
  timeout: "10s",
  env: [],
  ...over,
});

const payload = (over: Partial<Envelope> = {}) =>
  subscriberPayload(event(over), { boardUrl: "http://localhost:3200" });

describe("runSubscriber", () => {
  it("hands the event to the command on stdin, and returns when it exits 0", async () => {
    const out = join(dir, "stdin.json");
    await runSubscriber(spec({ run: `cat > ${out}` }), {
      cwd: dir,
      env: {},
      payload: payload(),
    });

    const seen = JSON.parse(readFileSync(out, "utf8")) as ReturnType<typeof payload>;
    expect(seen.schema).toBe(1);
    expect(seen.event.type).toBe("WorkItemLanded");
    // A bigint would have thrown on the way out, and a number would have
    // arrived rounded. It is a string on purpose.
    expect(seen.event.seq).toBe("4231");
    expect(seen.ticket).toEqual({ project: "lingtai", issue: "126", stream: "wi-lingtai-126" });
    expect(seen.board.task).toBe("http://localhost:3200/task/wi-lingtai-126");
  });

  /**
   * 0037 §4's promise, and the reason `stdin` could be added to `runCommand` at
   * all: every `run:` in every recipe that works today is a command that does
   * not read stdin, and not one of them may start failing because something now
   * offers it something. The pipe breaks; that is not the command's problem.
   */
  it("does not fail a command that ignores stdin", async () => {
    await expect(
      runSubscriber(spec({ run: "true" }), { cwd: dir, env: {}, payload: payload() }),
    ).resolves.toBeUndefined();
  });

  it("rejects when the command refuses, with what it printed", async () => {
    await expect(
      runSubscriber(spec({ run: "echo 'chat not found' >&2; exit 3" }), {
        cwd: dir,
        env: {},
        payload: payload(),
      }),
    ).rejects.toThrow(/chat not found/);
  });

  /**
   * `#126`'s *killing an extension mid-event*, at this level: a process that
   * dies without an exit code is a failure like any other, and the caller is
   * told by the only mechanism it has — a rejection. What the daemon does with
   * that is `work-loop.ts`'s test.
   */
  it("rejects when the command is killed rather than exiting", async () => {
    await expect(
      runSubscriber(spec({ run: "kill -9 $$" }), { cwd: dir, env: {}, payload: payload() }),
    ).rejects.toThrow();
  });

  it("rejects a subscriber that hangs, and says it timed out", async () => {
    await expect(
      runSubscriber(spec({ run: "sleep 30", timeout: "300ms" }), {
        cwd: dir,
        env: {},
        payload: payload(),
      }),
    ).rejects.toThrow(/timed out after 300ms/);
  });

  /**
   * The environment is **built**, not inherited — 0037 §1, from the other side.
   * This process has `LINGTAI_TEST_DATABASE_URL` set (the suite refuses to run
   * without it) and the extension does not, because nothing passed it on.
   */
  it("gives the command only the environment it was handed", async () => {
    const out = join(dir, "env.txt");
    process.env["LINGTAI_MADE_UP_FOR_THIS_TEST"] = "the conductor's own";
    try {
      await runSubscriber(spec({ run: `printenv > ${out} || true` }), {
        cwd: dir,
        env: { PATH: process.env["PATH"] ?? "", TELEGRAM_BOT_TOKEN: "t0ken" },
        payload: payload(),
      });
    } finally {
      delete process.env["LINGTAI_MADE_UP_FOR_THIS_TEST"];
    }

    const seen = readFileSync(out, "utf8");
    expect(seen).toContain("TELEGRAM_BOT_TOKEN=t0ken");
    expect(seen).not.toContain("LINGTAI_MADE_UP_FOR_THIS_TEST");
    expect(seen).not.toContain("LINGTAI_TEST_DATABASE_URL");
  });
});

describe("subscriberPayload", () => {
  /**
   * A `RunAwaitingInput` is on `run-<uuid>` and an `IntegrationRefused` is on
   * `int-<project>-<base>`; neither stream id carries a ticket. The notifier
   * this replaces derived what it could from the id and left the rest null,
   * which is why a question from a running agent reached a laptop with no
   * number and no link on it.
   */
  it("takes the ticket from the caller for a stream that does not carry one", () => {
    const p = subscriberPayload(
      event({ streamId: "run-8f2c", type: "RunAwaitingInput", data: { prompt: "Which base?" } }),
      { boardUrl: "http://board", project: "lingtai", workItem: "wi-lingtai-126" },
    );

    expect(p.project).toBe("lingtai");
    expect(p.ticket?.issue).toBe("126");
    expect(p.board.task).toBe("http://board/task/wi-lingtai-126");
    // The event itself is untouched — it is still the run's.
    expect(p.event.streamId).toBe("run-8f2c");
  });

  it("has no ticket and no link when nothing can name one", () => {
    const p = subscriberPayload(event({ streamId: "ctl-conductor", type: "ConductorPaused" }), {
      boardUrl: "http://board",
    });
    expect(p.project).toBeNull();
    expect(p.ticket).toBeNull();
    expect(p.board.task).toBeNull();
  });
});
