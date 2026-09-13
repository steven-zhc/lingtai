/**
 * `#125`, end to end: the `telegram` line this repository's recipe declares,
 * built the way the daemon builds it, started from the checkout the daemon
 * starts in, following the real log.
 *
 * Every Done-when that is about the *boundary* rather than the message is here,
 * because none of them can be seen from inside `packages/telegram`:
 *
 * - the `run:` line resolves from the directory `lingtai.ts` hands over
 *   (`cwd: process.cwd()`, the checkout) — attempt 4 declared a path that could
 *   never resolve from the directory its subscribers were spawned in;
 * - a `RunFailed` on a `run-<uuid>` stream reaches Telegram carrying its card,
 *   which only `createSubjectResolver` reading the run's `RunStarted` can name;
 * - the process gets the token from the project's env file and not from this
 *   process, and cannot see `LINGTAI_DATABASE_URL` even when the file holds it;
 * - an unreachable Telegram, and an extension killed mid-event, each append
 *   `PluginFailed` and the log goes on being followed.
 *
 * Telegram itself is a local HTTP server. The one liberty taken with the
 * shipped declaration is adding `TELEGRAM_API_ROOT` to its `env:`, which is the
 * only way to point a real process at that server through the same filter.
 */
import { readFile, mkdtemp } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectFilter } from "@lingtai/conductor";
import { createWorkLoop, type WorkLoop } from "@lingtai/daemon";
import { SUBSCRIBER_STREAM, workItemStream } from "@lingtai/domain";
import { directDatabaseUrl } from "@lingtai/env";
import { createDb, createEventStore, type Db, type EventStore } from "@lingtai/event-store";
import { resolveRecipe, type Subscriber as SubscriberSpec } from "@lingtai/recipe";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildSubscribers, createSubjectResolver } from "../src/subscribers.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PROJECT = `esctesttg${crypto.randomUUID().slice(0, 6)}`;
const TOKEN = "123456:not-a-real-token";
const created = new Set<string>();

let client: Db;
let store: EventStore;
let shipped: SubscriberSpec;

beforeAll(async () => {
  client = createDb();
  store = createEventStore(client);
  const resolved = await resolveRecipe(async (path) => readFile(join(ROOT, path), "utf8"), "HEAD");
  const found = resolved.recipe.subscribers.find((s) => s.name === "telegram");
  if (!found) throw new Error(".lingtai/config.yaml declares no telegram subscriber");
  shipped = found;
});

afterAll(async () => {
  await client.close();
  const c = new pg.Client({ connectionString: directDatabaseUrl() });
  await c.connect();
  try {
    await c.query("alter table events disable rule lingtai_events_no_delete");
    await c.query("delete from events where stream_id = any($1)", [[...created]]);
    await c.query("delete from events where stream_id = $1 and data->>'project' = $2", [SUBSCRIBER_STREAM, PROJECT]);
    await c.query("delete from task_view where project = $1", [PROJECT]);
  } finally {
    await c.query("alter table events enable rule lingtai_events_no_delete");
    await c.end();
  }
});

let server: Server | undefined;
let loop: WorkLoop | undefined;
afterEach(async () => {
  await loop?.stop();
  loop = undefined;
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

async function until<T>(what: () => Promise<T | undefined> | T | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await what();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Received {
  text: string;
  res: ServerResponse;
}

/** A Bot API on `port` (any, if 0). `hold` keeps a request open instead of answering it. */
async function botApi(port = 0, hold: (text: string) => boolean = () => false) {
  const received: Received[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const text = (JSON.parse(raw) as { text: string }).text;
      received.push({ text, res });
      if (!hold(text)) res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true,"result":{}}');
    });
  });
  await new Promise<void>((r) => server!.listen(port, "127.0.0.1", () => r()));
  return { received, port: (server.address() as AddressInfo).port };
}

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/**
 * The daemon's construction, with the recipe read and the env file stood in
 * for. The file holds `LINGTAI_DATABASE_URL` on purpose: the claim is that the
 * process cannot read it even when it is sitting right beside the token.
 */
async function started(port: number, spec: Partial<SubscriberSpec> = {}) {
  const merged = {
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_CHAT_ID: "42",
    TELEGRAM_API_ROOT: `http://127.0.0.1:${port}`,
    LINGTAI_DATABASE_URL: "postgres://the-log",
  };
  const declared = { ...shipped, env: [...shipped.env, "TELEGRAM_API_ROOT"], ...spec };
  const { built, unread } = await buildSubscribers({
    filters: [{ project: PROJECT, ok: true, recipe: { subscribers: [declared] } } as unknown as ProjectFilter],
    cwd: ROOT,
    subject: createSubjectResolver(store),
    resolveEnv: (async () => ({ merged })) as never,
  });
  expect(unread).toEqual([]);
  loop = createWorkLoop({ sweepMs: 0, store, subscribers: built.map((b) => b.subscriber), pass: async () => {} });
  await loop.start();
}

