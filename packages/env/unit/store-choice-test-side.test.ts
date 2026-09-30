/**
 * The test side of `storeChoice`, since #275: a run with no
 * `LINGTAI_TEST_DATABASE_URL` answers SQLite where
 * `LINGTAI_TEST_SQLITE_PATH` names one, and still refuses where neither is
 * set — rather than falling back to the operator's `config.yml`, which a test
 * environment must never reach (0046 §4, 0074).
 *
 * Pure: every case hands `storeChoice` an object literal, so this needs no
 * database and no filesystem, unlike `packages/env/integration/store.test.ts`'s
 * probes into a real child process and a real `config.yml`.
 */
import { describe, expect, it } from "vitest";
import { describeStore, storeChoice } from "../src/index.ts";

describe("a test run with no LINGTAI_TEST_DATABASE_URL", () => {
  it("is SQLite where LINGTAI_TEST_SQLITE_PATH names a file", () => {
    const path = "/tmp/lingtai-test-abc123/lingtai.db";
    const choice = storeChoice({ LINGTAI_TEST: "1", LINGTAI_TEST_SQLITE_PATH: path });
    expect(choice).toEqual({
      store: "sqlite",
      path,
      where: "environment",
      from: "LINGTAI_TEST_SQLITE_PATH, exported into this process",
    });
  });

  it("is refused, naming both variables, where neither is set", () => {
    const choice = storeChoice({ LINGTAI_TEST: "1" });
    expect(choice).toMatchObject({ because: "nothing chosen" });
    const said = describeStore(choice);
    expect(said).toContain("LINGTAI_TEST_DATABASE_URL");
    expect(said).toContain("LINGTAI_TEST_SQLITE_PATH");
  });

  it("still picks up a set LINGTAI_TEST_DATABASE_URL first", () => {
    const url = "postgresql://me:secret@db.example:5432/lingtai";
    const choice = storeChoice({
      LINGTAI_TEST: "1",
      LINGTAI_TEST_DATABASE_URL: url,
      LINGTAI_TEST_SQLITE_PATH: "/tmp/unused/lingtai.db",
    });
    expect(choice).toMatchObject({ store: "postgres", url });
  });
});
