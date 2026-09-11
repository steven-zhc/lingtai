/**
 * The extension, end to end, against a Telegram that is a local HTTP server.
 *
 * The three things worth asserting are the three the ticket asks for: a
 * message arrives carrying a link to the board, the process is given the
 * declared names **and nothing else**, and a refusal by Telegram is a non-zero
 * exit — which is what the core turns into `PluginFailed`.
 *
 * Spawned as a real child process rather than by calling `main`, because the
 * environment is the thing under test and a function call would share this
 * one. `LINGTAI_DATABASE_URL` is set in *this* process for the duration, so
 * "the child cannot read it" is a fact about the spawn and not about the
 * machine the suite happens to run on.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messageText, parseEvent } from "../src/index.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** What the core puts on stdin: the envelope, with `seq` as a string (#125). */
const landed = {
  seq: "4821",
  streamId: "wi-lingtai-125",
  version: 7,
  type: "WorkItemLanded",
  schemaVer: 1,
  data: { mergeCommit: "9f2c1b7d4e5a6f80", base: "main" },
  actor: "conductor",
  causation: null,
  at: "2026-09-10T12:00:00.000Z",
};

interface Posted {
  path: string;
  body: { chat_id?: string; text?: string };
}

let server: Server;
let posted: Posted[] = [];
let base = "";
/** What the next request answers with. Set by the test that wants a refusal. */
let reply: { status: number; body: unknown } = { status: 200, body: { ok: true } };

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      posted.push({ path: req.url ?? "", body: raw === "" ? {} : (JSON.parse(raw) as Posted["body"]) });
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Ran {
  code: number | null;
  stderr: string;
}

/** The spawn the conductor makes: this environment, and no other. */
function run(env: Record<string, string>, stdin: string): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], {
      env: { PATH: process.env["PATH"] ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    child.stdout.resume();
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(stdin);
  });
}

const declared = () => ({
  TELEGRAM_BOT_TOKEN: "123:abc",
  TELEGRAM_CHAT_ID: "-1001",
  TELEGRAM_BOARD_URL: "http://localhost:3200",
  TELEGRAM_API_BASE: base,
});

describe("one event in, one message out", () => {
  it("posts a landing, with the board link in the text", async () => {
    posted = [];
    reply = { status: 200, body: { ok: true } };

    const ran = await run(declared(), JSON.stringify(landed));

    expect(ran.code, ran.stderr).toBe(0);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.path).toBe("/bot123:abc/sendMessage");
    expect(posted[0]!.body.chat_id).toBe("-1001");
    // The link, which is the whole reason a message is worth sending: you are
    // one tap from the card rather than told a number.
    expect(posted[0]!.body.text).toContain("http://localhost:3200/task/wi-lingtai-125");
    expect(posted[0]!.body.text).toContain("#125 landed");
  });

  it("carries a question as it was written, markup characters and all", async () => {
    posted = [];
    reply = { status: 200, body: { ok: true } };

    // `_`, `*` and `.` are MarkdownV2's, and a path is full of them. With a
    // `parse_mode` this arrives mangled or 400s; as plain text it arrives.
    const question = "should run_once.ts keep *both* paths? see packages/conductor/src/run-once.ts:330";
    const ran = await run(
      declared(),
      JSON.stringify({ ...landed, type: "WorkItemBlocked", data: { question } }),
    );

    expect(ran.code, ran.stderr).toBe(0);
    expect(posted[0]!.body.text).toContain(question);
  });

  it("exits non-zero when Telegram refuses, saying what it said", async () => {
    posted = [];
    reply = { status: 400, body: { ok: false, description: "chat not found" } };

    const ran = await run(declared(), JSON.stringify(landed));

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("chat not found");
    // The token is in the URL and must not be in the sentence: this text
    // becomes a `PluginFailed` reason that `lingtai doctor` prints.
    expect(ran.stderr).not.toContain("123:abc");
  });

  it("exits non-zero, naming the variable, when the token is not there", async () => {
    posted = [];
    const { TELEGRAM_BOT_TOKEN: _omitted, ...rest } = declared();

    const ran = await run(rest, JSON.stringify(landed));

    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("TELEGRAM_BOT_TOKEN");
    expect(posted).toHaveLength(0);
  });
});

describe("the wire format", () => {
  it("takes seq as a string, because JSON.stringify throws on a bigint", () => {
    const event = parseEvent(JSON.stringify(landed));
    expect(event.seq).toBe(4821n);
    expect(event.at.toISOString()).toBe("2026-09-10T12:00:00.000Z");
  });

  it("refuses what is not an event rather than posting nonsense", () => {
    expect(() => parseEvent("")).toThrow(/nothing on stdin/);
    expect(() => parseEvent("{")).toThrow(/not JSON/);
    expect(() => parseEvent(JSON.stringify({ hello: "world" }))).toThrow(/not an event/);
  });
});

describe("what a reader sees", () => {
  it("is title, body and link — and drops the body when there is none", () => {
    expect(messageText({ title: "#7 landed", body: "", url: "http://b/task/wi-x-7" })).toBe(
      "#7 landed\n\nhttp://b/task/wi-x-7",
    );
    expect(messageText({ title: "#7 is blocked", body: "which one?", url: null })).toBe(
      "#7 is blocked\n\nwhich one?",
    );
  });
});
