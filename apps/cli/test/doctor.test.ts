/**
 * Most of these need no database: a doctor whose environment check fails must
 * not go on to open connections, so the failure paths are pure.
 *
 * The last one does need it, and it is the one that matters — it is Phase 0's
 * exit criterion written as an assertion.
 */
import { createDb, createEventStore, databaseUrl, directDatabaseUrl } from "@lingtai/event-store";
import { beat, createStatusTable } from "@lingtai/daemon";
import { SUBSCRIBER_STREAM } from "@lingtai/domain";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { RECIPE_PATH, resolveRecipe } from "@lingtai/recipe";
import { CLAUDE_CODE_CAPABILITIES } from "@lingtai/agent";
import {
  daemonLiveness,
  declaredExtensions,
  describeRefusal,
  extensionRow,
  formatReport,
  limitsRow,
  runDoctor,
} from "../src/doctor.ts";

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

  /**
   * #179. An unset `LINGTAI_DATABASE_URL` used to mean a machine nobody had
   * configured and now means a machine that chose SQLite — and nothing outside
   * can tell those apart, which is why the report says which store it found
   * rather than leaving it to be inferred from a variable nobody set.
   */
  it("says which store is in use, and where, before it checks anything", async () => {
    const report = await runDoctor(env({}));
    const store = find(report.results, "store");

    expect(report.results.indexOf(store)).toBeLessThan(
      report.results.indexOf(find(report.results, "environment")),
    );
    expect(store.detail).toContain("sqlite");
    expect(store.detail).toContain("lingtai.db");
    expect(find(report.results, "environment").status).toBe("skip");
    expect(find(report.results, "postgres").detail).toContain("the log is SQLite");
  });

  /**
   * The row is red, and that is the point of it. SQLite is the store 1.0 wants,
   * and it is not yet a store any command that appends can use: the projections
   * and the `LISTEN`/`NOTIFY` waker take a Postgres URL and refuse by name, so
   * `lingtai add`, `approve`, `run` and the board all die on a machine this
   * report could have called green — and `lingtai restart` gates on this same
   * report, where a note is explicitly not a failure (`restart.ts`'s
   * `doctorFailed`), so a note would drain a daemon and start one that cannot
   * open a log. When #175 ports them this becomes `ok`.
   */
  it("fails on a SQLite machine, because no command that appends can run on one yet", async () => {
    const report = await runDoctor(env({}));
    const store = find(report.results, "store");

    expect(store.status).toBe("fail");
    expect(report.failed).toBeGreaterThan(0);
    expect(formatReport(report)).toContain("FAILED");
    // Not a bare verdict: what is missing, and both ways out of it.
    expect(store.detail).toContain("#175");
    expect(store.detail).toContain("Name a Postgres URL");
    // And the checks below say they were not run, not that they do not exist.
    expect(find(report.results, "postgres").detail).toContain("Implemented, and not run");
  });

  it("says postgres, and where it was named, when a URL is set", async () => {
    const report = await runDoctor(env({ LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT }));
    const store = find(report.results, "store");

    expect(store.detail).toContain("postgres · LINGTAI_DATABASE_URL :6543");
    // The same rule as every other row: never the credentials, never the host.
    expect(store.detail).not.toContain("u:p");
    expect(store.detail).not.toContain("db.example.com");
  });

  it("does not choose SQLite for a machine that named only the direct URL, and fails rather than calling it a store", async () => {
    // A missing line, not a decision. Choosing SQLite there would start an
    // empty log beside a database somebody plainly configured — and `storeChoice`
    // opens nothing at all there, so the row that says which store is in use
    // cannot be the green one on the machine where there is none. The report is
    // read by scanning the left edge for FAIL; a green row with the bad news in
    // its detail is a row that gets passed over.
    const report = await runDoctor(env({ LINGTAI_DIRECT_DATABASE_URL: DIRECT }));
    const store = find(report.results, "store");

    expect(store.detail).not.toContain("sqlite");
    expect(store.status).toBe("fail");
    expect(store.detail).toContain("LINGTAI_DATABASE_URL");
    expect(find(report.results, "environment").status).toBe("fail");
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

  it("reads ~/.lingtai/config.yml's database.url when neither variable is set, as databaseUrl does (#186)", async () => {
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
    // Wrong, not absent: absent is SQLite (#179), and a pooled URL missing from
    // a machine that named the direct one is the failure this skips after.
    const report = await runDoctor(env({ LINGTAI_DIRECT_DATABASE_URL: DIRECT }));
    expect(find(report.results, "postgres").status).toBe("skip");
    expect(find(report.results, "postgres").detail).toContain("the environment check failed first");
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
    // A failure has to be arranged now that an empty environment is not one:
    // absence chooses SQLite (#179), and a machine that named only the direct
    // URL is the nearest thing to a misconfiguration this can make offline.
    const report = await runDoctor(env({ LINGTAI_DIRECT_DATABASE_URL: DIRECT }));
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
      env({ LINGTAI_DATABASE_URL: databaseUrl(), LINGTAI_DIRECT_DATABASE_URL: directDatabaseUrl() }),
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
        env({ LINGTAI_DATABASE_URL: databaseUrl(), LINGTAI_DIRECT_DATABASE_URL: directDatabaseUrl() }),
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
      const client = new pg.Client({ connectionString: directDatabaseUrl() });
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
        env({ LINGTAI_DATABASE_URL: databaseUrl(), LINGTAI_DIRECT_DATABASE_URL: directDatabaseUrl() }),
      );
      const check = find(report.results, "subscribers: failures");

      // `warn` and never `fail`: nothing converges a subscriber failure — a
      // subscriber is never retried — so a red doctor here would be red for
      // ever, and a check that is always red is a check nobody reads.
      expect(check.status).toBe("warn");
      expect(check.detail).toContain("notify");
      expect(check.detail).toContain("terminal-notifier exited 127");
    } finally {
      const c = new pg.Client({ connectionString: directDatabaseUrl() });
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
