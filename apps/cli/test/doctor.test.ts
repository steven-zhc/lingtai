/**
 * Most of these need no database: a doctor whose environment check fails must
 * not go on to open connections, so the failure paths are pure.
 *
 * The last one does need it, and it is the one that matters — it is Phase 0's
 * exit criterion written as an assertion.
 */
import { createDb, createEventStore, directPostgresUrl, postgresUrl } from "@lingtai/event-store";
import { beat, createStatusTable } from "@lingtai/daemon";
import { SUBSCRIBER_STREAM } from "@lingtai/domain";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { RECIPE_PATH, resolveRecipe } from "@lingtai/recipe";
import { CLAUDE_CODE_CAPABILITIES } from "@lingtai/agent";
import type { StoreChoice } from "@lingtai/env";
import {
  daemonLiveness,
  declaredExtensions,
  describeRefusal,
  extensionRow,
  formatReport,
  limitsRow,
  logReachable,
  postgresOnlyRows,
  runDoctor,
} from "../src/doctor.ts";
import { createSqliteLogQueries, openSqliteLog } from "@lingtai/event-store/sqlite";
import type { LogQueries } from "@lingtai/event-store";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The count `lingtai restart` gates on, asked of this report rather than
// restated: a row that stops a restart is the half of #179's refusal a status
// alone does not show (0042).
import { gatingFailures } from "../src/restart.ts";

const POOLED = "postgresql://u:p@db.example.com:6543/postgres?pgbouncer=true";
const DIRECT = "postgresql://u:p@db.example.com:5432/postgres";

/** Only the two variables matter; the rest of the environment is noise here. */
const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)) as NodeJS.ProcessEnv;

/**
 * Generic, so the check's own type survives the lookup.
 *
 * It took `{ name: string }[]` and therefore returned one — every `.status` and
 * `.detail` below was an error nobody could see, because this file was not
 * typechecked (`#70`). The assertions were right; the helper threw the type
 * away on the way past.
 */
function find<T extends { name: string }>(results: readonly T[], name: string): T {
  const r = results.find((x) => x.name === name);
  expect(r, `no check named ${name}`).toBeDefined();
  return r!;
}

describe("lingtai doctor — environment", () => {
  it("fails, and names which variable, when one is missing", async () => {
    // The pooled one: the direct one has a stand-in (#176), the pooled one has none.
    const report = await runDoctor(env({ LINGTAI_DIRECT_DATABASE_URL: DIRECT }));
    const e = find(report.results, "environment");

    expect(e.status).toBe("fail");
    expect(e.detail).toContain("LINGTAI_DATABASE_URL");
    expect(e.detail).not.toContain("LINGTAI_DIRECT_DATABASE_URL");
    expect(report.failed).toBeGreaterThan(0);
  });

  it("names both when neither is set", async () => {
    const e = find((await runDoctor(env({}))).results, "environment");
    expect(e.detail).toContain("LINGTAI_DATABASE_URL and LINGTAI_DIRECT_DATABASE_URL");
  });

  it("refuses a pooled URL standing in for the direct one, and says to set it", async () => {
    // #176's trap: the fallback only fills a gap, and on Supabase the gap it
    // fills with the pooler is the connection that loses a NOTIFY silently.
    const report = await runDoctor(env({ LINGTAI_DATABASE_URL: POOLED }));
    const e = find(report.results, "environment");

    expect(e.status).toBe("fail");
    expect(e.detail).toContain("cannot stand in");
    expect(e.detail).toContain("set LINGTAI_DIRECT_DATABASE_URL");
    expect(find(report.results, "postgres").status).toBe("skip");
  });

  it("reads ~/.lingtai/config.yml's database.url when neither variable is set, as postgresUrl does (#186)", async () => {
    // A pooler URL, so the check fails on its shape and nothing is connected to.
    const report = await runDoctor(env({}), () => POOLED);
    const e = find(report.results, "environment");
    expect(e.detail).toContain("~/.lingtai/config.yml database.url :6543");
    expect(e.detail).toContain("cannot stand in");

    // The variable wins, and the file is not asked.
    const set = await runDoctor(env({ LINGTAI_DATABASE_URL: POOLED }), () => {
      throw new Error("asked");
    });
    expect(find(set.results, "environment").detail).toContain("LINGTAI_DATABASE_URL :6543");
  });

  it("fails by the file's own complaint when config.yml does not parse", async () => {
    const report = await runDoctor(env({}), () => {
      throw new Error("/home/me/.lingtai/config.yml could not be parsed as YAML");
    });
    const e = find(report.results, "environment");
    expect(e.status).toBe("fail");
    expect(e.detail).toContain("could not be parsed");
  });

  it("does not attempt Postgres once the environment is wrong", async () => {
    const report = await runDoctor(env({}));
    expect(find(report.results, "postgres").status).toBe("skip");
  });

  it("reports the two URLs separately, and never prints either", async () => {
    const report = await runDoctor(env({ LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT }));
    const detail = find(report.results, "environment").detail;

    expect(detail).toContain(":6543");
    expect(detail).toContain(":5432");
    // Not the credentials, and not the host — on a hosted Postgres the project
    // identifier lives in the hostname.
    expect(detail).not.toContain("p@");
    expect(detail).not.toContain("db.example.com");
    expect(detail).not.toContain("postgresql://");
  });

  /**
   * The cheap half of the 0009 check. The expensive half — holding a listener
   * open and notifying from a second connection — cannot run without a database,
   * and is exercised in `lingtai doctor` itself against the real one.
   */
  it("fails when the direct URL still carries pgbouncer=true", async () => {
    const report = await runDoctor(
      env({ LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: `${DIRECT}?pgbouncer=true` }),
    );
    const e = find(report.results, "environment");

    expect(e.status).toBe("fail");
    expect(e.detail).toContain("pgbouncer=true");
  });

  it("fails when the two URLs are not the same database", async () => {
    const report = await runDoctor(
      env({
        LINGTAI_DATABASE_URL: POOLED,
        LINGTAI_DIRECT_DATABASE_URL: "postgresql://u:p@other.example.com:5432/postgres",
      }),
    );
    // A subscriber listening to one log while the writer appends to another is
    // not a configuration with a meaning.
    expect(find(report.results, "environment").status).toBe("fail");
    expect(find(report.results, "environment").detail).toContain("one database");
  });
});

