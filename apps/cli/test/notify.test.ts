/**
 * The desktop notification, now that it is a command.
 *
 * Two things are worth pinning and they are the two the old `notify.ts` could
 * not be asked about, because it was a channel constructed by name inside the
 * daemon:
 *
 * **It is exit code 1 when the notification did not go out.** That is the whole
 * of what this process can say about itself, and the daemon turns it into
 * `PluginFailed` (0037 §7). The old `send` discarded `osascript`'s exit code,
 * which was harmless while nothing above it read one and is not now.
 *
 * **A card is named from `workItem`, not from the stream id.** `#123`'s other
 * half: `ApprovalRequested` is appended to a *run* stream, so the version that
 * read the stream id rendered the two events that most needed a link with an
 * empty `#` and none.
 *
 * `exec` is the only seam, and it is a seam because there is no way to make a
 * working `osascript` refuse.
 */
import { describe, expect, it } from "vitest";
import {
  describe as render,
  macNotifier,
  notifyCommand,
  parsePayload,
  type Exec,
  type NotifyPayload,
} from "../src/notify.ts";

const payload = (type: string, data: unknown): NotifyPayload => ({
  event: { type, data },
  workItem: { id: "wi-lingtai-123", project: "lingtai", issue: "123" },
  board: "http://localhost:3200",
});

/** Records what was spawned, and answers with whatever the test wants. */
const recorder = (answer: (bin: string) => number | null = () => 0) => {
  const calls: { bin: string; args: string[] }[] = [];
  const exec: Exec = async (bin, args) => {
    calls.push({ bin, args });
    return answer(bin);
  };
  return { calls, exec };
};

describe("what the operator reads", () => {
  it("asks the question rather than stating the fact", () => {
    const n = render(payload("ApprovalRequested", { question: "Merge agent/123 into main?" }));

    expect(n.title).toBe("#123 is waiting on you");
    expect(n.body).toBe("Merge agent/123 into main?");
  });

  /**
   * The card, for an event on a run stream. Nothing in `streamId` says `123`
   * here — the daemon resolved it through the run's `RunStarted` — and this is
   * where that arrives.
   */
  it("links to the card an event was resolved to, whatever stream it was on", () => {
    const n = render(payload("RunAwaitingInput", { prompt: "which base?" }));

    expect(n.title).toBe("#123 is asking");
    expect(n.url).toBe("http://localhost:3200/task/wi-lingtai-123");
  });

  it("says both halves of a refusal", () => {
    const n = render(payload("IntegrationRefused", { reason: "conflict", detail: "does not merge" }));

    expect(n.title).toBe("#123 did not merge");
    expect(n.body).toBe("conflict: does not merge");
  });
});

describe("which channel, and what it does with the link", () => {
  it("uses terminal-notifier when it is installed, and hands it the card to open", async () => {
    const { calls, exec } = recorder();
    const channel = await macNotifier(exec);
    await channel.send(render(payload("WorkItemBlocked", { question: "which base?" })));

    expect(channel.name).toBe("terminal-notifier");
    const sent = calls.find((c) => c.bin === "terminal-notifier");
    expect(sent?.args).toContain("-open");
    expect(sent?.args).toContain("http://localhost:3200/task/wi-lingtai-123");
  });

  /**
   * `osascript` cannot open a URL on click. The link goes into the message
   * instead of into a startup line nobody reads on the day it matters — which
   * is what the `clickable` flag it replaces was.
   */
  it("falls back to osascript and writes the link where it can be read", async () => {
    const { calls, exec } = recorder((bin) => (bin === "which" ? 1 : 0));
    const channel = await macNotifier(exec);
    await channel.send(render(payload("WorkItemBlocked", { question: "which base?" })));

    expect(channel.name).toBe("osascript");
    const script = calls.find((c) => c.bin === "osascript")?.args[1] ?? "";
    expect(script).toContain("http://localhost:3200/task/wi-lingtai-123");
  });

  /** The body is a question written by an agent, and it goes into an AppleScript string. */
  it("escapes a body that would otherwise close the AppleScript string", async () => {
    const { calls, exec } = recorder((bin) => (bin === "which" ? 1 : 0));
    const channel = await macNotifier(exec);
    await channel.send(
      render(payload("WorkItemBlocked", { question: 'ok" & (do shell script "id") & "' })),
    );

    const script = calls.find((c) => c.bin === "osascript")?.args[1] ?? "";
    expect(script).not.toMatch(/[^\\]"\s*&/);
  });
});

describe("what the exit code says", () => {
  const stdin = (value: unknown) => async () => JSON.stringify(value);

  it("is 0 when the notification went out", async () => {
    const { exec } = recorder();
    const code = await notifyCommand({
      read: stdin(payload("WorkItemBlocked", { question: "which base?" })),
      channelFor: () => macNotifier(exec),
      log: () => {},
    });

    expect(code).toBe(0);
  });

  /**
   * The one that was silently impossible before: `osascript` refusing used to
   * be discarded inside `send`, so a notifier that had stopped notifying looked
   * exactly like a quiet week.
   */
  it("is 1 when the notifier itself refused", async () => {
    const said: string[] = [];
    const { exec } = recorder((bin) => (bin === "which" ? 1 : 5));
    const code = await notifyCommand({
      read: stdin(payload("WorkItemBlocked", { question: "which base?" })),
      channelFor: () => macNotifier(exec),
      log: (line) => said.push(line),
    });

    expect(code).toBe(1);
    expect(said.join("\n")).toContain("osascript exited 5");
  });

  it("is 1 when stdin was not the payload, rather than notifying about nothing", async () => {
    const said: string[] = [];
    const code = await notifyCommand({
      read: async () => '{"event":{"type":"WorkItemBlocked"}}',
      channelFor: () => macNotifier(recorder().exec),
      log: (line) => said.push(line),
    });

    expect(code).toBe(1);
    expect(said.join("\n")).toContain("workItem");
  });
});

describe("parsePayload", () => {
  it("refuses input that is not JSON, naming what was wrong", () => {
    expect(() => parsePayload("not json")).toThrow(/stdin was not JSON/);
  });

  it("defaults the board rather than refusing over it", () => {
    const parsed = parsePayload(
      JSON.stringify({ event: { type: "WorkItemBlocked", data: {} }, workItem: { id: "wi-a-1", project: "a", issue: "1" } }),
    );

    expect(parsed.board).toBe("http://localhost:3200");
  });
});
