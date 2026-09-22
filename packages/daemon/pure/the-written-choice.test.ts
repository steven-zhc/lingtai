/**
 * The whole path, on each of the two stores, from the one value a machine wrote
 * down (#179, [0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md)).
 *
 * **Here because this package is the only one that depends on all three.** The
 * log is `@lingtai/event-store`, the board's cards are `@lingtai/projector` and
 * the beacon is this one, and the claim worth asserting is not that each opens
 * — #178, #219 and #220 each did that — but that **one written word opens all
 * three and nothing else is consulted**.
 *
 * **Every case is a child process**, for two reasons. A machine's choice is
 * read from `~/.lingtai/config.yml` and only outside a test run
 * (`machineChoiceFile`), which is #186's rule and not one to weaken for a test;
 * and *what a process loaded* is a fact only a process has. `LINGTAI_HOME` is
 * the case's own directory throughout, so nothing here can read or write the
 * operator's machine.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "@lingtai/env";
import { describe, expect, it } from "vitest";

/** A module of this workspace, as a URL a spawned `node` can import. */
function module_(...parts: string[]): string {
  return JSON.stringify(pathToFileURL(join(repoRoot(), ...parts)).href);
}

const EVENT_STORE = module_("packages", "event-store", "src", "index.ts");
const PROJECTOR = module_("packages", "projector", "src", "index.ts");
const DAEMON = module_("packages", "daemon", "src", "index.ts");
const CONTROL = module_("packages", "daemon", "src", "control.ts");
const DOMAIN = module_("packages", "domain", "src", "index.ts");

interface Ran {
  home: string;
  status: number | null;
  out: string;
  err: string;
}

/**
 * Runs `script` in a process of its own, with `config` as that machine's
 * `~/.lingtai/config.yml` when there is one to write.
 *
 * The environment is replaced rather than extended: `LINGTAI_DATABASE_URL` is
 * passed empty where a case wants none, because empty is absent to `optional`
 * and present to dotenv — so the checkout's own `.env.local` cannot answer for
 * the machine under test.
 */
function run(script: string, config: string | null, env: NodeJS.ProcessEnv = {}): Ran {
  const home = mkdtempSync(join(tmpdir(), "lingtai-choice-"));
  if (config !== null) writeFileSync(join(home, "config.yml"), config);
  const ran = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: home,
      LINGTAI_HOME: home,
      LINGTAI_DATABASE_URL: "",
      LINGTAI_DIRECT_DATABASE_URL: "",
      ...env,
    },
  });
  return { home, status: ran.status, out: ran.stdout, err: ran.stderr };
}

/** The last line of stdout, parsed. Anything the modules printed first is ignored. */
function said<T>(ran: Ran): T {
  expect(ran.err, ran.err).toBe("");
  expect(ran.status, ran.out).toBe(0);
  return JSON.parse(ran.out.trim().split("\n").at(-1)!) as T;
}

/**
 * **`store: sqlite`, end to end, with no network at all.**
 *
 * An append, a projection folding it, the cards `lingtai status` and the board
 * both read, the lag the health dot reports, and a beacon beating — one
 * process, one file, and `net.Socket.prototype.connect` replaced by a refusal
 * before anything is imported. A Postgres path is a TCP connect, so "no
 * Postgres anywhere" is not a claim here, it is the thing that would have
 * thrown.
 */
