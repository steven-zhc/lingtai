/**
 * **The rows `lingtai doctor` asks of a log rather than of a Postgres** (#214).
 *
 * This file is the ticket's first box, and it is in the half of the suite that
 * needs no database *because that is the assertion*: the machine under test has
 * no Postgres, the log is a real SQLite file in a temporary directory, and the
 * two rows come back `ok` rather than `skip`. Under `vitest.config.ts` a
 * `globalSetup` opens the test database before anything runs, so a test there
 * could never have shown this.
 *
 * What it replaces: on such a machine every one of doctor's fifteen Postgres
 * rows was a `skip`, the summary counted skips as *not failed*, and the line at
 * the bottom read `0 failed` — for a machine whose log the command had never
 * opened. [0016](../../../doc/decisions/0016-the-settled-model.md) §4's thing
 * you cannot tell apart from its absence, in the one command built to prevent
 * it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StoreChoice } from "@lingtai/env";
import type { Log } from "@lingtai/event-store";
// Named here and nowhere in `src`: `packages/env/test/one-choice.test.ts` scans
// each package's sources for exactly this, and a test that builds the store it
// is about is not a second decision about which store a machine runs.
import { createSqliteLog, openSqliteLog } from "@lingtai/event-store/sqlite";
import {
  LOG_REACHABLE,
  LOG_WAKES,
  type CheckResult,
  formatReport,
  logReachable,
  logWakes,
  reachabilityChecked,
  tally,
} from "../src/doctor.ts";

describe("a machine whose log is a file, and has no Postgres at all", () => {
  let dir: string;
  let path: string;
  let db: ReturnType<typeof openSqliteLog>;
  let log: Log;
  let choice: StoreChoice;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lingtai-doctor-log-"));
    path = join(dir, "lingtai.db");
    db = openSqliteLog(path);
    log = createSqliteLog({ db, path, intervalMs: 10 });
    choice = { store: "sqlite", path, where: "config.yml", from: join(dir, "config.yml") };
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("says the log is reachable, and which store it reached", async () => {
    const row = await logReachable(choice, async () => log);

    expect(row.name).toBe(LOG_REACHABLE);
    expect(row.status).toBe("ok");
    // The row above it has just said this machine chose SQLite; this one says
    // it reached *that* log and not something else it found lying around.
    expect(row.detail).toContain("sqlite");
    expect(row.detail).toContain(path);
    expect(row.detail).toContain("opened and read");
  });

  it("says a change would reach a second reader, by the poll a file wakes with", async () => {
    const row = await logWakes(choice, async () => log);

    expect(row.name).toBe(LOG_WAKES);
    expect(row.status).toBe("ok");
    expect(row.detail).toContain("poll");
    // Not LISTEN/NOTIFY, which is the other store's answer to the same
    // question — and was the only one anything asked (#178, #221).
    expect(row.detail).not.toContain("LISTEN");
  });

  /**
   * A log that will not open is the one failure every green row after it would
   * be green *about*. It fails, and the detail says what stops working —
   * not the exception alone, which sends a reader to the driver's issue tracker.
   */
  it("fails, rather than skipping, when the log will not open", async () => {
    const row = await logReachable(choice, async () => {
      throw new Error("unable to open database file");
    });

    expect(row.status).toBe("fail");
    expect(row.detail).toContain("unable to open database file");
    expect(row.detail).toContain("appends, folds or reads");
  });

  it("fails when nothing can be woken, and says what goes stale", async () => {
    const row = await logWakes(choice, async () => ({
      ...log,
      waker: () => ({
        open: () => ({ ready: Promise.reject(new Error("the file went away")), close: () => {} }),
      }),
    }));

    expect(row.status).toBe("fail");
    expect(row.detail).toContain("the file went away");
    expect(row.detail).toContain("sweep");
  });

  /**
   * `ready` "may never settle when nothing answers" (`WakeSession`), which is
   * precisely the state worth reporting — so it is raced, and a doctor that
   * hung would be worse than one that said nothing.
   */
  it("gives up on a waker that never becomes ready, rather than hanging", async () => {
    const row = await logWakes(
      choice,
      async () => ({
        ...log,
        waker: () => ({ open: () => ({ ready: new Promise<void>(() => {}), close: () => {} }) }),
      }),
      50,
    );

    expect(row.status).toBe("fail");
    expect(row.detail).toContain("50ms");
  });
});

