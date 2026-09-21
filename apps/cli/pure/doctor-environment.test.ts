/**
 * The environment `lingtai doctor` reports on (#213).
 *
 * It was built by catching the two getters — `try { databaseUrl() } catch {
 * delete env["DATABASE_URL"] }` — which is the same *does it throw* standing in
 * for *is one configured* that `entry.ts` had three of. The values are read
 * now. **Every case here is what the catching version did**, since a Postgres
 * install has to behave identically across this change; `postgresUrlIfSet` and
 * `directUrlIfSet` are the same two reads with the refusal left off.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLITE_NOT_OPEN_YET, directPostgresUrl, postgresUrl, storeChoice } from "@lingtai/env";
import { doctorEnvironment, storeRow } from "../src/doctor.ts";

const POOLED = "postgresql://u:p@db.example.com:6543/postgres?pgbouncer=true";
const DIRECT = "postgresql://u:p@db.example.com:5432/postgres";

describe("the environment doctor reports on", () => {
  it("carries both names, and the same strings the getters would have refused to withhold", () => {
    const env = doctorEnvironment({ LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT });
    expect(env["DATABASE_URL"]).toBe(POOLED);
    expect(env["DIRECT_DATABASE_URL"]).toBe(DIRECT);
    expect(env["DATABASE_URL"]).toBe(postgresUrl({ LINGTAI_DATABASE_URL: POOLED }));
    expect(env["DIRECT_DATABASE_URL"]).toBe(
      directPostgresUrl({ LINGTAI_DATABASE_URL: POOLED, LINGTAI_DIRECT_DATABASE_URL: DIRECT }),
    );
    // The prefixed names are untouched: `runDoctor` reads those, and its rows
    // about pooling are what they were.
    expect(env["LINGTAI_DATABASE_URL"]).toBe(POOLED);
    expect(env["LINGTAI_DIRECT_DATABASE_URL"]).toBe(DIRECT);
  });

  it("lets the pooled URL stand in for an absent direct one (#176), as the getter does", () => {
    const env = doctorEnvironment({ LINGTAI_DATABASE_URL: POOLED });
    expect(env["DATABASE_URL"]).toBe(POOLED);
    expect(env["DIRECT_DATABASE_URL"]).toBe(POOLED);
  });

  it("carries neither where nothing is configured, and does not refuse", () => {
    expect(() => doctorEnvironment({})).not.toThrow();
    const env = doctorEnvironment({});
    expect("DATABASE_URL" in env).toBe(false);
    expect("DIRECT_DATABASE_URL" in env).toBe(false);
  });

  /**
   * The operator's own `DATABASE_URL` is some application's, never Lingtai's
   * (#63) — so where Lingtai has no log of its own the name is removed rather
   * than left to be read as one. That is what the `catch` did, and this is the
   * case that would have been silently lost by reading the value instead.
   */
  it("removes an unprefixed URL of somebody else's where Lingtai has no log", () => {
    const env = doctorEnvironment({ DATABASE_URL: DIRECT, DIRECT_DATABASE_URL: DIRECT, PATH: "/usr/bin" });
    expect("DATABASE_URL" in env).toBe(false);
    expect("DIRECT_DATABASE_URL" in env).toBe(false);
    // And it is a copy: everything else is passed through untouched.
    expect(env["PATH"]).toBe("/usr/bin");
  });

  it("reads the test side for a test run, so the suite never reports on the operator's log", () => {
    const env = doctorEnvironment({ LINGTAI_TEST: "1", LINGTAI_TEST_DATABASE_URL: DIRECT, LINGTAI_DATABASE_URL: POOLED });
    expect(env["DATABASE_URL"]).toBe(DIRECT);
  });
});

/**
 * The row that says what this machine chose (#215, 0056 §3) — the same
 * `storeChoice()` `lingtai init` confirms with, so *what was set up* and *what
 * doctor reports* are one answer.
 */
describe("the store row", () => {
  function home(config?: string): string {
    const dir = mkdtempSync(join(tmpdir(), "lingtai-doctor-store-"));
    if (config !== undefined) writeFileSync(join(dir, "config.yml"), config);
    return dir;
  }

  it("names the exported variable where that is what decided", () => {
    const row = storeRow(storeChoice({ LINGTAI_HOME: home(), LINGTAI_DATABASE_URL: DIRECT }));
    expect(row.status).toBe("ok");
    expect(row.detail).toContain("postgres");
    expect(row.detail).toContain("exported into this process");
    // No row here prints a connection string, and this one is no exception.
    expect(row.detail).not.toContain(DIRECT);
  });

  it("names the file where the file decided", () => {
    const dir = home(`database:\n  store: postgres\n  url: ${DIRECT}\n`);
    const row = storeRow(storeChoice({ LINGTAI_HOME: dir }));
    expect(row.status).toBe("ok");
    expect(row.detail).toContain(join(dir, "config.yml"));
    expect(row.detail).not.toContain(DIRECT);
  });

  /**
   * A note and not a failure: nothing opens a store from this value yet, so a
   * machine with no `database.store` has something to do rather than something
   * broken — and `lingtai restart`, which gates on failures, is kept out of it.
   */
  it("is a note on a machine that has not recorded a choice, naming lingtai init", () => {
    const row = storeRow(storeChoice({ LINGTAI_HOME: home() }));
    expect(row.status).toBe("warn");
    expect(row.detail).toContain("lingtai init");
  });

  it("says the one sentence about SQLite, and says it from the one place", () => {
    const row = storeRow(storeChoice({ LINGTAI_HOME: home("database:\n  store: sqlite\n") }));
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(SQLITE_NOT_OPEN_YET);
  });
});
