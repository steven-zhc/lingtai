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
import { GITHUB_APP_STREAM, parsePayload } from "@lingtai/domain";
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

/**
 * **A `state` GitHub is never given is a `state` GitHub cannot echo.**
 *
 * The manifest is the posted body; `state` is read from the query string of
 * `/settings/apps/new` and from nowhere else. Put it in a hidden input beside
 * the manifest and every step still works — the naming screen appears, the
 * person presses *Create GitHub App*, the App is created — and the redirect
 * comes back `?code=…` with no `state` at all, so `finish` refuses it, the
 * hour's code is never exchanged and the private key GitHub generated is
 * destroyed unrecoverably. There is no failure on that path to notice: every
 * attempt leaves an orphan App and the same refusal. So what is asserted is
 * the round trip GitHub performs — the value on the action URL is the value
 * `finish` accepts.
 */
describe("the form GitHub is sent", () => {
  it("carries the state on the action URL, which is the half GitHub echoes", () => {
    const session = createCreationSession();

    const mine = session.begin({ name: "lingtai-x", redirectUrl: "http://127.0.0.1:3200/created" });
    const theirs = session.begin({
      name: "lingtai-y",
      org: "acme",
      redirectUrl: "http://127.0.0.1:3200/created",
    });

    for (const begun of [mine, theirs]) {
      const action = new URL(begun.action);
      expect(action.searchParams.get("state")).toBe(begun.state);
      expect(`${action.origin}${action.pathname}`).toBe(
        begun === mine
          ? "https://github.com/settings/apps/new"
          : "https://github.com/organizations/acme/settings/apps/new",
      );
    }
  });

  it("is finished by the state GitHub reads off that URL", async () => {
    const { keyPath, envFile } = await workspace();
    const session = createCreationSession();
    const begun = session.begin({ name: "lingtai-steven", redirectUrl: "http://127.0.0.1:3200/created" });

    // GitHub returns the query string's `state` beside the code, and nothing
    // from the form body: this is the only value the return can carry.
    const echoed = new URL(begun.action).searchParams.get("state");
    const outcome = await session.finish({
      code: "fresh",
      state: echoed,
      by: "human:steven",
      fetch: conversion(),
      store: createMemoryEventStore(),
      env: {},
      keyPath,
      envFile,
    });

    expect(outcome.ok).toBe(true);
  });
});

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
      // Read an empty test target, never the operator's checkout .env.local.
      envFile: (await workspace()).envFile,
      store: createMemoryEventStore(),
      env: {},
    });

    expect(outcome.ok === false && outcome.refusal).toContain("one exchange");
    expect(outcome.ok === false && outcome.refusal).toContain("Nothing was written");
  });
});

/**
 * **A `state` is good for an hour, and `finish` is where that hour is spent.**
 * The page and `start/route.ts` both refuse to offer a second App, but a tab
 * already sitting on GitHub's naming screen was offered one before anything
 * existed — so the guard has to be re-asserted where the writing happens, or a
 * forgotten tab finished twenty minutes later replaces a working App's id, key
 * path and install link with an App no repository has installed.
 */