describe("a machine that wrote sqlite", () => {
  it("appends, folds, renders and beats, without opening a socket", () => {
    const script = `
      import net from "node:net";
      import tls from "node:tls";
      // Before any import: nothing on this path may reach a network, and a
      // Postgres store cannot avoid trying to.
      const refuse = () => { throw new Error("a network connection was opened"); };
      net.Socket.prototype.connect = refuse;
      net.createConnection = refuse;
      tls.connect = refuse;

      const { eventStore, log } = await import(${EVENT_STORE});
      const { createProjectionRunner, projectionLag, readTasks, taskViewProjection } = await import(${PROJECTOR});
      const { beat, createStatusTable, readStatus } = await import(${CONTROL});
      const { parsePayload, workItemStream } = await import(${DOMAIN});

      const project = "esctest" + Math.random().toString(16).slice(2, 8);
      await eventStore.append(workItemStream(project, 1), 0, [{
        type: "WorkItemDiscovered",
        actor: "conductor",
        data: parsePayload("WorkItemDiscovered", {
          project, source: "manual", externalRef: "1",
          title: "a card with no server behind it", kind: "tech-debt", labels: [],
        }),
      }]);

      const runner = createProjectionRunner({ projection: taskViewProjection });
      await runner.start();

      await createStatusTable();
      await beat("up");
      const status = await readStatus();

      const cards = await readTasks({ project });
      const lags = await projectionLag();
      const streams = await log.queries.projectStreams("wi-");

      await runner.close();
      console.log(JSON.stringify({
        cards: cards.map((c) => c.title),
        state: status?.state ?? null,
        pid: status?.pid ?? null,
        folded: lags.some((l) => l.name === taskViewProjection.name),
        streams: streams.length,
      }));
    `;
    const ran = run(script, "database:\n  store: sqlite\n");
    const read = said<{
      cards: string[];
      state: string | null;
      pid: number | null;
      folded: boolean;
      streams: number;
    }>(ran);

    // The board's card, out of the projection, out of the fold, out of the log.
    expect(read.cards).toEqual(["a card with no server behind it"]);
    // The beacon's row, which is what the health dot and `lingtai doctor` read.
    expect(read.state).toBe("up");
    expect(read.pid).toBeGreaterThan(0);
    // The lag the same dot reports, and the questions that are not a stream
    // read — `LogQueries`, the third face of a log (#221).
    expect(read.folded).toBe(true);
    expect(read.streams).toBe(1);
    // And all of it is in the one file the choice named.
    expect(existsSync(join(ran.home, "lingtai.db"))).toBe(true);
  }, 90_000);
});

/**
 * **`store: postgres`, and `node:sqlite` never loaded.**
 *
 * This is the packaging boundary #178 raised, as an assertion rather than a
 * comment: `@lingtai/projector/sqlite` and `@lingtai/daemon/sqlite` are
 * separate subpaths so that a Postgres install never loads `node:sqlite`, and
 * the selector reaches them through a *dynamic* import for that reason alone.
 * A static one anywhere on this path would put `NativeModule sqlite` in the
 * list below.
 *
 * It also pins the other half: what the three factories opened is Postgres, at
 * the URL that was written, which is the connection this repository has always
 * made.
 *
 * **Every connection is made and every connection is named**, which is the
 * difference between this and a test that watches one. Constructing a
 * `pg.Pool` opens no socket, so a version of this that only *built* the three
 * stores recorded a single address — the daemon's, from `status()` — and
 * `createDb(postgresUrl())` put back into `choose.ts` would have left it
 * green, which is the bug this whole ticket exists to remove. So each of the
 * five faces is used, the recorder is cleared between them, and each is
 * asserted to have gone to the written port **and nowhere else**.
 */
