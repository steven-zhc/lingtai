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
 *
 * **It scans every package, not this one.** The first version read
 * `packages/env/src/index.ts` alone, which is what `#63`'s checklist asked for
 * — and the rule it was written to enforce is wider than that, so it missed
 * three: the compiled hook read `ESC_HOOK_SOCKET`, `ESC_RUN_ID` and
 * `ESC_HOOK_TIMEOUT_MS`, and `agent`'s wiring set them. A check that is present,
 * reported, and not looking at the thing you think it is — the `#58` shape, in
 * the file written to prevent it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PREFIX, dbVar, githubApp, hasGitHubApp } from "../src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");

/**
 * Names read from the environment that are **not Lingtai's own**, and why.
 *
 * Each one is somebody else's variable that this package consults rather than
 * owns, so prefixing it would be wrong rather than tidy.
 */
const NOT_OURS: Record<string, string> = {
  HOME: "the operating system's, read to find where a home directory is",
  HOSTNAME: "the operating system's, read to say which machine a daemon is on",
  USER: "the operating system's, read to attribute an approval to a person",
  VITEST: "set by the test runner, not by Lingtai",
};

/** Every `src` directory in the workspace. Tests and fixtures are not scanned:
 *  a test may legitimately name a *project's* variable, which is not ours. */
function sourceFiles(): string[] {
  const out: string[] = [];
  for (const area of ["packages", "apps"]) {
    for (const pkg of readdirSync(join(ROOT, area), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(ROOT, area, pkg.name, "src");
      const walk = (dir: string): void => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
        }
      };
      walk(src);
    }
  }
  return out;
}

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
  it("covers every name any package reads for itself", () => {
    const files = sourceFiles();
    // The scan has to find files, or it is asserting nothing.
    expect(files.length).toBeGreaterThan(20);

    const offenders: string[] = [];
    let seen = 0;
    for (const file of files) {
      for (const name of namesRead(readFileSync(file, "utf8"))) {
        seen += 1;
        if (name.startsWith(PREFIX) || name in NOT_OURS) continue;
        offenders.push(`${name} in ${file.slice(ROOT.length + 1)}`);
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(offenders, `not prefixed, and not listed as somebody else's:\n  ${offenders.join("\n  ")}`)
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
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const declared = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((n) => !n.startsWith(PREFIX))).toEqual([]);
  });
});