/**
 * **A machine that wrote `store: sqlite` is set up, and doctor has to say so**
 * (#179, [0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md)).
 *
 * `lingtai init` finishes on a SQLite answer now, and that machine works —
 * `packages/daemon/pure/the-written-choice.test.ts` appends, folds `task_view`,
 * renders the cards and beats the beacon on one in a process where opening a
 * socket throws. Doctor then called it broken: `environment` was pushed
 * whatever the store was, found no `LINGTAI_DATABASE_URL` and no
 * `database.url` — the sqlite branch of `storeChoice` refuses a file carrying
 * one — and failed by the name of a variable this machine is right not to
 * have, naming a Postgres URL as the remedy. Carrying no `restartAnswers`, that
 * failure also refused `lingtai restart` (`gatingFailures`, 0042). Setup said
 * correct, doctor said broken, and the way out it offered was to abandon a
 * working configuration.
 *
 * The choice is handed in rather than written to a `config.yml`, because what
 * is under test is the fork `runDoctor` takes on it. The rows after the fork
 * open the store *this process* chose, which in this suite is the test
 * Postgres; what is asserted about them is that they are asked at all.
 */
describe("lingtai doctor — a machine whose log is a file", () => {
  const home = mkdtempSync(join(tmpdir(), "lingtai-doctor-"));
  const dbPath = join(home, "lingtai.db");
  const wroteSqlite = (): StoreChoice => ({
    store: "sqlite",
    path: dbPath,
    where: "config.yml",
    from: join(home, "config.yml"),
  });

  /**
   * **A real SQLite log, so the rows below are answered rather than merely
   * reached.** The file is created by opening it, which is the whole of what
   * `log: reachable` asserts about a machine `lingtai init` has just finished:
   * `init` writes the choice and never the file.
   */
  const openFile = (): { queries: LogQueries; close: () => void } => {
    const db = openSqliteLog(dbPath);
    return { queries: createSqliteLogQueries(db), close: () => db.close() };
  };

  /** The rows this fork decides. Everything after them is GitHub and the operator's own projects. */
  const OF_THIS_FORK = [
    "store: the machine's written choice",
    "environment",
    "log: reachable",
    ...postgresOnlyRows().map((r) => r.name),
  ];

  it("asks it for no connection string, and fails it for nothing", async () => {
    const file = openFile();
    try {
      const report = await runDoctor(
        env({}),
        () => {
          throw new Error("the machine file was asked for a database.url");
        },
        wroteSqlite,
        file.queries,
      );

      const e = find(report.results, "environment");
      expect(e.status).toBe("skip");
      // Never the sentence that sent the operator back to `lingtai init` with a
      // Postgres URL: there is nothing here to set.
      expect(e.detail).not.toContain("lingtai init writes one");
      expect(e.detail).not.toContain(".env.local");
      // The row that does speak about this machine is green, and it is the only
      // one that decides anything.
      expect(find(report.results, "store: the machine's written choice").status).toBe("ok");
      // The whole of the refusal, counted the way the command it blocked counts
      // it.
      const thisFork = report.results.filter((r) => OF_THIS_FORK.includes(r.name));
      expect(thisFork).toHaveLength(OF_THIS_FORK.length);
      expect(gatingFailures(thisFork)).toBe(0);
    } finally {
      file.close();
    }
  });

  /**
   * **The row that answers the one question anybody runs this command for**
   * ([#214](https://github.com/steven-zhc/lingtai/issues/214)).
   *
   * `postgres: pooled connection` was the only asker of *is the log reachable*,
   * so on a machine with no Postgres nothing asked it and the summary said
   * `0 failed` anyway.
   */
  it("says whether the log is reachable, and opens it rather than looking for the file", async () => {
    // Deliberately not opened first: this is the machine `lingtai init` leaves
    // behind, whose `config.yml` names a path with no file at it yet. A row
    // that stat()ed the path would fail it for ever — `init` never writes the
    // file — and that failure gates `lingtai restart`.
    const fresh = join(mkdtempSync(join(tmpdir(), "lingtai-fresh-")), "lingtai.db");
    expect(existsSync(fresh)).toBe(false);
    const db = openSqliteLog(fresh);
    try {
      const row = await logReachable(fresh, createSqliteLogQueries(db));
      expect(row.status).toBe("ok");
      expect(row.detail).toContain(fresh);
    } finally {
      db.close();
    }
    expect(existsSync(fresh)).toBe(true);
  });

  it("fails, rather than skipping, where the log cannot be opened", async () => {
    const row = await logReachable("/var/empty/nowhere/lingtai.db", {
      projectStreams: async () => {
        throw new Error("SQLITE_CANTOPEN: unable to open database file");
      },
    } as unknown as LogQueries);

    expect(row.status).toBe("fail");
    expect(row.detail).toContain("SQLITE_CANTOPEN");
    // No `restartAnswers`: restarting a daemon does not make a log openable,
    // and this is a failure `lingtai restart` is right to stop for.
    expect(gatingFailures([row])).toBe(1);
  });

  it("still gets every row that is about a log rather than about Postgres", async () => {
    const file = openFile();
    try {
      const report = await runDoctor(env({}), () => undefined, wroteSqlite, file.queries);

      // Each of these asks the store this machine chose, so each answers on a
      // file too — and losing them along with the connection rows was the same
      // defect's other half.
      for (const name of [
        "log: reachable",
        "projections: lag",
        "projections: shape",
        "daemon: liveness",
        "daemon: currency",
        "conductor: lock",
        "worktrees: reconciliation",
        "log: every type is readable",
        "github: what we said and did not manage",
        "subscribers: failures",
        "gates: end ran on what landed",
        "gates: every point that was planned ran",
      ]) {
        expect(find(report.results, name).status, `${name} did not run`).not.toBe("skip");
      }
    } finally {
      file.close();
    }
  });

  /**
   * **Twelve rows used to vanish into one line** saying `postgres: not
   * attempted`, so a reader could not tell a check that does not apply from a
   * check that was never written — ADR 0016 §4's rule about a thing you cannot
   * tell apart from its absence, in the one command built to prevent it.
   *
   * Seven of the twelve are about Postgres and are `postgresOnlyRows()`, which
   * this iterates; the other five were questions about a log, and are asked of
   * the file above rather than given a line saying why they do not apply. The
   * list is the count: nothing here restates its length.
   *
   * Each keeps its name, each is a `skip` and never a silent pass, and each
   * detail **names the store** and says why the question does not apply here.
   * The assertion is on the sentence and not on its length: a detail long
   * enough to look like a reason is not a reason.
   */
  it("gives every Postgres row its own line, its own reason, and the store's name", async () => {
    const file = openFile();
    try {
      const report = await runDoctor(env({}), () => undefined, wroteSqlite, file.queries);

      for (const expected of postgresOnlyRows()) {
        const row = find(report.results, expected.name);
        expect(row.status, `${expected.name} is not a skip`).toBe("skip");
        expect(row.detail, `${expected.name} does not name the store`).toContain("store: sqlite");
        expect(row.detail, `${expected.name} gives no reason`).toContain(expected.because);
        // Not deferred: this is a fact about this machine, not about what
        // Lingtai has not built.
        expect(row.deferred).toBeUndefined();
      }
      // And `environment`, the eighth skip this fork produces, on the same
      // terms: a reason that names the store, not a bare skip.
      const e = find(report.results, "environment");
      expect(e.status).toBe("skip");
      expect(e.detail).toContain("store: sqlite");
      // And the single collapsed row is gone.
      expect(report.results.some((r) => r.name === "postgres")).toBe(false);
    } finally {
      file.close();
    }
  });

  /**
   * The ticket's third box, as a structural claim rather than a string match:
   * **`0 failed` is only ever printed for a machine whose log was reached.**
   *
   * It holds by construction — a green summary needs the store row to be `ok`,
   * and every branch that follows an `ok` store row pushes a reachability row,
   * `log: reachable` on a file and `postgres: pooled connection` on a server.
   * Asserted here so that a branch added without one is a failing test.
   *
   * **Unconditionally, and that is the point of it.** The rows around this one
   * — the recipes, the declared environment, `runtimeAuth`, the projections —
   * run against the real machine and the shared test database, so on a machine
   * with no `~/.lingtai/lingtai/recipe.yml`, or with projection drift,
   * `report.failed` is not zero. Asserted under `if (report.failed === 0)`,
   * this test would assert nothing there and stay green over a branch that
   * pushed no reachability row at all — which is the one thing it exists to
   * catch, and CI is the obvious machine it would have been silent on.
   */
  it("never prints 0 failed without a row that reached the log", async () => {
    const file = openFile();
    try {
      const report = await runDoctor(env({}), () => undefined, wroteSqlite, file.queries);
      // `postgres: pooled connection` is here too, as the `skip` saying why it
      // does not apply — and a skip reached nothing, which is the distinction
      // the whole ticket is about.
      const reached = report.results.filter(
        (r) =>
          (r.name === "log: reachable" || r.name === "postgres: pooled connection") && r.status !== "skip",
      );

      // The row is there and it reached the log, whatever else on this machine
      // did or did not pass — so `0 failed`, printed or not, is never printed
      // without it.
      expect(reached.map((r) => r.name)).toEqual(["log: reachable"]);
      expect(reached[0]?.status).toBe("ok");
      if (report.failed === 0) expect(formatReport(report)).toContain("0 failed");
      // And the summary distinguishes what was not checked here from what is
      // not implemented anywhere: one number for each.
      expect(report.notChecked).toBeGreaterThanOrEqual(postgresOnlyRows().length);
      expect(report.deferred).toBe(report.results.filter((r) => r.deferred).length);
      expect(report.notChecked + report.deferred).toBe(report.skipped);
      expect(formatReport(report)).toContain(`${report.notChecked} not checked here`);
      expect(formatReport(report)).toContain(`${report.deferred} not implemented yet`);
    } finally {
      file.close();
    }
  });
});

