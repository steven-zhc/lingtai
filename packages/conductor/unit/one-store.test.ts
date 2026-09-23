/**
 * The rule #221 exists to establish, asserted rather than remembered.
 *
 * **A direct `pg` client outside a Postgres implementation is a place the
 * init-time choice does not reach**
 * ([0055](../../../doc/decisions/0055-two-implementations-chosen-at-init.md)
 * §1). There were three of them under `src/` — `listProjectStreams` in
 * `projects.ts`, `endedWithoutEndActions` in `end-point.ts` and
 * `landedWithoutGatePoints` in `gate-audit.ts` — each opening its own
 * connection from `postgresUrl()` and writing SQL against `events`. They were
 * readers of the log that never learned the log has an interface, and the first
 * of them is why `lingtai status`, the first command anybody types, died on a
 * machine with no Postgres.
 *
 * One is not a rule anybody keeps by reading a comment: the next question the
 * conductor needs to ask the log will want a query, and a `new pg.Client` is
 * the shortest way to get one. So the rule is a failing test, in the half of
 * the suite that needs no database — the same file `packages/projector` (#219)
 * and `packages/daemon` (#220) keep for the same reason.
 *
 * **There is no exempt file here.** The projector and the daemon each have a
 * `postgres.ts` that is allowed to know what a driver is; the conductor has
 * none and should have none. It holds no store: it asks one, through
 * `EventStore` and `LogQueries`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));

/** Ignores the prose. Several files here document what they no longer do. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the conductor asks the log, and never a driver", () => {
  it("finds the files it is about", () => {
    // A rename that emptied this list would leave every assertion below
    // vacuously true, which is the failure mode a source-reading test has.
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["projects.ts", "end-point.ts", "gate-audit.ts"]),
    );
  });

  it("constructs a pg client nowhere", () => {
    const offenders = sources
      .filter((s) => /\bnew pg\.|from "pg"/.test(code(s.text)))
      .map((s) => s.file);

    expect(offenders).toEqual([]);
  });

  it("reaches for node:sqlite nowhere either", () => {
    // The other half of the same rule. A conductor that knew about one store
    // would be as wrong as one that knew about the other.
    const offenders = sources.filter((s) => /node:sqlite/.test(code(s.text))).map((s) => s.file);

    expect(offenders).toEqual([]);
  });

  it("names no implementation, so nothing here chooses one", () => {
    // What "nothing chooses the store here" means as a check — that decision is
    // #179's. `createPostgresLogQueries` and `createSqliteLogQueries` are both
    // absent, and so is `createSqliteEventStore`: the default is reached as
    // `log` from the barrel, which is one name and not a selection.
    const both = sources
      .filter((s) => /createSqlite|createPostgresLogQueries|createPostgresProjectionStore/.test(code(s.text)))
      .map((s) => s.file);

    expect(both).toEqual([]);
  });
});
