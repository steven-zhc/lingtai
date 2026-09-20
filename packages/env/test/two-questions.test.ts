/**
 * *Is a log configured* is never answered by catching *what is the Postgres URL*
 * (#213).
 *
 * The three instances in `apps/cli/src/entry.ts` were each one line, each
 * correct while every log was Postgres, and each invisible to `tsc` — the
 * answer was a thrown error and a `catch`. #179 spent five passes and about
 * $100 on them: its reviewer named the conflation in round one and was still
 * finding fresh instances in round four, because nothing enumerated what
 * *done* was. This does.
 *
 * So the source is read, the way `board-port.test.ts` reads it for a port that
 * nothing may bind. A `try` around `postgresUrl()` is not always wrong — it is
 * wrong when what the `catch` produces is an answer about *configuration*, and
 * the cheapest rule that catches every instance this repository has had is: do
 * not wrap the getter in a `try` at all. `logConfigured()` is a boolean.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { logConfigured, postgresUrl, postgresUrlIfSet, repoRoot } from "../src/index.ts";

/**
 * Every `.ts` under each workspace package's `src`. Tests are not scanned: a
 * test that asserts `postgresUrl` refuses has to call it inside a `try`, and
 * this file is one of them.
 */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
    }
  };
  for (const workspace of ["apps", "packages"]) {
    let packages;
    try {
      packages = readdirSync(join(repoRoot(), workspace), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const pkg of packages) if (pkg.isDirectory()) walk(join(repoRoot(), workspace, pkg.name, "src"));
  }
  return out;
}

/**
 * A `try` whose body calls a getter and whose failure is caught.
 *
 * `[^{}]` and not `.`: the body has to be the straight-line kind — which every
 * instance was, `try { databaseUrl(); } catch { return null; }` — so a
 * connection opened inside a `try` that happens to build an object is not
 * named. This is a scan for the shape that hid the question, not for every
 * exception anybody handles.
 */
const CAUGHT = /\btry\s*\{[^{}]*\b(?:postgresUrl|directPostgresUrl)\s*\([^{}]*\}\s*catch\b/;

function catching(text: string): boolean {
  return CAUGHT.test(text);
}

describe("the two questions", () => {
  it("are two, and the boolean one does not throw where the other does", () => {
    expect(() => postgresUrl({})).toThrow();
    expect(logConfigured({})).toBe(false);
    expect(postgresUrlIfSet({})).toBeUndefined();
  });

  it("is a scan that sees the shape it exists for", () => {
    // Verbatim from `entry.ts` before this landed, with the name updated —
    // or the assertion below passes for ever because it can see nothing.
    expect(catching("    try {\n      postgresUrl();\n    } catch {\n      return null;\n    }\n")).toBe(true);
    expect(catching("try { return Boolean(postgresUrl()); } catch { return false; }")).toBe(true);
    expect(catching("  try {\n    env['DIRECT_DATABASE_URL'] = directPostgresUrl();\n  } catch {\n    delete x;\n  }")).toBe(
      true,
    );
    // And the shapes that are not it: the plain call, and the boolean.
    expect(catching("const pool = new pg.Pool({ connectionString: postgresUrl() });")).toBe(false);
    expect(catching("if (!logConfigured(env)) return null;")).toBe(false);
  });

  it("is asked of no source file: nothing catches a URL getter to learn whether a log exists", () => {
    const files = sources();
    // Or the scan walked nothing at all.
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((path) => catching(readFileSync(path, "utf8")))).toEqual([]);
  });
});