describe("lingtai doctor — the runtime's own login", () => {
  /**
   * The check exists because the operator being signed in says nothing about
   * whether a *run* can sign in. A run's environment is filtered, and the first
   * real run against a repository died on "Not logged in" while the operator
   * was signed in perfectly well — the filtered environment had no `USER`, and
   * macOS finds a keychain item by who is asking.
   *
   * This asserts the check is present and reports on the *run's* environment.
   * Whether this machine happens to be signed in is not the test's business.
   */
  it("asks the runtime, and says which environment it asked in", async () => {
    const report = await runDoctor(env({}));
    const check = report.results.find((r) => r.name === "runtime: signed in");

    expect(check).toBeDefined();
    if (check?.status === "fail") {
      // A failure has to name the environment it probed, because "not signed
      // in" without that sends the reader to `/login` — which is the one thing
      // that would not have helped.
      expect(check.detail).toMatch(/filtered environment a run gets/);
      expect(check.detail).toContain("USER");
    } else {
      expect(check?.status).toBe("ok");
    }
  }, 60_000);
});

describe("lingtai doctor — the declared environment", () => {
  /**
   * The half of [ADR 0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)
   * that costs nothing: the same question a run asks, answered before any money
   * is spent. The recipe is this machine's file since #180, so no App is
   * needed to read it: with none configured the row still runs — one row per
   * project, or one saying there is none — rather than skipping for a reason
   * that is no longer true. `pure/doctor-recipe.test.ts` pins the per-project row.
   */
  it("is listed, and runs with no App configured", async () => {
    const report = await runDoctor(env({}));
    const rows = report.results.filter((r) => r.name.startsWith("env:"));

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.detail).not.toContain("no App configured");
    // Not deferred: it runs whenever a project exists.
    for (const row of rows) expect(row.deferred).toBeUndefined();
  });
});