let issue = 0;
/** A work item and a run for it, opened the way `run-once.ts` opens one. */
async function aRun() {
  issue += 1;
  const wi = workItemStream(PROJECT, issue);
  const runId = `run-${crypto.randomUUID()}`;
  created.add(wi);
  created.add(runId);
  await store.append(runId, 0, [
    {
      type: "RunStarted",
      actor: "conductor",
      data: {
        workItemId: wi,
        runtime: "claude-code",
        model: "claude-opus-5",
        promptVersion: "v1",
        baseSha: "a".repeat(40),
        configHash: "b".repeat(12),
        worktree: "/tmp/wt",
        invocation: null,
      },
    },
  ]);
  return { wi, runId, issue };
}

const failed = (runId: string, detail: string) =>
  store.append(runId, 1, [{ type: "RunFailed", actor: "conductor", data: { kind: "crash", detail } }]);

async function failures(): Promise<{ name: string; eventType: string; reason: string }[]> {
  return (await store.read(SUBSCRIBER_STREAM))
    .filter((e) => e.type === "PluginFailed" && (e.data as { project: string | null }).project === PROJECT)
    .map((e) => e.data as { name: string; eventType: string; reason: string });
}

describe("the telegram subscriber this repository declares", () => {
  it("names the five events the ticket lists, and no LINGTAI_ variable", () => {
    expect(new Set(shipped.on)).toEqual(
      new Set(["WorkItemLanded", "WorkItemBlocked", "RunFailed", "ApprovalRequested", "RunAwaitingInput"]),
    );
    expect(shipped.env.filter((n) => n.startsWith("LINGTAI_"))).toEqual([]);
  });

  it("delivers a run-stream event and a work-item event, each with a link to its card", async () => {
    const api = await botApi();
    await started(api.port);
    const run = await aRun();

    await failed(run.runId, "session limit");
    await until(() => api.received.find((r) => r.text.includes("run failed")));
    await store.append(run.wi, 0, [
      { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "5ace763aa0", base: "main" } },
    ]);
    await until(() => api.received.find((r) => r.text.includes("landed")));

    const card = `http://localhost:3200/task/${encodeURIComponent(run.wi)}`;
    expect(api.received.map((r) => r.text)).toEqual([
      `#${run.issue} run failed\ncrash: session limit\n${card}`,
      `#${run.issue} landed\nmerged into main at 5ace763\n${card}`,
    ]);
  });

  it("gets the token from the project's file, and never LINGTAI_DATABASE_URL", async () => {
    expect(process.env["TELEGRAM_BOT_TOKEN"]).toBeUndefined();
    const dir = await mkdtemp(join(tmpdir(), "lingtai-telegram-env-"));
    await started(await freePort(), { run: `env > ${join(dir, "env.txt")}` });
    const run = await aRun();

    await failed(run.runId, "x");
    const seen = await until(() => readFile(join(dir, "env.txt"), "utf8").catch(() => undefined));

    expect(seen).toContain(`TELEGRAM_BOT_TOKEN=${TOKEN}`);
    expect(seen).not.toMatch(/^LINGTAI_/m);
  });

  it("records an unreachable Telegram as PluginFailed, and delivers the next event once it is back", async () => {
    const port = await freePort();
    await started(port);
    const first = await aRun();

    await failed(first.runId, "while unreachable");
    const [failure] = await until(async () => {
      const f = await failures();
      return f.some((x) => x.reason.includes("could not reach Telegram")) ? f : undefined;
    });
    expect(failure?.name).toBe("telegram");
    expect(failure?.eventType).toBe("RunFailed");
    expect(failure?.reason).not.toContain(TOKEN);

    const api = await botApi(port);
    const second = await aRun();
    await failed(second.runId, "after it came back");
    await until(() => api.received.find((r) => r.text.includes("after it came back")));
  });

  /**
   * Killed while its request is open: the `run:` line is the shipped one behind
   * a shell that says its pid — `<&0` because `sh` gives a background job
   * `/dev/null` for stdin, and the payload has to reach it — and the Bot API holds the first message until
   * the test has killed the process sending it.
   */
  it("records an extension killed mid-event, and goes on following the log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lingtai-telegram-kill-"));
    const pidFile = join(dir, "pid");
    const api = await botApi(0, (text) => text.includes("kill me"));
    const before = (await failures()).length;
    await started(api.port, { run: `${shipped.run} <&0 & echo $! > ${pidFile}; wait $!` });

    const first = await aRun();
    await failed(first.runId, "kill me");
    await until(() => api.received.find((r) => r.text.includes("kill me")));
    process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");

    await until(async () => ((await failures()).length > before ? true : undefined));
    const second = await aRun();
    await failed(second.runId, "still followed");
    await until(() => api.received.find((r) => r.text.includes("still followed")));
  });
});
