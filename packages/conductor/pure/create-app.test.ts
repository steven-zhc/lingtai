/**
 * Creating the App from the board (#169): what is written, and what never is.
 *
 * No database and no network — the store is `createMemoryEventStore` and the
 * conversion's `fetch` is a function — because everything worth asserting here
 * is on this side of both: which codes are accepted, where the key lands, and
 * the three places a private key must never reach.
 *
 * **The secret assertions are the point of the file.** The log is append-only
 * and permanent and `lingtai projection rebuild` replays it, so a PEM written
 * into an event would be read aloud by every rebuild for ever. So the captured
 * output *and* the appended events are searched for `BEGIN` and for the key's
 * own bytes, rather than the schema being read and trusted.
 */
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventStore } from "@lingtai/event-store";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  APP_ID_VAR,
  ATTEMPT_WINDOW_MS,
  KEY_PATH_VAR,
  WEBHOOK_SECRET_VAR,
  createCreationSession,
  offerCreation,
} from "../src/create-app.ts";

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAz9\n-----END RSA PRIVATE KEY-----\n";

const CONVERSION = {
  id: 1234567,
  slug: "lingtai-steven",
  name: "lingtai-steven",
  client_id: "Iv1.0123456789abcdef",
  client_secret: "oauth-secret-never-written",
  webhook_secret: "webhook-secret-abcdef",
  pem: PEM,
  owner: { login: "steven-zhc" },
};

/** The whole log as text — `seq` is a bigint, which `JSON.stringify` refuses. */
const asText = (events: readonly unknown[]): string =>
  JSON.stringify(events, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

const conversion = (body: unknown = CONVERSION, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;

/** A temporary home for the two files this writes, never the real ones. */
async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "lingtai-app-"));
  return { dir, keyPath: join(dir, "agent.private-key.pem"), envFile: join(dir, ".env.local") };
}

/** Everything the process said, so a test can grep it for a secret. */
function captureOutput(): { said: () => string; stop: () => void } {
  const said: string[] = [];
  const record = (...args: unknown[]) => void said.push(args.map(String).join(" "));
  const spies = [
    vi.spyOn(console, "log").mockImplementation(record),
    vi.spyOn(console, "warn").mockImplementation(record),
    vi.spyOn(console, "error").mockImplementation(record),
    vi.spyOn(console, "info").mockImplementation(record),
    vi.spyOn(console, "debug").mockImplementation(record),
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stdout.write),
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      said.push(String(chunk));
      return true;
    }) as typeof process.stderr.write),
  ];
  return { said: () => said.join("\n"), stop: () => spies.forEach((s) => s.mockRestore()) };
}

afterEach(() => vi.restoreAllMocks());

describe("only a code this process asked for", () => {
  it("refuses a state it never issued, and says nothing was written", async () => {
    const session = createCreationSession();
    session.begin({ name: "lingtai-x", redirectUrl: "http://127.0.0.1:3200/setup/github-app/created" });

    const outcome = await session.finish({ code: "c", state: "not-ours", by: "human:s" });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refusal).toContain("not one this page issued");
    expect(outcome.ok === false && outcome.refusal).toContain("Nothing was written");
  });

  it("refuses a return with no code at all — the tab was closed, or GitHub refused", async () => {
    const session = createCreationSession();
    const { state } = session.begin({ name: "x", redirectUrl: "http://127.0.0.1:3200/created" });

    const outcome = await session.finish({ code: null, state, by: "human:s" });

    expect(outcome.ok === false && outcome.refusal).toContain("no code");
  });

  /** GitHub's hour, and ours, deliberately the same one. */
  it("refuses a state past the hour rather than spending a code GitHub will not take", async () => {
    const session = createCreationSession();
    const begun = session.begin({
      name: "x",
      redirectUrl: "http://127.0.0.1:3200/created",
      now: new Date("2026-09-15T10:00:00Z"),
    });

    const outcome = await session.finish({
      code: "c",
      state: begun.state,
      by: "human:s",
      now: new Date(new Date("2026-09-15T10:00:00Z").getTime() + ATTEMPT_WINDOW_MS + 1000),
    });

    expect(outcome.ok === false && outcome.refusal).toContain("hour lapsed");
  });

  /** The code expires: `422` from the conversion, and one sentence about it. */
  it("says the hour lapsed when GitHub will not exchange the code", async () => {
    const session = createCreationSession();
    const begun = session.begin({ name: "x", redirectUrl: "http://127.0.0.1:3200/created" });

    const outcome = await session.finish({
      code: "spent",
      state: begun.state,
      by: "human:s",
      fetch: conversion({ message: "Not Found" }, 422),
      store: createMemoryEventStore(),
    });

    expect(outcome.ok === false && outcome.refusal).toContain("one exchange");
    expect(outcome.ok === false && outcome.refusal).toContain("Nothing was written");
  });
});

