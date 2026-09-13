/**
 * Telegram, against a Bot API that is a real HTTP server on this machine.
 *
 * Not a stubbed `fetch`, for `command.test.ts`'s reason: what `#125` asks is
 * that a message *arrives*, and that an unreachable Telegram is an exit code
 * the daemon can record. A stub that resolves is a description of a server;
 * this one is a socket that can refuse, hang or be absent.
 */
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NotifyPayload } from "@lingtai/extension";
import { MAX_TEXT, messageText, sendMessage, telegramCommand } from "../src/index.ts";

const PKG = join(import.meta.dirname, "..");
const TOKEN = "123456:secret-bot-token";

const payload = (type: string, data: unknown): NotifyPayload => ({
  event: { type, data },
  workItem: { id: "wi-lingtai-125", project: "lingtai", issue: "125" },
  board: "http://localhost:3200",
});

interface Received {
  path: string;
  body: { chat_id: string; text: string };
}

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** A Bot API that answers every request with `status` and records what it got. */
async function botApi(status = 200, answer: unknown = { ok: true, result: {} }) {
  const received: Received[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body: JSON.parse(raw) });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { received, root: `http://127.0.0.1:${port}` };
}

/** A port nothing listens on: bound, read, and closed again. */
async function closedPort(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

describe("the message", () => {
  it("is the title, the body and the card, in plain text", () => {
    const text = messageText({ title: "#125 landed", body: "merged into main at 5ace763", url: "http://b/task/x" });
    expect(text).toBe("#125 landed\nmerged into main at 5ace763\nhttp://b/task/x");
  });

  it("cuts a body too long for Telegram, and never the link", () => {
    const url = "http://localhost:3200/task/wi-lingtai-125";
    const text = messageText({ title: "#125 is asking", body: "x".repeat(10_000), url });
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT);
    expect(text.endsWith(url)).toBe(true);
  });
});

describe("sending it", () => {
  it("posts to the chat, through the token's own path, with the board link in the text", async () => {
    const api = await botApi();
    await sendMessage(
      { token: TOKEN, chatId: "42", apiRoot: api.root },
      { title: "#125 is waiting on you", body: "Merge?", url: "http://localhost:3200/task/wi-lingtai-125" },
    );

    expect(api.received).toHaveLength(1);
    expect(api.received[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(api.received[0]!.body.chat_id).toBe("42");
    expect(api.received[0]!.body.text).toContain("http://localhost:3200/task/wi-lingtai-125");
  });

  it("rejects when Telegram is unreachable, saying so and not saying the token", async () => {
    const root = await closedPort();
    const sent = sendMessage({ token: TOKEN, chatId: "42", apiRoot: root }, { title: "t", body: "b", url: "u" });

    await expect(sent).rejects.toThrow(/could not reach Telegram/);
    await expect(sent).rejects.not.toThrow(TOKEN);
  });

  it("rejects when Telegram refuses, with its description and without the token", async () => {
    const api = await botApi(401, { ok: false, description: "Unauthorized" });
    const sent = sendMessage({ token: TOKEN, chatId: "42", apiRoot: api.root }, { title: "t", body: "b", url: "u" });

    await expect(sent).rejects.toThrow("Telegram refused the message: 401 Unauthorized");
  });

  it("gives up on a Telegram that accepts the connection and never answers", async () => {
    server = createServer(() => {});
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const sent = sendMessage({ token: TOKEN, chatId: "42", apiRoot: root }, { title: "t", body: "b", url: "u" }, fetch, 200);
    await expect(sent).rejects.toThrow(/could not reach Telegram/);
    server.closeAllConnections();
  });
});

describe("the command's exit code", () => {
  const read = (p: unknown) => async () => JSON.stringify(p);

  it("is 0 when the message arrived", async () => {
    const api = await botApi();
    const code = await telegramCommand({
      read: read(payload("WorkItemLanded", { mergeCommit: "abc1234def", base: "main" })),
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_ROOT: api.root },
      log: () => {},
    });

    expect(code).toBe(0);
    expect(api.received[0]!.body.text).toBe(
      "#125 landed\nmerged into main at abc1234\nhttp://localhost:3200/task/wi-lingtai-125",
    );
  });

  it("is 1 when a name is missing, naming the command lingtai env actually takes", async () => {
    const said: string[] = [];
    const code = await telegramCommand({
      read: read(payload("WorkItemBlocked", {})),
      env: { TELEGRAM_CHAT_ID: "42" },
      log: (line) => said.push(line),
    });

    expect(code).toBe(1);
    expect(said.join("\n")).toContain("TELEGRAM_BOT_TOKEN not set");
    expect(said.join("\n")).toContain("lingtai env set <project> TELEGRAM_BOT_TOKEN");
  });

  it("is 1 when Telegram is unreachable", async () => {
    const said: string[] = [];
    const code = await telegramCommand({
      read: read(payload("RunFailed", { kind: "crash", detail: "x" })),
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_ROOT: await closedPort() },
      log: (line) => said.push(line),
    });

    expect(code).toBe(1);
    expect(said.join("\n")).toContain("could not reach Telegram");
    expect(said.join("\n")).not.toContain(TOKEN);
  });

  /**
   * The file itself, as `node packages/telegram/src/cli.ts` — the `run:` line
   * the recipe declares — with the payload on stdin. This is what proves the
   * workspace import resolves from a bare `node`, which no in-process test can.
   */
  it("runs as a process, reading stdin and exiting with what happened", async () => {
    const api = await botApi();
    const run = (env: Record<string, string>) =>
      new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [join(PKG, "src", "cli.ts")], {
          env: { PATH: process.env["PATH"] ?? "", ...env },
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("close", resolve);
        child.stdin.end(JSON.stringify(payload("ApprovalRequested", { question: "Merge agent/125?" })));
      });

    expect(await run({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_ROOT: api.root })).toBe(0);
    expect(api.received[0]!.body.text).toContain("Merge agent/125?");
    expect(await run({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: "42", TELEGRAM_API_ROOT: await closedPort() })).toBe(1);
  });
});

/**
 * `#125`'s last Done-when, checked rather than promised: `node:`, its own
 * files, and `@lingtai/extension` — which depends on nothing, and has a test
 * of its own that says so.
 */
describe("what Telegram imports", () => {
  it("is nothing a third party's extension could not import", async () => {
    const specifiers: string[] = [];
    for (const file of await readdir(join(PKG, "src"))) {
      const text = await readFile(join(PKG, "src", file), "utf8");
      for (const m of text.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/gm)) specifiers.push(m[1]!);
    }

    expect(specifiers.length).toBeGreaterThan(0);
    const foreign = specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && s !== "@lingtai/extension");
    expect(foreign).toEqual([]);

    const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8")) as { dependencies?: object };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["@lingtai/extension"]);
  });
});
