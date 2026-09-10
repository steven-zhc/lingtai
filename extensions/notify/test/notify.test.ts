/**
 * The notifier, as an extension.
 *
 * The rendering is pure and tested directly. The command itself is run as a
 * command — spawned, fed JSON on stdin, its exit code read — because that is
 * the entire contract and testing it by importing `main()` would test something
 * the core never does.
 *
 * What is *not* here is a delivered notification: `osascript` on a build
 * machine would either fail or interrupt whoever is at the keyboard. The
 * channel's two branches are one `which` and one spawn, and the thing worth
 * proving about them — that a refusal reaches the exit code — is proved by the
 * empty-stdin case, which fails before either is reached.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePayload } from "../src/payload.ts";
import { describe as render } from "../src/render.ts";
import { recordingChannel } from "../src/channel.ts";

const BIN = fileURLToPath(new URL("../src/notify.ts", import.meta.url));

const payload = (type: string, data: unknown, ticket = true) => ({
  schema: 1,
  event: {
    seq: "1",
    streamId: ticket ? "wi-lingtai-126" : "ctl-conductor",
    version: 1,
    type,
    schemaVer: 1,
    actor: "conductor",
    causation: null,
    at: "2026-09-10T09:12:44.000Z",
    data,
  },
  project: ticket ? "lingtai" : null,
  ticket: ticket ? { project: "lingtai", issue: "126", stream: "wi-lingtai-126" } : null,
  board: {
    url: "http://localhost:3200",
    task: ticket ? "http://localhost:3200/task/wi-lingtai-126" : null,
  },
});

/** Runs the extension the way the daemon does: stdin, then EOF. */
function run(stdin: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (c: Buffer) => (output += c.toString()));
    child.stderr.on("data", (c: Buffer) => (output += c.toString()));
    child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(stdin);
  });
}

describe("what a notification says", () => {
  it("asks the question rather than stating the fact", () => {
    const n = render(parsePayload(JSON.stringify(payload("WorkItemBlocked", { question: "Which base?" }))));
    expect(n.title).toBe("#126 is blocked");
    expect(n.body).toBe("Which base?");
    expect(n.url).toBe("http://localhost:3200/task/wi-lingtai-126");
  });

  /**
   * The ticket comes from the payload now, not from the stream id. A question
   * from a running agent is on `run-<uuid>`, and used to arrive with no number
   * on it at all — the core resolves it before the extension is started.
   */
  it("names the ticket for an event whose own stream does not", () => {
    const p = payload("RunAwaitingInput", { prompt: "Which base?" });
    p.event.streamId = "run-8f2c";
    const n = render(parsePayload(JSON.stringify(p)));
    expect(n.title).toBe("#126 is asking");
    expect(n.url).toBe("http://localhost:3200/task/wi-lingtai-126");
  });

  it("still says something true about a type it has never seen", () => {
    const n = render(parsePayload(JSON.stringify(payload("QueueChanged", {}))));
    expect(n.title).toBe("#126");
    expect(n.body).toBe("QueueChanged");
  });

  it("has no link when nothing can name a task", () => {
    const n = render(parsePayload(JSON.stringify(payload("ConductorPaused", {}, false))));
    expect(n.url).toBeNull();
    expect(n.title).toBe("ConductorPaused");
  });
});

describe("the channel", () => {
  it("records rather than interrupts, when that is what it is", async () => {
    const channel = recordingChannel();
    await channel.send(render(parsePayload(JSON.stringify(payload("WorkItemLanded", { mergeCommit: "abc1234def" })))));
    expect(channel.sent[0]?.title).toBe("#126 landed");
  });
});

describe("as a command", () => {
  /**
   * The whole contract, from the outside: a non-zero exit is the only thing it
   * can say, and it is what becomes `PluginFailed` on the log.
   */
  it("refuses with a message when it is run by hand, with nothing on stdin", async () => {
    const { code, output } = await run("");
    expect(code).toBe(1);
    expect(output).toContain("nothing on stdin");
  });

  it("refuses when stdin is not the payload", async () => {
    const { code, output } = await run("not json at all");
    expect(code).toBe(1);
    expect(output).toContain("stdin was not JSON");
  });
});