/**
 * An extension's declared variable, reported **before** a run rather than during
 * one ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1).
 *
 * The row is checked directly rather than through `runDoctor`, because reaching
 * it there needs an App, a registered project and a recipe over the network —
 * and what is worth pinning is the fold, not the fetch. `declaredExtensions`
 * runs against a real resolved recipe so that the union in the schema and the
 * reading of it here cannot drift.
 */
describe("lingtai doctor — an extension's declared environment", () => {
  const RECIPE = `
version: 1
repo:
  base: main
source:
  kinds: [bug]
env:
  required: []
  plantAt: .env.local
gates:
  prepared:
    - name: install
      run: pnpm install
  proposed:
    - name: scan
      run: npx scanner
      env: [SCANNER_TOKEN]
runtime:
  agent: claude-code
subscribers:
  - name: telegram
    on: [WorkItemLanded]
    run: npx @lingtai/telegram
    env: [TELEGRAM_BOT_TOKEN]
`;

  const recipeOf = async () =>
    (await resolveRecipe(async (path, ref) => (ref === "main" && path === RECIPE_PATH ? RECIPE : null), "main"))
      .recipe;

  /** A `run:` at any point and every subscriber — the whole extension mechanism. */
  it("finds every extension, at a gate point or subscribed", async () => {
    expect(declaredExtensions(await recipeOf())).toEqual([
      { name: "install", env: [] },
      { name: "scan", env: ["SCANNER_TOKEN"] },
      { name: "telegram", env: ["TELEGRAM_BOT_TOKEN"] },
    ]);
  });

  const agentEnv = (merged: Record<string, string>) => ({
    merged,
    names: Object.keys(merged).map((name) => ({ name, layer: "project file" })),
    file: "/home/x/.lingtai/env/demo.env",
  });

  it("is green when this machine holds every declared name", async () => {
    const row = extensionRow(
      "demo",
      await recipeOf(),
      agentEnv({ SCANNER_TOKEN: "s", TELEGRAM_BOT_TOKEN: "t" }),
    );

    expect(row.status).toBe("ok");
    expect(row.detail).toContain("telegram: TELEGRAM_BOT_TOKEN ← demo.env");
    // Names only, never values — the whole point of the file it came from.
    expect(row.detail).not.toContain("token");
  });

  /**
   * The failure this exists for. An extension gets *only* what it declares, so a
   * name this machine does not hold is a bot that starts, finds nothing and
   * exits — and a subscriber's exit code is discarded, so nobody is told.
   */
  it("is red before a run when a declared name is not set, and names it", async () => {
    const row = extensionRow("demo", await recipeOf(), agentEnv({ SCANNER_TOKEN: "s" }));

    expect(row.status).toBe("fail");
    expect(row.detail).toContain("TELEGRAM_BOT_TOKEN");
    expect(row.detail).toContain("not set");
    // A red that names the command that clears it.
    expect(row.detail).toContain("lingtai env set demo TELEGRAM_BOT_TOKEN");
  });

  /**
   * `#51`. The agent's row checks what survives `deny`; an extension reads its
   * names from the merged files, so a denied production value it declares is
   * only caught here — before a run, not at `gates.prepared` after the claim.
   */
  it("is red before a run when an extension declares a denied production value", async () => {
    const recipe = await resolveRecipe(
      async () =>
        RECIPE.replace("  required: []", "  required: []\n  deny: [SCANNER_TOKEN]\n  refuseHosts: [eliwlauokdzgsqfgczkv]"),
      "main",
    );
    const row = extensionRow(
      "demo",
      recipe.recipe,
      agentEnv({
        SCANNER_TOKEN: "postgresql://postgres:s3cr3t@db.eliwlauokdzgsqfgczkv.supabase.co:5432/postgres",
        TELEGRAM_BOT_TOKEN: "t",
      }),
    );

    expect(row.status).toBe("fail");
    expect(row.detail).toMatch(/scan: SCANNER_TOKEN looks like production.*"eliwlauokdzgsqfgczkv"/);
    expect(row.detail).not.toContain("s3cr3t");
  });

  it("says so plainly when no extension asks for anything", async () => {
    const bare = await resolveRecipe(
      async () => RECIPE.replace(/\n +env: \[[A-Z_]+\]/g, ""),
      "main",
    );
    const row = extensionRow("demo", bare.recipe, agentEnv({}));

    expect(row.status).toBe("ok");
    expect(row.detail).toContain("none asking for a variable");
  });

  /**
   * `#89`'s last box: doctor says whether a declared limit is one the runtime
   * applies. Asked of the runtime that runs — `createClaudeCodeRuntime()` —
   * and not of `runtime.agent`, which nothing dispatches on.
   */
  it("says which declared limits the runtime that runs applies", async () => {
    const row = limitsRow("demo", await recipeOf());

    expect(row.name).toBe("runtime: demo limits");
    expect(row.status).toBe("ok");
    expect(row.detail).toBe("turns 300 ← applied by claude-code · wall 2h ← applied by claude-code");
  });

  it("is red when the runtime carries a declared limit and bounds nothing with it", async () => {
    // The adapter as it was before `#89`: the wall read, the turns carried.
    const row = limitsRow("demo", await recipeOf(), {
      ...CLAUDE_CODE_CAPABILITIES,
      enforces: ["wall"],
    });

    expect(row.status).toBe("fail");
    expect(row.detail).toContain("turns 300 ← not applied");
    expect(row.detail).toContain("wall 2h ← applied by claude-code");
    expect(row.detail).toContain("claude-code carries turns and bounds nothing with it");
  });
});

