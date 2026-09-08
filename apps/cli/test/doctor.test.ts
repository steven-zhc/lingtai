/**
 * Most of these need no database: a doctor whose environment check fails must
 * not go on to open connections, so the failure paths are pure.
 *
 * The last one does need it, and it is the one that matters — it is Phase 0's
 * exit criterion written as an assertion.
 */
import { databaseUrl, directDatabaseUrl } from "@lingtai/event-store";
import { describe, expect, it } from "vitest";
import { formatReport, runDoctor } from "../src/doctor.ts";

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
    const report = await runDoctor(env({ LINGTAI_DATABASE_URL: POOLED }));
    const e = find(report.results, "environment");

    expect(e.status).toBe("fail");
    expect(e.detail).toContain("LINGTAI_DIRECT_DATABASE_URL");
    expect(report.failed).toBeGreaterThan(0);
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

describe("lingtai doctor — the limits a recipe declares", () => {
  /**
   * `runtime.limits.turns` was in the schema, threaded to the runtime and
   * enforced by nothing: a run reached 172 turns against a declared 150 and
   * cost $26.53, and the recipe, `lingtai add`, `RunStarted` and the card all
   * reported the limit as being in force (#89). Nothing compared the two halves
   * — which is the same gap `gates: every point that was planned ran` exists to
   * close one layer up.
   *
   * Asserted as green rather than merely present: the whole value of this check
   * is that it goes red the day the schema accepts a limit no adapter applies,
   * and a test that only looked for the row would pass in exactly that case.
   */
  it("compares what a recipe may declare against what the runtime applies", async () => {
    const report = await runDoctor(env({}));
    const check = find(
      report.results,
      "runtime: every limit a recipe can declare is one the runtime applies",
    );

    expect(check.status).toBe("ok");
    expect(check.detail).toContain("turns");
    expect(check.detail).toContain("wall");
  });
});

describe("lingtai doctor — the declared environment", () => {
  /**
   * The half of [ADR 0020](../../../doc/decisions/0020-the-agent-environment-in-layers.md)
   * that costs nothing: the same question a run asks, answered before any money
   * is spent. Without an App there is no recipe to read, so it is a skip with a
   * reason rather than an omission — and the reason is about *this* run, not a
   * literal about the machine, which is why it is not in `DEFERRED`.
   */
  it("is listed, and says why when it cannot read a recipe", async () => {
    const report = await runDoctor(env({}));
    const check = find(report.results, "env: declared names, and which layer");

    expect(check.status).toBe("skip");
    expect(check.detail).toContain("recipe");
    // Not deferred: it runs whenever a project and an App exist.
    expect(check.deferred).toBeUndefined();
  });
});

describe("lingtai doctor — the recipes", () => {
  /**
   * This check was in `DEFERRED` — a permanent skip, on the argument that a
   * recipe read here would be a different commit's. Both read `origin/<base>`
   * through the API, and the question is only whether the file that governs the
   * next run parses at all: it did not, on `main`, for long enough that every
   * issue in the project sat unpicked with doctor green throughout (#76).
   */
  it("runs, rather than being deferred forever", async () => {
    const report = await runDoctor(env({}));
    const check = find(report.results, "recipe: resolves for every project");

    // Without an App there is nothing to read a recipe through, so it is a skip
    // about *this* run — not a literal about the installation, which is the
    // distinction `deferred` marks.
    expect(check.status).toBe("skip");
    expect(check.deferred).toBeUndefined();
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
  }, 60_000);
});
