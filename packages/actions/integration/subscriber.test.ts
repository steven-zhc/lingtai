/**
 * A subscriber, against real processes.
 *
 * Nothing is mocked, for `command.test.ts`'s reason: a subscriber *is* a
 * process and an exit code, and a test that stubs the process is testing a
 * description of one. The `subject` callback is the exception and has to be —
 * only the daemon has a log to read, and this package deliberately has none.
 *
 * Four properties, and the third is the one an earlier attempt at `#123` got
 * wrong badly enough to be refused: it delivered only events whose *stream* was
 * `wi-…`, and three of the four types this repository declares are appended to
 * a run stream or an integration lane. So the rule under test is that whatever
 * `subject` answers is what decides, and that the answer reaches the command as
 * a work item it can link to.
 */
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createSubscriber,
  subjectOf,
  type EventSubject,
  type SubscriberPayload,
} from "../src/index.ts";
import type { Envelope } from "@lingtai/domain";

const env = { PATH: process.env["PATH"] ?? "" };
let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "lingtai-subscriber-"));
});

const event = (type: string, streamId: string, data: unknown = {}): Envelope =>
  ({
    seq: 4_294_967_296n,
    streamId,
    version: 3,
    type,
    schemaVer: 1,
    actor: "conductor",
    causation: null,
    at: new Date("2026-09-10T09:00:00.000Z"),
    data,
  }) as Envelope;

/** The recipe block, as `.lingtai/config.yaml` writes it. */
const spec = (over: Partial<{ name: string; on: string[]; run: string; env: string[] }> = {}) => ({
  name: "desktop",
  on: ["ApprovalRequested", "WorkItemBlocked"],
  run: "cat > payload.json",
  env: [],
  ...over,
});

const build = (
  subject: (e: Envelope) => Promise<EventSubject | null>,
  over: Parameters<typeof spec>[0] = {},
) =>
  createSubscriber({
    project: "lingtai",
    spec: spec(over),
    subject,
    cwd,
    env,
    board: "http://localhost:3200",
  });

const delivered = async (): Promise<SubscriberPayload> =>
  JSON.parse(await readFile(join(cwd, "payload.json"), "utf8")) as SubscriberPayload;

describe("what starts a process and what does not", () => {
  it("starts one for a type the recipe named", async () => {
    const s = build(async () => subjectOf("lingtai", "123"));
    await s.deliver(event("WorkItemBlocked", "wi-lingtai-123"));

    expect((await delivered()).event.type).toBe("WorkItemBlocked");
  });

  /**
   * `on:` is the subscription as well as the declaration (0037 §3), so a type
   * nobody named costs a set lookup and not a fork.
   */
  it("starts none for a type it did not name, and does not even ask which project", async () => {
    let asked = 0;
    const s = build(async () => {
      asked += 1;
      return subjectOf("lingtai", "123");
    });
    await s.deliver(event("WorkItemLanded", "wi-lingtai-123"));

    expect(asked).toBe(0);
    await expect(delivered()).rejects.toThrow();
  });

  /**
   * The refusal that ended attempt 3 of `#123`, as a test.
   *
   * `ApprovalRequested` is appended to `run-<uuid>`, `RunAwaitingInput` to the
   * same, and `IntegrationRefused` to `int-lingtai-main`. A subscriber that
   * read the stream id for the project would deliver none of them while the
   * daemon printed that it was subscribed to all four — a notifier that has
   * silently stopped notifying, which is the one failure mode it must not have.
   */
  it("delivers an event whose own stream names no work item, when the caller resolves one", async () => {
    const s = build(async () => subjectOf("lingtai", "123"));
    await s.deliver(
      event("ApprovalRequested", `run-${crypto.randomUUID()}`, {
        gate: "merge",
        action: "approve",
        runId: "run-x",
        onSha: "abc",
        question: "Merge agent/123 into main?",
        artifacts: [],
      }),
    );

    const payload = await delivered();
    expect(payload.event.type).toBe("ApprovalRequested");
    expect(payload.workItem).toEqual({ id: "wi-lingtai-123", project: "lingtai", issue: "123" });
  });

  /** An event that belongs to no repository — `ctl-conductor`, `chat-…` — reaches nobody. */
  it("starts none when the caller says the event belongs to no project", async () => {
    const s = build(async () => null);
    await s.deliver(event("WorkItemBlocked", "ctl-conductor"));

    await expect(delivered()).rejects.toThrow();
  });

  /** Declared in one recipe, so it hears about one repository. */
  it("starts none for another project's event", async () => {
    const s = build(async () => subjectOf("admin", "155"));
    await s.deliver(event("WorkItemBlocked", "wi-admin-155"));

    await expect(delivered()).rejects.toThrow();
  });
});

describe("what the command is handed", () => {
  it("gets the envelope as JSON, with seq a string and at ISO-8601", async () => {
    const s = build(async () => subjectOf("lingtai", "123"));
    await s.deliver(event("WorkItemBlocked", "wi-lingtai-123", { question: "which base?" }));

    const payload = await delivered();
    // A number here would have lost the log's own identity for a stream past
    // 2^53 — `seq` is a bigint and JSON has no such thing.
    expect(payload.event.seq).toBe("4294967296");
    expect(payload.event.at).toBe("2026-09-10T09:00:00.000Z");
    expect(payload.event.data).toEqual({ question: "which base?" });
    expect(payload.board).toBe("http://localhost:3200");
  });

  /** 0037 §1: the declared set is the whole set. Nothing declared, nothing but `runnableEnv`'s. */
  it("gets only the environment it was given", async () => {
    const s = build(async () => subjectOf("lingtai", "123"), {
      run: "env | grep -c SECRET_TOKEN > count.txt; true",
    });
    await s.deliver(event("WorkItemBlocked", "wi-lingtai-123"));

    expect((await readFile(join(cwd, "count.txt"), "utf8")).trim()).toBe("0");
  });
});

describe("what a failure does", () => {
  /**
   * The exit code is read here and nowhere else. It becomes a rejection, which
   * `work-loop.ts`'s boundary turns into `PluginFailed` — 0037 §7's "a
   * subscriber whose failure is a console line is a notifier that has silently
   * stopped notifying".
   */
  it("rejects with the evidence when the command exits non-zero", async () => {
    const s = build(async () => subjectOf("lingtai", "123"), {
      run: "echo 'no notification daemon' >&2; exit 3",
    });

    await expect(s.deliver(event("WorkItemBlocked", "wi-lingtai-123"))).rejects.toThrow(
      /exited 3[\s\S]*no notification daemon/,
    );
  });

  it("rejects when the command does not exist, naming it", async () => {
    const s = build(async () => subjectOf("lingtai", "123"), { run: "definitely-not-a-binary" });

    await expect(s.deliver(event("WorkItemBlocked", "wi-lingtai-123"))).rejects.toThrow(
      /definitely-not-a-binary/,
    );
  });

  /**
   * A `subject` that throws is the daemon's log being unreachable. It must not
   * become an unhandled rejection in the process following the log, so it
   * settles the delivery the same way any other failure does.
   */
  it("rejects when the caller could not say which project it was", async () => {
    const s = build(async () => {
      throw new Error("the log is unreachable");
    });

    await expect(s.deliver(event("WorkItemBlocked", "wi-lingtai-123"))).rejects.toThrow(
      "the log is unreachable",
    );
  });
});