describe("a return from a tab the operator forgot", () => {
  const APP_111 = { ...CONVERSION, id: 111, slug: "lingtai-first", name: "lingtai-first" };
  const APP_222 = { ...CONVERSION, id: 222, slug: "lingtai-second", name: "lingtai-second" };

  const there = (path: string) =>
    readFile(path, "utf8").then(
      () => true,
      () => false,
    );

  it("leaves the App that was created second configured, and writes nothing for the first", async () => {
    const { keyPath, envFile } = await workspace();
    const store = createMemoryEventStore();
    const session = createCreationSession();
    const at = new Date("2026-09-15T10:00:00Z");
    // Nothing is configured, so both presses were offered — one per tab.
    const first = session.begin({ name: "lingtai-first", redirectUrl: "http://127.0.0.1:3200/created", now: at });
    const second = session.begin({ name: "lingtai-second", redirectUrl: "http://127.0.0.1:3200/created", now: at });

    const made = await session.finish({
      code: "b",
      state: second.state,
      by: "human:steven",
      fetch: conversion(APP_222),
      store,
      env: {},
      keyPath,
      envFile,
      now: new Date(at.getTime() + 60_000),
    });
    expect(made.ok).toBe(true);

    // Twenty minutes later, still inside GitHub's hour, the first tab returns.
    const late = await session.finish({
      code: "a",
      state: first.state,
      by: "human:steven",
      fetch: conversion(APP_111),
      store,
      env: {},
      keyPath,
      envFile,
      now: new Date(at.getTime() + 20 * 60_000),
    });

    expect(late.ok).toBe(false);
    expect(late.ok === false && late.refusal).toContain("222");
    expect(late.ok === false && late.refusal).toContain("nothing was written");
    // The three places the second App's configuration lives, all untouched.
    const env = await readFile(envFile, "utf8");
    expect(env).toContain(`${APP_ID_VAR}="222"`);
    expect(env).not.toContain(`${APP_ID_VAR}="111"`);
    expect(await there(keyPath.replace(/\.pem$/, ".111.pem"))).toBe(false);
    const events = await store.readAll(0n, 100);
    expect(events.map((e) => (e.data as { appId: string }).appId)).toEqual(["222"]);
    // And the screen says the refusal rather than "Created — app 111".
    expect(session.outcome()).toBe(late);
  });

  /**
   * **The first return minted an App and then failed every write, including the
   * append.** That is the one outcome with no durable trace of itself: no env
   * line, no key file the guard reads, and nothing on the log — so
   * `configuration()` answers *nothing is configured, nothing was minted,
   * nothing went wrong* and every check below this one passes honestly.
   *
   * The only thing that remembers is this session's last outcome, and it is a
   * refusal — `ok === false` with `minted` set. A guard that asked whether the
   * previous return *succeeded* therefore waved the second tab through: a
   * second App was minted twenty seconds later, the screen said *Created — app
   * 222*, and app 111 was left on GitHub with a private key GitHub will never
   * hand over again and nothing anywhere naming it. `offerCreation` folds the
   * same field into `mintedHere` to withhold the button; this is that fold
   * where the key would be fetched.
   */
  it("refuses the second tab when the first minted an App and every write failed", async () => {
    const { dir, keyPath } = await workspace();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory\n");
    const envFile = join(blocker, ".env.local");
    // The Postgres blip: readable, and it will not take an append.
    const half = {
      read: async () => [],
      readAll: async () => [],
      append: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as EventStore;
    const session = createCreationSession();
    const at = new Date("2026-09-15T10:00:00Z");
    // Two tabs, two live states, both inside GitHub's hour.
    const a = session.begin({ name: "lingtai-first", redirectUrl: "http://127.0.0.1:3200/created", now: at });
    const b = session.begin({ name: "lingtai-second", redirectUrl: "http://127.0.0.1:3200/created", now: at });

    const first = await session.finish({
      code: "a",
      state: a.state,
      by: "human:steven",
      fetch: conversion(APP_111),
      store: half,
      env: {},
      keyPath,
      envFile,
      now: new Date(at.getTime() + 10_000),
    });

    // Minted, and nothing landed: not the env file, not the log.
    expect(first.ok).toBe(false);
    expect(first.ok === false && first.minted).toEqual({ appId: "111", slug: "lingtai-first" });
    expect(await there(envFile)).toBe(false);

    // Postgres comes back, and twenty seconds later tab B returns.
    let exchanges = 0;
    const counted = (async () => {
      exchanges += 1;
      return new Response(JSON.stringify(APP_222), { status: 200 });
    }) as typeof fetch;
    const store = createMemoryEventStore();
    const late = await session.finish({
      code: "b",
      state: b.state,
      by: "human:steven",
      fetch: counted,
      store,
      env: {},
      keyPath,
      envFile,
      now: new Date(at.getTime() + 30_000),
    });

    expect(late.ok).toBe(false);
    expect(late.ok === false && late.refusal).toContain("app 111");
    expect(late.ok === false && late.refusal).toContain("nothing was written");
    // Refused **before** the conversion: the second App was never minted, so
    // there is no second orphan and no second key GitHub will not repeat.
    expect(exchanges).toBe(0);
    expect((await store.readAll(0n, 100)).length).toBe(0);

    // And the page names 111 on this process's memory alone — the log holds
    // nothing — while leaving the door open (#169).
    const offer = await offerCreation({ env: {}, envFile, store: half, session });
    expect(offer.offered).toBe(true);
    expect(offer.minted).toEqual({ appId: "111", slug: "lingtai-first" });
  });

  /**
   * **The guard refuses a tab, not a person.** A form posted after the page
   * named the stranded App is a choice made knowing, and refusing it too would
   * close the door the ticket says must stay open.
   */
  it("lets through a form posted after the stranding, and still names the stranded App", async () => {
    const { dir, keyPath } = await workspace();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory\n");
    const at = new Date("2026-09-15T10:00:00Z");
    // The log's clock is the conversion's, so the record is dated with it.
    const store = createMemoryEventStore({ now: () => new Date(at.getTime() + 10_000) });
    const session = createCreationSession();
    const a = session.begin({ name: "lingtai-first", redirectUrl: "http://127.0.0.1:3200/created", now: at });
    const first = await session.finish({
      code: "a",
      state: a.state,
      by: "human:steven",
      fetch: conversion(APP_111),
      store,
      env: {},
      keyPath,
      envFile: join(blocker, ".env.local"),
      now: new Date(at.getTime() + 10_000),
    });
    expect(first.ok === false && first.minted).toEqual({ appId: "111", slug: "lingtai-first" });

    // The page named 111 and offered the form; the person presses it.
    const c = session.begin({
      name: "lingtai-second",
      redirectUrl: "http://127.0.0.1:3200/created",
      now: new Date(at.getTime() + 60_000),
    });
    const { envFile } = await workspace();
    expect((await offerCreation({ env: {}, envFile, store, session })).minted).toEqual({
      appId: "111",
      slug: "lingtai-first",
    });
    const second = await session.finish({
      code: "c",
      state: c.state,
      by: "human:steven",
      fetch: conversion(APP_222),
      store,
      env: {},
      keyPath,
      envFile,
      now: new Date(at.getTime() + 90_000),
    });

    expect(second.ok).toBe(true);
    expect(await readFile(envFile, "utf8")).toContain(`${APP_ID_VAR}="222"`);
  });

  /**
   * The same guard with no help from this process's memory: a board restarted
   * between the two presses has an empty environment and an empty session, and
   * the log — with the time it recorded the App — is the only thing that knows.
   */
  it("refuses on the log alone a form posted before the App it records", async () => {
    const { keyPath, envFile } = await workspace();
    const at = new Date("2026-09-15T10:00:00Z");
    const store = createMemoryEventStore({ now: () => new Date(at.getTime() + 60_000) });
    const session = createCreationSession();
    const begun = session.begin({ name: "lingtai-first", redirectUrl: "http://127.0.0.1:3200/created", now: at });
    await store.append(GITHUB_APP_STREAM, 0, [
      {
        type: "GitHubAppCreated",
        actor: "human:steven",
        data: parsePayload("GitHubAppCreated", { appId: "222", slug: "lingtai-second" }),
      },
    ]);

    const late = await session.finish({
      code: "a",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(APP_111),
      store,
      env: {},
      keyPath,
      envFile,
      now: new Date(at.getTime() + 120_000),
    });

    expect(late.ok === false && late.refusal).toContain("app 222");
    expect(late.ok === false && late.refusal).toContain("nothing was written");
    expect(await there(envFile)).toBe(false);
    expect(await there(keyPath)).toBe(false);
  });

  it("takes a form posted after the App the log records, since the page named it first", async () => {
    const { keyPath, envFile } = await workspace();
    const at = new Date("2026-09-15T10:00:00Z");
    const store = createMemoryEventStore({ now: () => at });
    await store.append(GITHUB_APP_STREAM, 0, [
      {
        type: "GitHubAppCreated",
        actor: "human:steven",
        data: parsePayload("GitHubAppCreated", { appId: "222", slug: "lingtai-second" }),
      },
    ]);
    const session = createCreationSession();
    const begun = session.begin({
      name: "lingtai-first",
      redirectUrl: "http://127.0.0.1:3200/created",
      now: new Date(at.getTime() + 60_000),
    });

    const outcome = await session.finish({
      code: "a",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(APP_111),
      store,
      env: {},
      keyPath,
      envFile,
      now: new Date(at.getTime() + 120_000),
    });

    expect(outcome.ok).toBe(true);
  });

  /** **Unknown is not no**, here as on the page and in `start/route.ts`. */
  it("refuses when the log will not say, rather than writing over what it cannot see", async () => {
    const { keyPath, envFile } = await workspace();
    const unreachable = {
      read: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as EventStore;
    const session = createCreationSession();
    const begun = session.begin({ name: "lingtai-first", redirectUrl: "http://127.0.0.1:3200/created" });

    const late = await session.finish({
      code: "a",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(APP_111),
      store: unreachable,
      env: {},
      keyPath,
      envFile,
    });

    expect(late.ok === false && late.refusal).toContain("cannot tell whether an App was already created");
    expect(late.ok === false && late.refusal).toContain("connection terminated unexpectedly");
    expect(await there(envFile)).toBe(false);
    expect(await there(keyPath)).toBe(false);
  });
});

/**
 * The conversion is a round trip and the page looks hung, so the operator
 * reloads. GitHub honours a code once: a second exchange is a 422 whose
 * sentence is *nothing was written*, and that must not become the answer for a
 * creation that wrote everything.
 */
describe("a return that arrives twice", () => {
  it("hands the reload the first exchange's answer, and exchanges the code once", async () => {
    const { keyPath, envFile } = await workspace();
    const store = createMemoryEventStore();
    const session = createCreationSession();
    const begun = session.begin({ name: "lingtai-steven", redirectUrl: "http://127.0.0.1:3200/created" });

    let exchanges = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first exchange is held open, which is where the reload lands.
    const onceOnly = (async () => {
      exchanges += 1;
      if (exchanges > 1) return new Response(JSON.stringify({ message: "Not Found" }), { status: 422 });
      await held;
      return new Response(JSON.stringify(CONVERSION), { status: 200 });
    }) as typeof fetch;

    const returning = {
      code: "C",
      state: begun.state,
      by: "human:steven",
      fetch: onceOnly,
      store,
      env: {},
      keyPath,
      envFile,
    };
    const first = session.finish({ ...returning });
    const reload = session.finish({ ...returning });
    release();
    const [settled, second] = await Promise.all([first, reload]);

    expect(exchanges).toBe(1);
    expect(settled.ok).toBe(true);
    expect(second).toBe(settled);
    // The screen reads this, and it is not a refusal.
    expect(session.outcome()).toBe(settled);
    expect(await readFile(envFile, "utf8")).toContain(`${APP_ID_VAR}="1234567"`);
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
  /** The env file cannot be written: a directory `mkdir` will refuse to make. */
  const unwritable = async () => {
    const { dir, keyPath } = await workspace();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory\n");
    const store = createMemoryEventStore();
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
      store,
      env: {},
      keyPath,
      envFile: join(blocker, ".env.local"),
    });
    return { outcome, store, session };
  };

  it("names the webhook secret, and its remedy, when the env file cannot be written", async () => {
    const { outcome } = await unwritable();

    expect(outcome.ok).toBe(false);
    const refusal = outcome.ok === false ? outcome.refusal : "";
    expect(refusal).toContain(WEBHOOK_SECRET_VAR);
    expect(refusal).toContain("Set a new webhook secret on the App's own page");
    // Named, and never quoted: a refusal is rendered on a page and kept in the
    // session, which is not where a live secret belongs.
    expect(refusal).not.toContain("webhook-secret-abcdef");
  });

  /**
   * **The App exists whether or not the writing finished, and the log has to
   * say so.** Recorded only on the way out, a refusal here left nothing durable
   * behind it: `offered` went back to true, the page drew the form under the
   * refusal, and an operator reading *could not be written* as a failure
   * pressed Create — minting a second App, a second orphan key beside the
   * first, and the same refusal again, with the record that exists to stop a
   * second App holding none of them.
   */
  it("records the App that was minted even though the env file refused it", async () => {
    const { outcome, store, session } = await unwritable();
    const events = await store.readAll(0n, 100);

    expect(events.map((e) => e.type)).toEqual(["GitHubAppCreated"]);
    expect(events[0]!.data).toEqual({ appId: "1234567", slug: "lingtai-steven" });
    // The refusal says which way it went, because the two have different
    // second presses.
    expect(outcome.ok === false && outcome.refusal).toContain("It is on Lingtai's log");

    // In this process and in a restarted one, the second on the log alone: the
    // App is named, and creation stays offered (#169).
    const { envFile } = await workspace();
    for (const asked of [session, createCreationSession()]) {
      const offer = await offerCreation({ env: {}, envFile, store, session: asked });
      expect(offer.offered).toBe(true);
      // **`minted` and not `configured`.** Nothing was written — that is what
      // this test just made happen — so a page that read the record as a
      // configuration would say *already configured*, and no number of restarts
      // would find `LINGTAI_GITHUB_APP_ID` set.
      expect(offer.configured).toBeNull();
      expect(offer.minted).toEqual({ appId: "1234567", slug: "lingtai-steven" });
      expect(offer.installUrl).toBeNull();
    }
  });

  /**
   * **Minted is not configured** (#169): mint, the key write fails, the board
   * restarts. The screen offers creation, does not claim configuration, and
   * names the stranded App — the page's markup, with its settings link, is
   * `apps/board/test/github-app.test.tsx`'s.
   */
  it("records it when the key file is the write that fails, and a restart still offers creation", async () => {
    const { dir, envFile } = await workspace();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory\n");
    const store = createMemoryEventStore();
    const session = createCreationSession();
    const begun = session.begin({ name: "x", redirectUrl: "http://127.0.0.1:3200/created" });

    const outcome = await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store,
      env: {},
      keyPath: join(blocker, "agent.private-key.pem"),
      envFile,
    });

    expect(outcome.ok).toBe(false);
    expect((await store.readAll(0n, 100)).map((e) => (e.data as { appId: string }).appId)).toEqual(["1234567"]);
    expect(await offerCreation({ env: {}, envFile, store, session: createCreationSession() })).toMatchObject({
      offered: true,
      configured: null,
      minted: { appId: "1234567", slug: "lingtai-steven" },
    });
  });

  /**
   * And when the log itself is what would not take it, the refusal says so —
   * the page *will* offer another, and the operator is the only guard left.
   */
  it("says the log holds no record either, when the log is unreachable too", async () => {
    const { dir, keyPath } = await workspace();
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory\n");
    const half = {
      read: async () => [],
      append: async () => {
        throw new Error("connection terminated unexpectedly");
      },
    } as unknown as EventStore;
    const session = createCreationSession();
    const begun = session.begin({ name: "x", redirectUrl: "http://127.0.0.1:3200/created" });

    const outcome = await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store: half,
      env: {},
      keyPath,
      envFile: join(blocker, ".env.local"),
    });

    expect(outcome.ok === false && outcome.refusal).toContain("The log did not record it either");
    expect(outcome.ok === false && outcome.refusal).toContain("connection terminated unexpectedly");
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
  /** An env file that is not this repository's, and is not there yet. */
  const blank = async () => (await workspace()).envFile;

  it("offers creation when nothing is configured and nothing is on the log", async () => {
    const offer = await offerCreation({
      env: {},
      envFile: await blank(),
      store: store(),
      session: createCreationSession(),
    });

    expect(offer.offered).toBe(true);
    expect(offer.configured).toBeNull();
    expect(offer.minted).toBeNull();
    expect(offer.permissions.map((p) => p.name)).toContain("issues");
  });

  /** `hasGitHubApp()` is true → no second App is minted by accident. */
  it("does not offer creation when the environment already has an App", async () => {
    const offer = await offerCreation({
      env: { [APP_ID_VAR]: "42", [KEY_PATH_VAR]: "~/.ssh/k.pem" },
      envFile: await blank(),
      store: store(),
      session: createCreationSession(),
    });

    expect(offer.offered).toBe(false);
    expect(offer.configured).toEqual({ appId: "42", slug: null, where: "environment", file: null });
  });

  /**
   * **The guard has to read the file the write targets, and not only the
   * environment the process started in.**
   *
   * `@lingtai/env` parses `.env.local` once at import, so `process.env` is a
   * snapshot taken when the board started. An operator who finds they lack the
   * organisation role this flow needs and falls back to `doc/operating.md` —
   * creating the App by hand, saving the key, adding the two lines — has
   * changed nothing that snapshot can see. Reading it alone, the still-open
   * board tab answers *nothing is configured*, draws the button, and the
   * exchange replaces both lines with a second App's while the screen says
   * *Created*: every call fails as not-installed from then on, and
   * the working App's key is the one GitHub will not hand over twice.
   */
  it("reads the env file it would write, not only the environment it started with", async () => {
    const { envFile, keyPath } = await workspace();
    await writeFile(
      envFile,
      `# by hand, after this board started\n${APP_ID_VAR}=999\n${KEY_PATH_VAR}=${keyPath}\n`,
    );
    const log = store();

    const offer = await offerCreation({
      env: {},
      envFile,
      store: log,
      session: createCreationSession(),
    });

    expect(offer.offered).toBe(false);
    // `file`, not `environment`: the credentials are on disk and this process
    // started before them, and `githubApp()` reads them there per call.
    expect(offer.configured).toEqual({ appId: "999", slug: null, where: "file", file: envFile });
  });

  /**
   * `@lingtai/env` loads `.env.local` and then `.env`, first to name a value
   * winning. So an id in `.env` is a real configuration, and writing
   * `.env.local` would *shadow* it — the same accident with an extra file in
   * it, and one where the line that was replaced is still sitting there
   * looking correct.
   */
  it("reads the .env beside it, which is the other file the environment comes from", async () => {
    const { dir, envFile, keyPath } = await workspace();
    await writeFile(join(dir, ".env"), `${APP_ID_VAR}=999\n${KEY_PATH_VAR}=${keyPath}\n`);

    const offer = await offerCreation({
      env: {},
      envFile,
      store: store(),
      session: createCreationSession(),
    });

    expect(offer.offered).toBe(false);
    expect(offer.configured).toEqual({
      appId: "999",
      slug: null,
      where: "file",
      file: join(dir, ".env"),
    });
  });

  /** A copied `.env.example` names it and has no App: that is not a configuration. */
  it("reads an empty line as no App, so a copied template still gets the screen", async () => {
    const { envFile } = await workspace();
    await writeFile(envFile, `# copied from .env.example\n${APP_ID_VAR}=\n${KEY_PATH_VAR}=\n`);

    const offer = await offerCreation({
      env: {},
      envFile,
      store: store(),
      session: createCreationSession(),
    });

    expect(offer.offered).toBe(true);
    expect(offer.configured).toBeNull();
  });

  /** And the same question again where the writing happens. */
  it("refuses a return that would write over an env file configured by hand", async () => {
    const { envFile, keyPath } = await workspace();
    const before = `${APP_ID_VAR}=999\n${KEY_PATH_VAR}=${keyPath}\n`;
    await writeFile(envFile, before);
    const session = createCreationSession();
    const begun = session.begin({ name: "lingtai-x", redirectUrl: "http://127.0.0.1:3200/created" });

    const outcome = await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: conversion(),
      store: store(),
      env: {},
      keyPath: join(await mkdtemp(join(tmpdir(), "lingtai-key-")), "agent.private-key.pem"),
      envFile,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refusal).toContain("app 999");
    expect(outcome.ok === false && outcome.refusal).toContain("nothing was written");
    expect(await readFile(envFile, "utf8")).toBe(before);
  });

  /**
   * **And once more where the write is**, because the two are minutes and a
   * round trip to GitHub apart.
   *
   * `configuration()` read this file before the conversion and it held no App;
   * what happens during the conversion is the operator, in another terminal,
   * giving up on an organisation role they do not have and adding the two lines
   * from `doc/operating.md` by hand. `writeEnv` writes the file whole, so
   * without its own re-read those lines are simply gone — replaced by an App
   * nothing is installed on, under a screen saying *Created*.
   *
   * The re-read is a check and a write and cannot be atomic; what it promises
   * is that a line already on disk when it looks is refused rather than
   * rewritten, and the refusal is the one that names the webhook secret.
   */
  it("refuses a line that appeared during the conversion, and leaves it exactly as it was", async () => {
    const { envFile, keyPath } = await workspace();
    const byHand = `# added by hand while GitHub was answering\n${APP_ID_VAR}=999\n${KEY_PATH_VAR}=${keyPath}\n`;
    const session = createCreationSession();
    const begun = session.begin({ name: "lingtai-x", redirectUrl: "http://127.0.0.1:3200/created" });
    // The conversion's round trip is the window, so this is where the hand
    // edit lands: after the page's check and before the write.
    const slowly = (async () => {
      await writeFile(envFile, byHand);
      return new Response(JSON.stringify(CONVERSION), { status: 200 });
    }) as typeof fetch;

    const outcome = await session.finish({
      code: "fresh",
      state: begun.state,
      by: "human:steven",
      fetch: slowly,
      store: store(),
      env: {},
      keyPath: join(await mkdtemp(join(tmpdir(), "lingtai-key-")), "agent.private-key.pem"),
      envFile,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.refusal).toContain(APP_ID_VAR);
    // The operator's own lines, byte for byte.
    expect(await readFile(envFile, "utf8")).toBe(byHand);
    // The App was minted before that write could fail, so the refusal carries
    // it and the webhook secret's remedy is named — it is handed back once.
    expect(outcome.ok === false && outcome.minted).toEqual({ appId: "1234567", slug: "lingtai-steven" });
    expect(outcome.ok === false && outcome.refusal).toContain("Set a new webhook secret on the App's own page");
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
      envFile: await blank(),
      store: log,
      session: createCreationSession(),
    });

    expect(offer.configured).toEqual({ appId: "7654321", slug: null, where: "environment", file: null });
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

    const offer = await offerCreation({
      env: {},
      envFile: await blank(),
      store: unreachable,
      session: createCreationSession(),
    });

    expect(offer.offered).toBe(false);
    expect(offer.unanswered).toBe("connection terminated unexpectedly");
    // Neither `configured` nor `minted`: nothing is *known*. Three answers, and
    // the page says a different thing about each.
    expect(offer.configured).toBeNull();
    expect(offer.minted).toBeNull();
  });

  /**
   * The asymmetry, as the page meets it: the App ID is fixed at process start,
   * so the board that just wrote one still answers *not configured* from its
   * own environment. **The file it wrote is what closes that**, and it says
   * `where: "file"` — the credentials are there, and read from there per call.
   */
  it("sees the App it has just written, in a process whose environment predates it", async () => {
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
    const offer = await offerCreation({ env: {}, envFile, store: log, session: createCreationSession() });

    expect(offer.offered).toBe(false);
    expect(offer.configured).toEqual({
      appId: "1234567",
      slug: "lingtai-steven",
      where: "file",
      file: envFile,
    });
    expect(offer.minted).toEqual({ appId: "1234567", slug: "lingtai-steven" });
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

    const envFile = await blank();
    const waiting = await offerCreation({
      env: {},
      envFile,
      store: store(),
      session,
      now: new Date(at.getTime() + 60_000),
    });
    const lapsed = await offerCreation({
      env: {},
      envFile,
      store: store(),
      session,
      now: new Date(at.getTime() + ATTEMPT_WINDOW_MS + 1000),
    });

    expect(waiting.outstanding?.state).toBe("waiting");
    expect(lapsed.outstanding).toEqual({ name: "lingtai-taken", org: null, startedAt: at, state: "lapsed" });
  });
});
