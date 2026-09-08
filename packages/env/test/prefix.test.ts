/**
 * Every name Lingtai reads for itself begins `LINGTAI_`.
 *
 * The instrument, not the rule. `#63` prefixed the names; **this is what keeps
 * it true when somebody adds the next variable**, which is the half that
 * usually rots. A rule with exceptions is not checkable, so `TEST_` goes after
 * the prefix (`LINGTAI_TEST_DATABASE_URL`) and there are none.
 *
 * It reads the source rather than the behaviour, because the failure it guards
 * against is a *new* read — one no existing test would exercise.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PREFIX, dbVar, githubApp, hasGitHubApp } from "../src/index.ts";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts");

/**
 * Names read from the environment that are **not Lingtai's own**, and why.
 *
 * Each one is somebody else's variable that this package consults rather than
 * owns, so prefixing it would be wrong rather than tidy.
 */
const NOT_OURS: Record<string, string> = {
  HOME: "the operating system's, read to find where a home directory is",
  VITEST: "set by the test runner, not by Lingtai",
};

/** `process.env["X"]`, `from["X"]`, `optional("X"`, `required("X"`. */
function namesRead(source: string): string[] {
  const found = new Set<string>();
  for (const m of source.matchAll(/(?:process\.env|from)\["([A-Z][A-Z0-9_]*)"\]/g)) {
    found.add(m[1]!);
  }
  for (const m of source.matchAll(/\b(?:optional|required)\(\s*"([A-Z][A-Z0-9_]*)"/g)) {
    found.add(m[1]!);
  }
  return [...found].sort();
}

describe("the LINGTAI_ prefix", () => {
  it("covers every name this package reads for itself", () => {
    const read = namesRead(readFileSync(SOURCE, "utf8"));
    // The scan has to find something, or it is asserting nothing.
    expect(read.length).toBeGreaterThan(0);

    const unprefixed = read.filter((n) => !n.startsWith(PREFIX) && !(n in NOT_OURS));
    expect(unprefixed, `not prefixed, and not listed as somebody else's: ${unprefixed.join(", ")}`)
      .toEqual([]);
  });

  /**
   * `TEST_` after the prefix, not before it.
   *
   * `TEST_LINGTAI_DATABASE_URL` would satisfy "contains LINGTAI_" and break the
   * rule this file checks, so the placement is asserted rather than assumed.
   */
  it("puts TEST_ inside the prefix", () => {
    const was = process.env["LINGTAI_TEST"];
    try {
      process.env["LINGTAI_TEST"] = "1";
      expect(dbVar("DATABASE_URL")).toBe("LINGTAI_TEST_DATABASE_URL");
      expect(dbVar("DIRECT_DATABASE_URL")).toBe("LINGTAI_TEST_DIRECT_DATABASE_URL");
    } finally {
      if (was === undefined) delete process.env["LINGTAI_TEST"];
      else process.env["LINGTAI_TEST"] = was;
    }
  });

  /**
   * The old name, set, with the new one absent.
   *
   * The message has to name the **new** one, because "LINGTAI_GITHUB_APP_ID is
   * not set" on a machine where `GITHUB_APP_ID` is plainly set reads as a bug
   * in Lingtai rather than as a rename. Only consulted on the path that was
   * going to fail anyway, so an operator with a `DATABASE_URL` of their own for
   * something else is never bothered — `hasGitHubApp` still says no, quietly.
   *
   * Delete this with `renamedFrom`, once no machine predates `#63`.
   */
  it("says a name was renamed rather than that it is missing", () => {
    const old = { GITHUB_APP_ID: "123", GITHUB_APP_PRIVATE_KEY: "-----BEGIN-----" };
    expect(hasGitHubApp(old)).toBe(false);
    expect(() => githubApp(old)).toThrow(/LINGTAI_GITHUB_APP_ID is not set/);
    expect(() => githubApp(old)).toThrow(/renamed/);
  });

  /** Every name in the example file is one this package would accept. */
  it("matches .env.example", () => {
    const example = readFileSync(join(dirname(SOURCE), "../../../.env.example"), "utf8");
    const declared = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((n) => !n.startsWith(PREFIX))).toEqual([]);
  });
});