describe("a machine that wrote postgres", () => {
  const URL_ = "postgresql://nobody:secret@127.0.0.1:5599/none";
  const DIRECT = "postgresql://nobody:secret@127.0.0.1:5600/none";

  /**
   * Each face of the choice, used once, with the addresses it reached.
   *
   * `tried` is cleared before each so that an address can be attributed rather
   * than pooled into one list — the waker's is a different question from the
   * store's, and the whole finding here is that they can differ.
   */
  const probe = `
      import net from "node:net";
      // Recorded rather than allowed: the assertion is *which* address the
      // store went to, and a real connection would hang on a closed port.
      //
      // Refused the way a closed port refuses — the socket is returned and
      // destroyed a tick later — rather than by throwing out of \`connect\`.
      // A throw there happens before pg has attached its own handlers, and the
      // \`client.end()\` a waker's \`close()\` makes then writes to a socket
      // nobody is listening to, which takes the process down with an unhandled
      // 'error' and loses the reading.
      const tried = [];
      net.Socket.prototype.connect = function (...args) {
        tried.push(typeof args[0] === "object" ? args[0].port : args[0]);
        process.nextTick(() => this.destroy(new Error("connection refused by this test")));
        return this;
      };
      const at = async (fn) => {
        tried.length = 0;
        await fn().catch(() => {});
        return [...tried];
      };

      const { processLog } = await import(${EVENT_STORE});
      const { projectionStore } = await import(${PROJECTOR});
      const { processDaemonStore } = await import(${DAEMON});

      const log = await processLog();
      const projections = await projectionStore();
      const daemon = await processDaemonStore();

      const store = await at(() => log.store.readAll(0n, 1));
      const queries = await at(() => log.queries.projectStreams("wi-"));
      const waker = await at(async () => {
        const session = log.waker("probe").open({ nudge() {}, lost() {} });
        try { await session.ready; } finally { session.close(); }
      });
      const fold = await at(() => projections.lags());
      const beacon = await at(() => daemon.status());
      await projections.close().catch(() => {});

      console.log(JSON.stringify({
        store, queries, waker, fold, beacon,
        sqlite: process.moduleLoadList.filter((m) => m.includes("sqlite")),
      }));
    `;

  interface Reached {
    store: number[];
    queries: number[];
    waker: number[];
    fold: number[];
    beacon: number[];
    sqlite: string[];
  }

  /** Went to that port, and to no other. `toContain` alone would miss a second database. */
  function only(ports: number[], port: number, what: string): void {
    expect(ports.length, `${what} opened no connection`).toBeGreaterThan(0);
    expect([...new Set(ports)], what).toEqual([port]);
  }

  it("opens all five connections at the written URL, and never loads node:sqlite", () => {
    const read = said<Reached>(run(probe, `database:\n  store: postgres\n  url: ${URL_}\n`));

    // The boundary, stated as what the process loaded.
    expect(read.sqlite).toEqual([]);
    // The log's three faces (#221), the fold, and the beacon — each at the port
    // the file named, none of them anywhere else.
    only(read.store, 5599, "the log's store");
    only(read.queries, 5599, "the log's queries");
    only(read.waker, 5599, "the log's waker");
    only(read.fold, 5599, "the projections");
    only(read.beacon, 5599, "the beacon");
  }, 90_000);

  /**
   * **And the waker's connection, and only the waker's, follows an exported
   * session-mode name.**
   *
   * 0009's one genuine second URL: through a transaction pooler the `LISTEN`
   * registration is handed to someone else between statements and the
   * notification never comes, so on Supabase the two strings differ. What must
   * not happen is the reverse — the waker on a *different database* from the
   * store, which is what `directPostgresUrl()` resolved at `waker()` time
   * would give a machine whose `config.yml` names one URL and whose checkout's
   * `.env.local` names another under `LINGTAI_DATABASE_URL`, the fallback that
   * reader has and this one does not. `directUrl` is part of the choice for
   * that reason, and it is `url` unless this line's variable names a session
   * one — from the environment or from an env file, since that string is what
   * `.env.example` tells a checkout to keep.
   */
  it("sends the waker, alone, to an exported session-mode URL", () => {
    const read = said<Reached>(
      run(probe, `database:\n  store: postgres\n  url: ${URL_}\n`, {
        LINGTAI_DIRECT_DATABASE_URL: DIRECT,
      }),
    );

    only(read.waker, 5600, "the log's waker");
    only(read.store, 5599, "the log's store");
    only(read.queries, 5599, "the log's queries");
    only(read.fold, 5599, "the projections");
    only(read.beacon, 5599, "the beacon");
  }, 90_000);
});

/**
 * **A machine that wrote nothing is refused by name, at first use.**
 *
 * The blocker that refused this ticket's ninth pass, as a test. Under the rule
 * it was written to — *a URL means Postgres, nothing set anywhere means
 * SQLite* — a process that could not see the checkout's `.env.local` concluded
 * SQLite, opened an empty log at `~/.lingtai/lingtai.db`, and reported every
 * append into it as success. For a system whose first rule is that the log
 * settles it, two logs and no error is the worst failure available.
 *
 * So three things are asserted, and the third is the one that matters: the
 * modules load, the first use is refused by name, and **no file was created**.
 */
describe("a machine that wrote nothing", () => {
  it("loads, refuses the first append by name, and creates no log", () => {
    const script = `
      const { eventStore } = await import(${EVENT_STORE});
      const { readTasks } = await import(${PROJECTOR});
      const { readStatus } = await import(${CONTROL});
      console.log("loaded");

      const refusal = async (what, fn) => {
        try { await fn(); return what + ": answered"; }
        catch (err) { return what + ": " + err.message; }
      };
      console.log(JSON.stringify({
        append: await refusal("append", () => eventStore.append("wi-x-1", 0, [])),
        read: await refusal("read", () => eventStore.read("wi-x-1")),
        tasks: await refusal("tasks", () => readTasks({})),
        status: await refusal("status", () => readStatus()),
      }));
    `;
    // No `database` key at all, which is every installation that upgrades into
    // 0056 — and a `config.yml` that exists, because the absence of the file
    // and the absence of the key must reach the same refusal.
    const ran = run(script, "runtime:\n  agent: claude-code\n");
    const read = said<Record<string, string>>(ran);

    expect(ran.out.split("\n")[0]).toBe("loaded");
    for (const [what, line] of Object.entries(read)) {
      expect(line, what).toContain("which store it runs");
      expect(line, what).toContain("lingtai init");
    }
    // **Never defaulted.** An empty append of an empty batch is a no-op on
    // either store, so a file here would mean the refusal had been replaced by
    // a guess — which is exactly what the ninth pass shipped.
    expect(existsSync(join(ran.home, "lingtai.db"))).toBe(false);
  }, 90_000);
});
