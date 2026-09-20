/**
 * The SQLite store and its polling waker, held to the contracts Postgres is
 * (#178).
 *
 * In `pure/` because it needs no server: each assertion gets a log in a
 * directory of its own and throws it away. The contracts are the same files
 * `test/event-store.test.ts` and `test/subscribe.test.ts` run against Postgres
 * — not a variant of them — so a behaviour one store has and the other does not
 * is a failing test.
 *
 * Below the contracts is what the ticket asked be proved rather than argued:
 * **a missed nudge is survivable**, not merely that nudges arrive.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { Envelope } from "@lingtai/domain";
import { afterAll, describe, expect, it, vi } from "vitest";
import { ConcurrencyError } from "../src/event-store.ts";
import { createPollingWaker, createSqliteEventStore, openSqliteLog } from "../src/sqlite.ts";
import { subscribe } from "../src/subscribe.ts";
import type { Waker } from "../src/wake.ts";
import { describeEventStoreContract } from "../test/contract.ts";
import { describeWakerContract } from "../test/wake-contract.ts";

const dirs: string[] = [];
const opened: { close(): void }[] = [];

/** A new log file nobody else has, and the path to it. */
function freshLog(): string {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-sqlite-"));
  dirs.push(dir);
  return join(dir, "log.db");
}

function open(path: string) {
  const db = openSqliteLog(path);
  opened.push(db);
  return db;
}