/**
 * **A machine that has written no store is told so by every row that needed
 * one** — and never by a bare `skip`, which is the shape a reader takes for a
 * pass.
 */
describe("a machine that has written no store", () => {
  const refused: StoreChoice = { refused: "no database.store in ~/.lingtai/config.yml", because: "nothing chosen" };

  it("skips the log rows with the reason, and points at the row that failed", async () => {
    for (const row of [await logReachable(refused), await logWakes(refused)]) {
      expect(row.status).toBe("skip");
      expect(row.detail).toContain("no database.store");
      expect(row.detail).toContain("store row above");
      // Not a shrug.
      expect(row.detail.length).toBeGreaterThan(40);
    }
  });

  it("never opens anything to find that out", async () => {
    const boom = async (): Promise<Log> => {
      throw new Error("a store was opened for a machine that has chosen none");
    };
    await expect(logReachable(refused, boom)).resolves.toMatchObject({ status: "skip" });
    await expect(logWakes(refused, boom)).resolves.toMatchObject({ status: "skip" });
  });
});

/**
 * The summary line, which is where `0 failed` was printed for a machine nobody
 * had checked.
 */
describe("the summary line", () => {
  const report = (results: CheckResult[]) => ({ results, ...tally(results) });
  const green: CheckResult = { name: "packages load under Node", status: "ok", detail: "loaded" };
  const deferred: CheckResult = {
    name: "hook: fail closed",
    status: "skip",
    detail: "every run proves it immediately before dispatching",
    deferred: true,
  };

  it("counts *not implemented yet* apart from *not checked here*", () => {
    const counts = tally([
      green,
      deferred,
      { name: "postgres", status: "skip", detail: "not attempted — this machine wrote store: sqlite" },
    ]);

    expect(counts.skipped).toBe(2);
    expect(counts.deferred).toBe(1);
    expect(counts.notChecked).toBe(1);
  });

  it("prints 0 failed where the log was reached", () => {
    const line = formatReport(
      report([green, deferred, { name: LOG_REACHABLE, status: "ok", detail: "sqlite — opened and read" }]),
    );

    expect(line).toContain("0 failed");
    expect(line).toContain("1 not implemented yet");
  });

  /**
   * The finding, as one assertion. Every Postgres row skipped, nothing failed,
   * and the bottom line used to read `0 failed`.
   */
  it("refuses to print 0 failed where the log's own reachability was never checked", () => {
    const line = formatReport(
      report([
        green,
        deferred,
        { name: "postgres", status: "skip", detail: "not attempted — the environment check failed first" },
        { name: LOG_REACHABLE, status: "skip", detail: "not checked — this machine has written no store" },
      ]),
    );

    expect(line).not.toContain("0 failed");
    expect(line).toContain(LOG_REACHABLE);
    expect(line).toContain("2 not checked here");
  });

  it("says nothing green for a report with no reachability row at all", () => {
    expect(reachabilityChecked([green])).toBe(false);
    expect(formatReport(report([green]))).not.toContain("0 failed");
  });

  /** A failure is still the loudest thing on the line, whatever the skips say. */
  it("leads with the failures when there are any", () => {
    const line = formatReport(
      report([green, { name: LOG_REACHABLE, status: "fail", detail: "unable to open database file" }]),
    );

    expect(line).toContain("1 check(s) FAILED");
    expect(reachabilityChecked(report([{ name: LOG_REACHABLE, status: "fail", detail: "x" }]).results)).toBe(true);
  });
});
