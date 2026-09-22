/**
 * **One place decides which store, and every store resolves through it** — the
 * property [#179](https://github.com/steven-zhc/lingtai/issues/179) exists to
 * establish, read off the sources rather than remembered.
 *
 * Before it, all three barrels handed out Postgres and a caller picked its
 * implementation by typing the name: `createPostgresProjectionStore`,
 * `createPostgresDaemonStore`, `createPostgresLog`. Fifteen sites, and the
 * written choice reached none of them.
 *
 * A comment is not what keeps that from coming back. The next reader who needs
 * a store will reach for the name that works, and it will go on working — on
 * their machine, which is a Postgres one. So the rule is a failing test, in the
 * half of the suite that needs no database, and it is in `packages/env` for the
 * reason `two-questions.test.ts` and `board-port.test.ts` are: this package is
 * where the answer lives, and it depends on nothing that could import its way
 * around the scan.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRoot } from "../src/index.ts";

/** Every `.ts`/`.tsx` under each workspace package's `src`, repo-relative. */
function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
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
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
        out.push({ file: relative(repoRoot(), path), text: readFileSync(path, "utf8") });
      }
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

/** Ignores the prose. Half the files named below explain what they no longer do. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** `createPostgresAnything(` or `createSqliteAnything(` — the ticket's own grep. */
const NAMES = /\bcreate(?:Postgres|Sqlite)[A-Za-z]*\(/;

/**
 * The files that *are* one of the two stores. Each is allowed to name itself
 * and the pieces it is built from, and nothing else in the workspace is.
 */
const IMPLEMENTATIONS = [
  "packages/event-store/src/log.ts",
  "packages/event-store/src/queries.ts",
  "packages/event-store/src/wake.ts",
  "packages/event-store/src/sqlite.ts",
  "packages/projector/src/postgres.ts",
  "packages/projector/src/sqlite.ts",
  "packages/daemon/src/postgres.ts",
  "packages/daemon/src/sqlite.ts",
];

/** The three that choose, one per package, each reading `chosenStore()` and nothing else. */
const CHOOSERS = [
  "packages/event-store/src/choose.ts",
  "packages/projector/src/choose.ts",
  "packages/daemon/src/choose.ts",
];

/**
 * The one exception, with its ticket.
 *
 * `lingtai doctor` still asks the log two questions through
 * `createPostgresLogQueries` — reading a URL it was given and reporting on it.
 * [#214](https://github.com/steven-zhc/lingtai/issues/214) is where `doctor`
 * reads the choice instead, and it is deliberately after this: a diagnostic
 * that reports on a machine is a different problem from a factory that opens
 * it, and #179 is the second one.
 */
const NOT_YET = ["apps/cli/src/doctor.ts"];

describe("one selection", () => {
  it("is a scan that sees the shape it exists for", () => {
    // Or every assertion below passes for ever because it can see nothing.
    expect(NAMES.test("const s = createPostgresProjectionStore({ url });")).toBe(true);
    expect(NAMES.test("return sqlite.createSqliteDaemonStore(db);")).toBe(true);
    // And the shapes that are not it: a type, and a store asked for rather than named.
    expect(NAMES.test("type PostgresDaemonStoreOptions = { url?: string };")).toBe(false);
    expect(NAMES.test("const store = await projectionStore({ max: 1 });")).toBe(false);
  });

  it("finds the files it is about", () => {
    const files = new Set(sources().map((s) => s.file));
    expect(files.size).toBeGreaterThan(100);
    for (const file of [...IMPLEMENTATIONS, ...CHOOSERS, ...NOT_YET]) expect(files).toContain(file);
  });

  it("names an implementation in an implementation, a chooser, and nowhere else", () => {
    const allowed = new Set([...IMPLEMENTATIONS, ...CHOOSERS, ...NOT_YET]);
    const offenders = sources()
      .filter((s) => !allowed.has(s.file))
      .filter((s) => NAMES.test(code(s.text)))
      .map((s) => s.file);

    expect(offenders).toEqual([]);
  });

  it("opens a store through `chosenStore()` in the three choosers and nowhere else", () => {
    // The other half, and the one a `createPostgres…` grep cannot see: a second
    // reader of the machine's answer is a second decision, however it spells
    // the factory it calls. `storeChoice()` is deliberately not this — it is
    // total, and `lingtai init` and `lingtai doctor` *report* with it. What may
    // not spread is the face that opens.
    const callers = sources()
      .filter((s) => /\bchosenStore\s*\(/.test(code(s.text)))
      .map((s) => s.file)
      .sort();

    expect(callers).toEqual([...CHOOSERS, "packages/env/src/index.ts"].sort());
  });
});
