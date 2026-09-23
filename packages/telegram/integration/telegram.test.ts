/**
 * Telegram, against a Bot API that is a real HTTP server on this machine.
 *
 * Not a stubbed `fetch`, for `command.test.ts`'s reason: what `#125` asks is
 * that a message *arrives*, and that an unreachable Telegram is an exit code
 * the daemon can record. A stub that resolves is a description of a server;
 * this one is a socket that can refuse, hang or be absent.
 */
import { spawn } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, realpath } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import type { NotifyPayload } from "../../extension/src/index.ts";
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

  it("never cuts an emoji in half where it cuts the body", () => {
    const title = "#125 is asking";
    const url = "http://localhost:3200/task/wi-lingtai-125";
    const room = MAX_TEXT - title.length - url.length - 3;
    // The cut keeps `room - 1` code units, so an emoji starting one or two
    // before that leaves its high surrogate on the kept side for one of them.
    for (const at of [room - 4, room - 3, room - 2, room - 1]) {
      const text = messageText({ title, body: `${"x".repeat(at)}😀${"x".repeat(10_000)}`, url });
      // A surrogate with no partner — what `String.prototype.isWellFormed` asks, below ES2024's lib.
      expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT);
      expect(text.endsWith(url)).toBe(true);
    }
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

  /**
   * The daemon's checkout gets a merge and no `pnpm install`, so the same file
   * is run from a copy of the two packages with no `node_modules` above it. An
   * import that needs a workspace symlink is `ERR_MODULE_NOT_FOUND` here, and
   * would be a `PluginFailed` blaming nothing an operator could find there.
   */
  it("runs from a checkout nobody reinstalled, and says which name is missing", async () => {
    // Real path: macOS's tmpdir is a symlink, and `isMain` compares against the resolved URL.
    const copy = await realpath(await mkdtemp(join(tmpdir(), "lingtai-telegram-uninstalled-")));
    for (const pkg of ["extension", "telegram"]) {
      await cp(join(PKG, "..", pkg, "src"), join(copy, "packages", pkg, "src"), { recursive: true });
      await cp(join(PKG, "..", pkg, "package.json"), join(copy, "packages", pkg, "package.json"));
    }

    let stderr = "";
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [join(copy, "packages", "telegram", "src", "cli.ts")], {
        env: { PATH: process.env["PATH"] ?? "" },
        stdio: ["pipe", "ignore", "pipe"],
      });
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", resolve);
      child.stdin.end(JSON.stringify(payload("RunFailed", { kind: "crash", detail: "x" })));
    });

    expect(stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(stderr).toContain("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID not set");
    expect(code).toBe(1);
  });
});

/**
 * `#125`'s last Done-when, checked rather than promised: `node:`, its own
 * files, and `packages/extension` by path — which depends on nothing, and has
 * a test of its own that says so.
 *
 * Read by TypeScript's pre-processor, as there, so that `import "x"`,
 * `await import("x")` and `require("x")` are seen as well as `import … from`.
 */
describe("what Telegram imports", () => {
  const EXTENSION = "../../extension/src/index.ts";

  function specifiersIn(text: string): string[] {
    const found = ts.preProcessFile(text, true, true).importedFiles.map((f) => f.fileName);
    if (/\b(?:import|require)\s*\(\s*(?!["'])/.test(text)) found.push("<a computed import>");
    return found;
  }

  it("is nothing a third party's extension could not import", async () => {
    const specifiers: string[] = [];
    const src = join(PKG, "src");
    for (const file of await readdir(src, { recursive: true })) {
      if (!/\.[cm]?[jt]s$/.test(file)) continue;
      specifiers.push(...specifiersIn(await readFile(join(src, file), "utf8")));
    }

    expect(specifiers).toContain(EXTENSION);
    const foreign = specifiers.filter((s) => !s.startsWith("node:") && !s.startsWith("./") && s !== EXTENSION);
    expect(foreign).toEqual([]);

    const pkg = JSON.parse(await readFile(join(PKG, "package.json"), "utf8")) as { dependencies?: object };
    expect(pkg.dependencies).toBeUndefined();
  });

  it("sees a side-effect import, a dynamic one and a require, not only `import … from`", () => {
    const text = [
      'import "@lingtai/domain/register";',
      'const store = await import("@lingtai/event-store");',
      'const pg = require("pg");',
      "const late = await import(name);",
    ].join("\n");

    expect(specifiersIn(text)).toEqual(["@lingtai/domain/register", "@lingtai/event-store", "pg", "<a computed import>"]);
  });
});
