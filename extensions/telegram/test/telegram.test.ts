/**
 * Telegram, proved as far as this machine can prove it.
 *
 * The last hop — Telegram's own servers — is not something a test may depend
 * on, so the extension is pointed at a server of this test's own through
 * `TELEGRAM_API_BASE` and the *request* is what is asserted: the right path,
 * the right chat, the message, and the board link in it. Everything on this
 * side of `api.telegram.org` is real, including the process.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { message } from "../src/message.ts";
import { parsePayload } from "../src/payload.ts";
import { send } from "../src/send.ts";

const BIN = fileURLToPath(new URL("../src/telegram.ts", import.meta.url));

const landed = {
  schema: 1,
  event: {
    seq: "4231",
    streamId: "wi-lingtai-126",
    version: 7,
    type: "WorkItemLanded",
    schemaVer: 1,
    actor: "conductor",
    causation: null,
    at: "2026-09-10T09:12:44.000Z",
    data: { mergeCommit: "abc1234def", base: "main" },
  },
  project: "lingtai",
  ticket: { project: "lingtai", issue: "126", stream: "wi-lingtai-126" },
  board: {
    url: "http://localhost:3200",
    task: "http://localhost:3200/task/wi-lingtai-126",
  },
};

describe("the message", () => {
  it("says what landed, and ends with where to go about it", () => {
    const text = message(parsePayload(JSON.stringify(landed)));
    expect(text).toBe("lingtai #126 landed — abc1234 on main\nhttp://localhost:3200/task/wi-lingtai-126");
  });

  /**
   * Plain text, never Markdown. A branch called `fix_the_thing` or a question
   * containing `*` is ordinary here, and a message that failed to send because
   * of an unbalanced underscore would be the notifier failing at the one thing
   * it is for.
   */
  it("carries an agent's question through unescaped", () => {
    const blocked = structuredClone(landed);
    blocked.event.type = "WorkItemBlocked";
    blocked.event.data = { question: "merge *now* or wait for _the_ review?" } as never;
    expect(message(parsePayload(JSON.stringify(blocked)))).toContain("*now* or wait for _the_ review?");
  });

  it("clips a question long enough to be refused by Telegram", () => {
    const asking = structuredClone(landed);
    asking.event.type = "RunAwaitingInput";
    asking.event.data = { prompt: "x".repeat(9_000) } as never;
    expect(message(parsePayload(JSON.stringify(asking))).length).toBeLessThan(4_096);
  });
});

describe("the call", () => {
  it("says what Telegram said when Telegram refuses", async () => {
    const stub: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });

    await expect(
      send({ token: "t0ken", chatId: "-1", text: "hello", fetch: stub }),
    ).rejects.toThrow(/chat not found/);
  });

  /** `ok: false` with a 200 is Telegram's own habit, and it is still a refusal. */
  it("does not take a 200 for a delivery", async () => {
    const stub: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ ok: false, description: "bot was blocked by the user" }), {
        status: 200,
      });

    await expect(
      send({ token: "t0ken", chatId: "-1", text: "hello", fetch: stub }),
    ).rejects.toThrow(/bot was blocked/);
  });

  it("never puts the token in the message", async () => {
    const stub: typeof globalThis.fetch = async () => new Response("nope", { status: 500 });
    const failed = await send({ token: "s3cret", chatId: "-1", text: "hello", fetch: stub }).catch(
      (err: Error) => err.message,
    );
    expect(failed).not.toContain("s3cret");
  });
});

describe("as a command", () => {
  let server: Server;
  let base: string;
  const seen: { url: string; body: unknown }[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", body: JSON.parse(body) as unknown });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  function run(
    stdin: string,
    env: Record<string, string>,
  ): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [BIN], {
        stdio: ["pipe", "pipe", "pipe"],
        // Built, not inherited — exactly as the daemon starts it.
        env: { PATH: process.env["PATH"] ?? "", ...env },
      });
      let output = "";
      child.stdout.on("data", (c: Buffer) => (output += c.toString()));
      child.stderr.on("data", (c: Buffer) => (output += c.toString()));
      child.on("close", (code) => resolve({ code, output }));
      child.stdin.end(stdin);
    });
  }

  /**
   * `#126`'s *a Telegram message arrives for a landed ticket, with a board
   * link* — as far as it can be asserted without a bot token. Everything the
   * extension does is real; only the far end is this test's.
   */
  it("sends a landed ticket to the chat, with the board link on it", async () => {
    const { code, output } = await run(JSON.stringify(landed), {
      TELEGRAM_BOT_TOKEN: "t0ken",
      TELEGRAM_CHAT_ID: "-100123",
      TELEGRAM_API_BASE: base,
    });

    expect(output).toBe("");
    expect(code).toBe(0);
    const call = seen.at(-1);
    expect(call?.url).toBe("/bott0ken/sendMessage");
    const body = call?.body as { chat_id: string; text: string };
    expect(body.chat_id).toBe("-100123");
    expect(body.text).toContain("#126 landed");
    expect(body.text).toContain("http://localhost:3200/task/wi-lingtai-126");
  });

  /**
   * The core refuses to start a subscriber whose declared names are unset, so
   * this is the same mistake said from the other side — the recipe declared no
   * `env:` at all. It exits non-zero and names the variable, which is what
   * `PluginFailed` will carry.
   */
  it("refuses, naming the variable, when it has no credentials", async () => {
    const { code, output } = await run(JSON.stringify(landed), { TELEGRAM_CHAT_ID: "-1" });
    expect(code).toBe(1);
    expect(output).toContain("TELEGRAM_BOT_TOKEN");
  });
});