describe("lingtai doctor — the recipes", () => {
  /**
   * This check was in `DEFERRED` — a permanent skip, on the argument that a
   * recipe read here would be a different commit's. Both read the same file —
   * `~/.lingtai/<project>/recipe.yml` since #180 — and the question is only
   * whether the file that governs the next run parses at all: it did not, on
   * `main`, for long enough that every issue in the project sat unpicked with
   * doctor green throughout (#76).
   */
  it("runs, rather than being deferred forever", async () => {
    const report = await runDoctor(env({}));
    const rows = report.results.filter((r) => r.name.startsWith("recipe: ") && r.name !== "recipe: the rules and the merge target are one branch");

    // The recipe is this machine's file, so no App is needed to read it: the
    // row runs with none configured rather than skipping for one.
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.detail).not.toContain("no App configured");
    for (const row of rows) expect(row.deferred).toBeUndefined();
    expect(report.results.some((r) => r.name === "recipe: schema")).toBe(false);
  });
});

describe("lingtai doctor — reporting", () => {
  it("lists the checks that cannot run yet, rather than omitting them", async () => {
    // With no LINGTAI_GITHUB_APP_ID in this environment, the credentials check is itself
    // a skip rather than a failure — not being onboarded is a legitimate state.
    const report = await runDoctor(env({}));
    const skipped = report.results.filter((r) => r.status === "skip").map((r) => r.name);

    expect(skipped).toContain("github: app credentials");

    // A check you cannot see is a check you will forget you never had.
    expect(skipped).toContain("hook: fail closed");
    expect(skipped).toContain("github: installation and labels");
  });

  /**
   * The reason is the whole value of a skip, and a deferred reason is a literal
   * — it cannot re-read the world. Two of them said no project was onboarded
   * while two were, and sent a reader off to re-run `lingtai add`.
   *
   * So a deferred detail may say why the check is not a startup check, and may
   * not describe the state of the installation it is running in. Asserted on
   * the `deferred` flag rather than on "skip", because a check skipped for a
   * reason (the environment failed first) is a different thing: that one is
   * *about* the state of this run, and has to be.
   */
  it("gives deferred checks a reason that cannot go stale", async () => {
    const report = await runDoctor(env({}));
    const deferred = report.results.filter((r) => r.deferred);
    expect(deferred.length).toBeGreaterThan(0);

    // The vocabulary of "what is installed right now". A fixed sentence that
    // reaches for one of these is claiming something it never looked at.
    const stateOfTheMachine = /onboard|registered|not yet|no project|is empty/i;
    for (const r of deferred) {
      expect(r.detail, `${r.name} claims a fact about this installation`).not.toMatch(stateOfTheMachine);
      // A reason, not a shrug.
      expect(r.detail.length, `${r.name} gives no reason`).toBeGreaterThan(40);
    }
  });

  it("says how many failed, and every check says what it found", async () => {
    const report = await runDoctor(env({}));
    expect(formatReport(report)).toContain("FAILED");
    expect(report.results.every((r) => r.detail.length > 0)).toBe(true);
  });
});