afterAll(() => {
  for (const db of opened.splice(0)) {
    try {
      db.close();
    } catch {
      // closed by the test
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const discovered = (title: string) => ({
  type: "WorkItemDiscovered",
  actor: "conductor",
  data: { project: "lingtai", source: "manual" as const, externalRef: "test", title, kind: "tech-debt" as const, labels: [] },
});

let n = 0;
const stream = () => `wi-sqlite-${n++}`;

describeEventStoreContract("sqlite", () => createSqliteEventStore(open(freshLog())), stream);

/** A store and a waker on one file, appending through a connection the waker does not hold. */
function harness(options: { intervalMs?: number } = {}) {
  const path = freshLog();
  const store = createSqliteEventStore(open(path));
  const waker = createPollingWaker({ path, ...options });
  return {
    path,
    store,
    waker,
    append: async (title: string) => (await store.append(stream(), 0, [discovered(title)]))[0]!,
    head: async () => {
      const all = await store.readAll(0n, 1_000_000);
      return all.length === 0 ? 0n : all[all.length - 1]!.seq;
    },
  };
}

describeWakerContract("sqlite, polling", () => harness());

async function eventually(predicate: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("sqlite: what the contracts do not say", () => {
  it("keeps the log on disk: a second connection reads what the first wrote", async () => {
    const path = freshLog();
    const id = stream();
    await createSqliteEventStore(open(path)).append(id, 0, [discovered("durable")]);

    const back = await createSqliteEventStore(open(path)).read(id);

    expect(back.map((e) => e.version)).toEqual([1]);
    expect(back[0]!.at).toBeInstanceOf(Date);
  });

  it("refuses the loser of two connections racing for one version", async () => {
    // The contract's conflict is one store against itself. This is the shape
    // that matters in use — two writers, each believing the stream is at 0.
    const path = freshLog();
    const a = createSqliteEventStore(open(path));
    const b = createSqliteEventStore(open(path));
    const id = stream();

    await a.append(id, 0, [discovered("a")]);
    await expect(b.append(id, 0, [discovered("b")])).rejects.toThrow(ConcurrencyError);
  });
});

describe("sqlite: a missed nudge is survivable", () => {
  it("an append whose nudge never came is delivered by the next one", async () => {
    const h = harness();
    // The first nudge is swallowed — as if the poll that would have seen it
    // never ran. Nothing reports it.
    let swallowed = false;
    const lossy: Waker = {
      open: (listener) =>
        h.waker.open({
          nudge: () => {
            if (!swallowed) {
              swallowed = true;
              return;
            }
            listener.nudge();
          },
          lost: (e) => listener.lost(e),
        }),
    };
    const seen: Envelope[] = [];
    const sub = subscribe({ fromSeq: await h.head(), store: h.store, waker: lossy, onEvent: (e) => void seen.push(e) });
    try {
      await sub.caughtUp();
      const first = await h.append("missed");
      await eventually(() => swallowed, () => "the first nudge was never produced");
      // Missed, and nothing has told the subscriber otherwise.
      expect(seen).toEqual([]);

      const second = await h.append("next");
      await eventually(() => seen.length >= 2, () => `${seen.length} of 2 arrived`);
      expect(seen.map((e) => e.seq)).toEqual([first.seq, second.seq]);
    } finally {
      await sub.close();
    }
  });

  it("an append made while a session was lost is delivered by the next session's catch-up", async () => {
    const h = harness();
    // The first session hears nothing and then dies; the append lands in
    // between, so no poll of any session ever sees it arrive.
    let sessions = 0;
    let loseFirst: (() => void) | null = null;
    const dying: Waker = {
      open(listener) {
        sessions += 1;
        if (sessions > 1) return h.waker.open(listener);
        // Deaf: its polls run, and their nudges go nowhere.
        loseFirst = () => listener.lost(new Error("the file went away"));
        return h.waker.open({ nudge: () => {}, lost: () => {} });
      },
    };
    const seen: Envelope[] = [];
    const sub = subscribe({
      fromSeq: await h.head(),
      store: h.store,
      waker: dying,
      onEvent: (e) => void seen.push(e),
      onError: () => {},
      backoff: { baseMs: 10, capMs: 10 },
    });
    try {
      await sub.caughtUp();
      const written = await h.append("while-down");
      loseFirst!();
      await eventually(() => seen.length >= 1, () => "the append made while the session was lost never arrived");
      expect(seen.map((e) => e.seq)).toEqual([written.seq]);
      expect(sessions).toBeGreaterThanOrEqual(2);
    } finally {
      await sub.close();
    }
  });

  it("a head it cannot read ends the session with `lost`, rather than going quiet", async () => {
    const h = harness({ intervalMs: 20 });
    let lost: unknown = null;
    const session = h.waker.open({ nudge: () => {}, lost: (e) => void (lost = e ?? "lost") });
    try {
      await session.ready;
      open(h.path).exec("DROP TABLE events");
      await eventually(() => lost !== null, () => "a poll that failed said nothing");
    } finally {
      session.close();
    }
  });
});

describe("sqlite: what attempt 1's reviewer found", () => {
  it("reports a lost race as ConcurrencyError even when ROLLBACK itself throws", async () => {
    const path = freshLog();
    const a = createSqliteEventStore(open(path));
    const b = createSqliteEventStore(open(path));
    const id = stream();
    await a.append(id, 0, [discovered("a")]);

    // What SQLite does when it has ended the transaction on its own.
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "ROLLBACK") {
        exec.call(this, sql);
        throw new Error("cannot rollback - no transaction is active");
      }
      return exec.call(this, sql);
    });
    try {
      await expect(b.append(id, 0, [discovered("b")])).rejects.toThrow(ConcurrencyError);
      expect(spy).toHaveBeenCalledWith("ROLLBACK");
    } finally {
      spy.mockRestore();
    }
  });

  it("opens a waker session without blocking the event loop while another connection has the file", async () => {
    // A file still in rollback-journal mode, held exclusively: the session's
    // `PRAGMA journal_mode = WAL` cannot have it until the holder lets go —
    // and the holder lets go on a timer, which a blocked thread never runs.
    const path = freshLog();
    const holder = new DatabaseSync(path);
    opened.push(holder);
    holder.exec("CREATE TABLE held (x INTEGER)");
    holder.exec("BEGIN EXCLUSIVE");
    holder.exec("INSERT INTO held VALUES (1)");

    let ticks = 0;
    const clock = setInterval(() => void (ticks += 1), 10);
    const session = createPollingWaker({ path, intervalMs: 20 }).open({ nudge: () => {}, lost: () => {} });
    let ready = false;
    void session.ready.then(() => void (ready = true));
    try {
      const opening = Date.now();
      await new Promise((r) => setTimeout(r, 300));
      expect(ready).toBe(false);
      expect(ticks).toBeGreaterThan(5);
      expect(Date.now() - opening).toBeLessThan(2_000);

      holder.exec("COMMIT");
      await session.ready;
      expect(ready).toBe(true);
    } finally {
      clearInterval(clock);
      session.close();
    }
  });

  it("sets the busy timeout by pragma, so a second writer waits on Node below 22.16 too", () => {
    const db = open(freshLog());
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
  });
});

describe("sqlite: on a Node without node:sqlite", () => {
  it("fails the SQLite store by name, and the waker's session with it", async () => {
    const real = process.getBuiltinModule;
    const spy = vi
      .spyOn(process, "getBuiltinModule")
      .mockImplementation(((id: string) => (id === "node:sqlite" ? undefined : real.call(process, id))) as typeof real);
    try {
      expect(() => openSqliteLog(freshLog())).toThrow(/needs node:sqlite.*Node 22\.13 or later/);
      const session = createPollingWaker({ path: freshLog() }).open({ nudge: () => {}, lost: () => {} });
      await expect(session.ready).rejects.toThrow(/Node 22\.13 or later/);
      session.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("still imports @lingtai/event-store, in a process where the module does not exist", async () => {
    // A process, not a mock: a static `import "node:sqlite"` anywhere under the
    // barrel is resolved before any of this package's code runs, so only a Node
    // that refuses to resolve it proves the import is not there.
    const dir = mkdtempSync(join(tmpdir(), "lingtai-nosqlite-"));
    dirs.push(dir);
    const hook = join(dir, "no-sqlite.mjs");
    writeFileSync(
      hook,
      `import { registerHooks } from "node:module";
       const gone = (id) => id === "node:sqlite" || id === "sqlite";
       registerHooks({
         resolve(specifier, context, next) {
           if (gone(specifier)) {
             throw Object.assign(new Error("No such built-in module: " + specifier), { code: "ERR_UNKNOWN_BUILTIN_MODULE" });
           }
           return next(specifier, context);
         },
       });
       const real = process.getBuiltinModule;
       process.getBuiltinModule = (id) => (gone(id) ? undefined : real.call(process, id));`,
    );
    const barrel = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const script = `
      const m = await import(${JSON.stringify(barrel)});
      console.log("imported");
      try { m.openSqliteLog(${JSON.stringify(join(dir, "log.db"))}); } catch (e) { console.log(e.message); }`;
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ["--import", hook, "--input-type=module", "-e", script],
        // A URL, so the barrel is a Postgres one and this assertion is about
        // the import alone. Since #179 it builds nothing either way — the
        // client and the log are both opened on first use — and absence here
        // would make the child choose SQLite, which is the next test's subject
        // and not this one's.
        { env: { ...process.env, LINGTAI_DATABASE_URL: "postgres://nobody@127.0.0.1:1/none" }, timeout: 30_000 },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)),
      ),
    );
    const lines = out.trim().split("\n");
    expect(lines[0]).toBe("imported");
    expect(lines[1]).toMatch(/^the SQLite store needs node:sqlite, which Node v[\d.]+ does not have without a flag — Node 22\.13 or later has it$/);
  }, 40_000);
});

/**
 * **Absence chooses this store** (#179, [0055](../../../doc/decisions/0055-absence-chooses-the-store.md)).
 *
 * `packages/env/test/env.test.ts` asserts what `storeChoice()` answers; this
 * asserts that the answer is *what the singleton opens*, which is the claim
 * that makes it the choice rather than a description of one. Nothing else
 * covers it: every other caller of `eventStore` in the suite is under vitest,
 * where `inTest` sends `storeChoice` to the `TEST_` names and it can only ever
 * be Postgres — which is the other half of the ticket and the reason this has
 * to be a process of its own.
 *
 * `LINGTAI_DATABASE_URL: ""` rather than deleting it, because dotenv does not
 * overwrite a name `process.env` already has: a developer whose `.env.local`
 * names a URL would otherwise have that URL loaded into the child and this
 * would assert Postgres while claiming to assert absence. Empty is absent to
 * `optional()` and present to dotenv, which is exactly the lever wanted.
 */
describe("sqlite: the store absence chooses (#179)", () => {
  it("is what the singleton opens, at ~/.lingtai/lingtai.db — and not before something reads or appends", async () => {
    const home = mkdtempSync(join(tmpdir(), "lingtai-absent-"));
    dirs.push(home);
    const barrel = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const log = join(home, "lingtai.db");
    const script = `
      const { existsSync } = await import("node:fs");
      const m = await import(${JSON.stringify(barrel)});
      console.log("after import: " + existsSync(${JSON.stringify(log)}));
      const claimed = { type: "WorkItemClaimed", actor: "conductor", data: { runId: "run-1", worker: "test", title: null, kind: null } };
      const written = await m.eventStore.append("wi-absent", 0, [claimed]);
      console.log("appended: " + written[0].seq + " " + written[0].type);
      const read = await m.eventStore.read("wi-absent", 0);
      console.log("read back: " + read.length + " " + read[0].type);
      console.log("after append: " + existsSync(${JSON.stringify(log)}));`;
    const out = await new Promise<string>((resolve, reject) =>
      execFile(
        process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", script],
        {
          env: {
            ...process.env,
            LINGTAI_HOME: home,
            LINGTAI_DATABASE_URL: "",
            LINGTAI_DIRECT_DATABASE_URL: "",
            // The pre-#63 name is a connection somebody named, and
            // `storeChoice` refuses rather than choosing SQLite past it — so a
            // developer with one exported would get that refusal here instead
            // of the absence this asserts.
            DATABASE_URL: "",
            VITEST: "",
            LINGTAI_TEST: "",
          },
          timeout: 60_000,
        },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)),
      ),
    );

    // A bare `lingtai --version` imports this barrel and must not leave a log
    // behind: the client and the file are both opened on first use.
    expect(out).toContain("after import: false");
    // Not a Postgres error, and not `LINGTAI_DATABASE_URL is not set`: the
    // append went to the file absence named, and came back out of it.
    expect(out).toContain("appended: 1 WorkItemClaimed");
    expect(out).toContain("read back: 1 WorkItemClaimed");
    expect(out).toContain("after append: true");
  }, 90_000);
});