describe("what the six returned values become", () => {
  const finish = async () => {
    const { keyPath, envFile } = await workspace();
    const store = createMemoryEventStore();
    const session = createCreationSession();
    const begun = session.begin({ name: "lingtai-steven", redirectUrl: "http://127.0.0.1:3200/created" });
    const capture = captureOutput();
    const outcome = await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store,
      env: {},
      keyPath,
      envFile,
    });
    capture.stop();
    return { outcome, store, keyPath, envFile, said: capture.said() };
  };

  it("writes the id, the key path and the webhook secret, and the key at 0600", async () => {
    const { outcome, keyPath, envFile } = await finish();

    expect(outcome.ok).toBe(true);
    expect(await readFile(keyPath, "utf8")).toBe(PEM);
    // `writeFile`'s mode is narrowed by a umask, so the mode is asked for
    // outright. This is the assertion that says it was.
    expect((await stat(keyPath)).mode & 0o777).toBe(0o600);

    const env = await readFile(envFile, "utf8");
    expect(env).toContain(`${APP_ID_VAR}="1234567"`);
    expect(env).toContain(`${KEY_PATH_VAR}=${JSON.stringify(keyPath)}`);
    expect(env).toContain(`${WEBHOOK_SECRET_VAR}="webhook-secret-abcdef"`);
  });

  /** A secret kept for a use that does not exist is a secret with no owner. */
  it("writes neither client_id nor client_secret anywhere", async () => {
    const { envFile, store, said } = await finish();
    const env = await readFile(envFile, "utf8");
    const log = asText(await store.readAll(0n, 100));

    for (const written of [env, log, said]) {
      expect(written).not.toContain("oauth-secret-never-written");
      expect(written).not.toContain("Iv1.0123456789abcdef");
      expect(written).not.toContain("client_secret");
    }
  });

  /**
   * The one that matters most. A rebuild replays the log faithfully, so a key in
   * it is a key in every future rebuild.
   */
  it("never prints the key, never logs it, and never appends it", async () => {
    const { store, said, outcome } = await finish();
    const log = asText(await store.readAll(0n, 100));

    for (const place of [log, said, JSON.stringify(outcome)]) {
      expect(place).not.toContain("BEGIN");
      expect(place).not.toContain("MIIEowIBAAKCAQEAz9");
    }
  });

  it("records the id and the slug and nothing else", async () => {
    const { store } = await finish();
    const events = await store.readAll(0n, 100);

    expect(events.map((e) => e.type)).toEqual(["GitHubAppCreated"]);
    expect(events[0]!.data).toEqual({ appId: "1234567", slug: "lingtai-steven" });
    expect(events[0]!.streamId).toBe("ctl-github-app");
  });

  /**
   * The webhook secret is generated by GitHub during the conversion and handed
   * back once. If the env file will not take it, it is gone — so the refusal
   * has to name it, or the operator writes the two lines it *does* name and is
   * left with an active hook signed by a secret that exists nowhere.
   */
  it("names the webhook secret, and its remedy, when the env file cannot be written", async () => {
    const { dir, keyPath } = await workspace();
    // A regular file where a directory would have to be: `mkdir` refuses.
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory\n");
    const session = createCreationSession();
    const begun = session.begin({
      name: "x",
      redirectUrl: "http://127.0.0.1:3200/created",
      webhookUrl: "https://lingtai.example.com/api/webhook",
    });

    const outcome = await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store: createMemoryEventStore(),
      env: {},
      keyPath,
      envFile: join(blocker, ".env.local"),
    });

    expect(outcome.ok).toBe(false);
    const refusal = outcome.ok === false ? outcome.refusal : "";
    expect(refusal).toContain(WEBHOOK_SECRET_VAR);
    expect(refusal).toContain("Set a new webhook secret on the App's own page");
    // Named, and never quoted: a refusal is rendered on a page and kept in the
    // session, which is not where a live secret belongs.
    expect(refusal).not.toContain("webhook-secret-abcdef");
  });

  /** The path, and never the key — what the screen is handed cannot leak one. */
  it("hands back the path of the key and not its bytes", async () => {
    const { outcome, keyPath } = await finish();

    expect(outcome.ok === true && outcome.keyPath).toBe(keyPath);
    expect(outcome.ok === true && outcome.webhookActive).toBe(false);
  });

  /**
   * A key file at the path is an App somebody has; overwriting it would destroy
   * the only copy of one credential in order to store another.
   */
  it("never writes over a key that is already there", async () => {
    const { keyPath, envFile } = await workspace();
    await writeFile(keyPath, "-----BEGIN RSA PRIVATE KEY-----\nSOMEBODY ELSE\n", { mode: 0o600 });
    const session = createCreationSession();
    const begun = session.begin({ name: "x", redirectUrl: "http://127.0.0.1:3200/created" });

    const outcome = await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store: createMemoryEventStore(),
      env: {},
      keyPath,
      envFile,
    });

    expect(await readFile(keyPath, "utf8")).toContain("SOMEBODY ELSE");
    expect(outcome.ok === true && outcome.keyPath).toBe(keyPath.replace(/\.pem$/, ".1234567.pem"));
    expect(await readFile(outcome.ok === true ? outcome.keyPath : "", "utf8")).toBe(PEM);
  });
});