/**
 * `#148`: a daemon at `cc6e856` refused every sweep of a recipe that a `doctor`
 * run from a newer checkout resolved cleanly. What the log says is read beside
 * which code this report's own recipe rows run.
 */
describe("lingtai doctor — refusals on the log", () => {
  const OLD = "cc6e856".padEnd(40, "0");
  const NEW = "be9fd26".padEnd(40, "0");
  const refusal = {
    project: "lingtai",
    detail: 'env: Unrecognized key: "refuseHosts"',
    ref: "main",
    codeSha: OLD,
    seq: 4242n,
    at: new Date("2026-09-12T10:00:00.000Z"),
  };

  it("fails while a daemon is up, and says this checkout's recipe rows read with newer code", () => {
    const read = describeRefusal("lingtai", refusal, { daemonUp: true, here: NEW });
    expect(read.status).toBe("fail");
    expect(read.detail).toContain("seq 4242");
    expect(read.detail).toContain("cc6e856");
    expect(read.detail).toContain("reading main");
    expect(read.detail).toContain("refuseHosts");
    expect(read.detail).toContain("This checkout is at be9fd26");
    expect(read.detail).toContain("too old");
  });

  it("says the rows read with the refusing code when the commits agree", () => {
    const read = describeRefusal("lingtai", refusal, { daemonUp: true, here: OLD });
    expect(read.status).toBe("fail");
    expect(read.detail).toContain("read with the code that refused");
    expect(read.detail).not.toContain("too old");
  });

  it("warns, rather than fails, when no daemon is up", () => {
    const read = describeRefusal("lingtai", { ...refusal, codeSha: null, ref: null }, { daemonUp: false, here: NEW });
    expect(read.status).toBe("warn");
    expect(read.detail).toContain("an unrecorded commit");
    expect(read.detail).toContain("a branch it never reached");
    expect(read.detail).toContain("No daemon is up");
  });
});

describe("lingtai doctor — against the real database", () => {
  /**
   * Phase 0's exit criterion, as an assertion: *`lingtai doctor` is green*.
   *
   * "Green" means nothing failed. The six deferred checks are skips, and they
   * stay visible in the output.
   */
  it("is green", async () => {
    const report = await runDoctor(
      env({ LINGTAI_DATABASE_URL: postgresUrl(), LINGTAI_DIRECT_DATABASE_URL: directPostgresUrl() }),
    );

    const failures = report.results.filter((r) => r.status === "fail");
    expect(failures.map((f) => `${f.name}: ${f.detail}`)).toEqual([]);

    // And the checks that carry the weight actually ran, rather than being
    // skipped into a green that means nothing.
    expect(find(report.results, "postgres: direct connection is session mode").status).toBe("ok");
    expect(find(report.results, "schema: optimistic concurrency").status).toBe("ok");
    expect(find(report.results, "schema: append-only").status).toBe("ok");
    expect(find(report.results, "schema: notify trigger").status).toBe("ok");

    // Lag is not the instrument for a shape that has drifted — it read zero
    // right up to the append that needed the column #84 added (#90). Both
    // checks are listed, so neither can stand in for the other.
    expect(find(report.results, "projections: lag").status).toBe("ok");
    expect(find(report.results, "projections: shape").status).toBe("ok");

    // Up and current are two facts, and folding them into one is the whole of
    // #98: a daemon beat happily for thirty-nine minutes while holding code
    // that could not produce the event the log had been fixed to record, and
    // `up, last beat 2s ago` was the only thing anything said about it. Both
    // are listed here so neither can be quietly absorbed into the other.
    expect(find(report.results, "daemon: liveness").detail.length).toBeGreaterThan(0);
    expect(find(report.results, "daemon: currency").detail.length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * `#144`, as the row somebody reads in the one window they are most likely to
   * read it: just after starting a daemon.
   *
   * The beacon carries two fields and this check used to read one of them. A
   * `starting` row twenty-one seconds old was reported as `not running` while
   * the conductor lock on the next line named the very process that had written
   * it — and that row is the restart gate `#98` exists to make somebody read.
   *
   * What the beacon does about it is in `packages/daemon/test/beacon.test.ts`,
   * which drives a startup slower than `STALE_AFTER_MS` and shows the row
   * staying fresh. This end asserts the sentence: a beacon that says `starting`
   * reads as starting, and never as a daemon to restart.
   */
  it("does not call a daemon that is still starting `not running`", async () => {
    await createStatusTable();
    // What startup now writes before it begins the slow half — a fresh row
    // whose word is `starting`.
    await beat("starting");

    try {
      const report = await runDoctor(
        env({ LINGTAI_DATABASE_URL: postgresUrl(), LINGTAI_DIRECT_DATABASE_URL: directPostgresUrl() }),
      );
      const liveness = find(report.results, "daemon: liveness");

      expect(liveness.detail).toContain("starting");
      expect(liveness.detail).not.toContain("not running");
      // And the row says what it is doing, so `starting` is not read as an
      // invitation to start a second one — which `#93` would turn away anyway.
      expect(liveness.detail).toContain("takes no work");
    } finally {
      // One row for the whole installation: left behind, it tells every later
      // test in the suite that a daemon is up.
      const client = new pg.Client({ connectionString: directPostgresUrl() });
      await client.connect();
      await client.query("delete from daemon_status where id = 1").catch(() => {});
      await client.end();
    }
  }, 60_000);

  /**
   * The other half of `#120`: appending `PluginFailed` is only worth doing if
   * something reads it back. A subscriber failure used to be a console line,
   * and a console line is gone by morning — so a notifier that had silently
   * stopped notifying looked exactly like a quiet week.
   *
   * Against the real log, with real appends, because the check is a query and a
   * query is not tested by a fake.
   */
  it("names a subscriber that has been failing", async () => {
    const client = createDb();
    const store = createEventStore(client);
    const at = (await store.read(SUBSCRIBER_STREAM)).length;
    await store.append(SUBSCRIBER_STREAM, at, [
      {
        type: "PluginFailed",
        actor: "conductor",
        data: {
          name: "notify",
          eventType: "WorkItemLanded",
          project: "esctest-doctor",
          reason: "terminal-notifier exited 127",
        },
      },
    ]);
    await client.close();

    try {
      const report = await runDoctor(
        env({ LINGTAI_DATABASE_URL: postgresUrl(), LINGTAI_DIRECT_DATABASE_URL: directPostgresUrl() }),
      );
      const check = find(report.results, "subscribers: failures");

      // `warn` and never `fail`: nothing converges a subscriber failure — a
      // subscriber is never retried — so a red doctor here would be red for
      // ever, and a check that is always red is a check nobody reads.
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("notify");
      expect(check.detail).toContain("terminal-notifier exited 127");
    } finally {
      const c = new pg.Client({ connectionString: directPostgresUrl() });
      await c.connect();
      try {
        await c.query("alter table events disable rule lingtai_events_no_delete");
        await c.query("delete from events where stream_id = $1", [SUBSCRIBER_STREAM]);
      } finally {
        await c.query("alter table events enable rule lingtai_events_no_delete");
        await c.end();
      }
    }
  }, 60_000);
});

describe("daemon: liveness, given the read to report", () => {
  it("lets a beacon read that failed fail, rather than calling it no daemon having run", async () => {
    // What `lingtai service status` passes: the read it reports is the read
    // that failed, not a second one on another connection that might.
    await expect(
      daemonLiveness(async () => {
        throw new Error("sorry, too many clients already");
      }),
    ).rejects.toThrow("sorry, too many clients already");
  });
});