describe("what the screen offers", () => {
  const store = () => createMemoryEventStore();

  it("offers creation when nothing is configured and nothing is on the log", async () => {
    const offer = await offerCreation({ env: {}, store: store(), session: createCreationSession() });

    expect(offer.offered).toBe(true);
    expect(offer.configured).toBeNull();
    expect(offer.permissions.map((p) => p.name)).toContain("issues");
  });

  /** `hasGitHubApp()` is true → no second App is minted by accident. */
  it("does not offer creation when the environment already has an App", async () => {
    const offer = await offerCreation({
      env: { [APP_ID_VAR]: "42", [KEY_PATH_VAR]: "~/.ssh/k.pem" },
      store: store(),
      session: createCreationSession(),
    });

    expect(offer.offered).toBe(false);
    expect(offer.configured).toEqual({ appId: "42", slug: null, from: "environment" });
  });

  /**
   * 111 was minted here; 222 was then created by hand and `.env.local` points
   * at it. The id is the environment's and the slug is the log's, so fusing
   * them would offer 222's operator a link that installs 111 — and `lingtai
   * add` would answer *not installed* for 222 with nothing saying why.
   */
  it("does not put the log's slug beside an environment naming a different App", async () => {
    const log = store();
    const session = createCreationSession();
    const { keyPath, envFile } = await workspace();
    const begun = session.begin({ name: "lingtai-steven", redirectUrl: "http://127.0.0.1:3200/created" });
    await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store: log,
      env: {},
      keyPath,
      envFile,
    });

    const offer = await offerCreation({
      env: { [APP_ID_VAR]: "7654321", [KEY_PATH_VAR]: "~/.ssh/by-hand.pem" },
      store: log,
      session: createCreationSession(),
    });

    expect(offer.configured).toEqual({ appId: "7654321", slug: null, from: "environment" });
    expect(offer.installUrl).toBeNull();
  });

  /**
   * **A store that will not answer is not a store that said no.** The log is
   * the only durable guard, and the board that has one may have been started
   * before `.env.local` was written — so an unreachable Postgres read as
   * *nothing is configured* is the button being drawn over a working App.
   */
  it("offers nothing when the log could not be read, and says why", async () => {
    const unreachable = {
      read: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as EventStore;

    const offer = await offerCreation({ env: {}, store: unreachable, session: createCreationSession() });

    expect(offer.offered).toBe(false);
    expect(offer.unanswered).toBe("connection terminated unexpectedly");
    // Not `configured`: nothing is known to be configured. The two are
    // different answers and the page says different things about them.
    expect(offer.configured).toBeNull();
  });

  /**
   * The asymmetry, as the page meets it: the App ID is fixed at process start,
   * so the board that just wrote one still answers *not configured*. The log is
   * what stops it offering to mint a second.
   */
  it("does not offer creation when the log says one was created, though this process has no App", async () => {
    const log = store();
    const session = createCreationSession();
    const { keyPath, envFile } = await workspace();
    const begun = session.begin({ name: "lingtai-steven", redirectUrl: "http://127.0.0.1:3200/created" });
    await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store: log,
      env: {},
      keyPath,
      envFile,
    });

    // A fresh session, as a restarted board would have: the environment is
    // still empty and the offer is still refused.
    const offer = await offerCreation({ env: {}, store: log, session: createCreationSession() });

    expect(offer.offered).toBe(false);
    expect(offer.configured).toEqual({ appId: "1234567", slug: "lingtai-steven", from: "log" });
    expect(offer.installUrl).toBe("https://github.com/apps/lingtai-steven/installations/new");
  });

  /**
   * The person closed GitHub's tab, or GitHub refused the name on its own page:
   * either way this system sees nothing, ever. It times out and says so rather
   * than waiting.
   */
  it("calls a posted form that never came back lapsed, after the hour", async () => {
    const session = createCreationSession();
    const at = new Date("2026-09-15T10:00:00Z");
    session.begin({ name: "lingtai-taken", redirectUrl: "http://127.0.0.1:3200/created", now: at });

    const waiting = await offerCreation({
      env: {},
      store: store(),
      session,
      now: new Date(at.getTime() + 60_000),
    });
    const lapsed = await offerCreation({
      env: {},
      store: store(),
      session,
      now: new Date(at.getTime() + ATTEMPT_WINDOW_MS + 1000),
    });

    expect(waiting.outstanding?.state).toBe("waiting");
    expect(lapsed.outstanding).toEqual({ name: "lingtai-taken", org: null, startedAt: at, state: "lapsed" });
  });
});
