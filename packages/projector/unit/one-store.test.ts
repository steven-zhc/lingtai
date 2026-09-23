/**
 * The rule #219 exists to establish, asserted rather than remembered.
 *
 * **A direct `pg` client outside the Postgres implementation is a place the
 * init-time choice does not reach** ([0055](../../../doc/decisions/0055-two-implementations-chosen-at-init.md)
 * §1). There were six of them under `src/`, each opening its own connection
 * from `databaseUrl()`, and that is why there was nothing to swap and why #179
 * spent eight passes having its reviewer name one at a time.
 *
 * One is not a rule anybody keeps by reading a comment: the next projection to
 * be added will want a read, and a `new pg.Client` is the shortest way to get
 * one. So the rule is a failing test, in the half of the suite that needs no
 * database — the same shape `packages/env/integration/two-questions.test.ts` gives its
 * own.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** The one file allowed to know what a driver is. Its twin knows `node:sqlite`. */
const POSTGRES = "postgres.ts";
const SQLITE = "sqlite.ts";
/** And the one allowed to know there are two. #179 put it there; nothing else may. */
const CHOICE = "choose.ts";

const sources = readdirSync(SRC)
  .filter((f) => f.endsWith(".ts"))
  .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));

/** Ignores the prose. Every file here documents what it does not do. */
const code = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("one store, and one place that knows which", () => {
  it("finds the files it is about", () => {
    // A rename that emptied this list would leave every assertion below
    // vacuously true, which is the failure mode a source-reading test has.
    expect(sources.map((s) => s.file)).toEqual(
      expect.arrayContaining(["projection.ts", "shape.ts", "task-view.ts", "backlog.ts", POSTGRES, SQLITE, CHOICE]),
    );
  });

  it("constructs a pg client in the Postgres implementation and nowhere else", () => {
    const offenders = sources
      .filter((s) => s.file !== POSTGRES)
      .filter((s) => /\bnew pg\.|from "pg"/.test(code(s.text)))
      .map((s) => s.file);

    expect(offenders).toEqual([]);
  });

  it("reaches for node:sqlite in the SQLite implementation and nowhere else", () => {
    const offenders = sources
      .filter((s) => s.file !== SQLITE)
      .filter((s) => /node:sqlite/.test(code(s.text)))
      .map((s) => s.file);

    expect(offenders).toEqual([]);
  });

  it("names both implementations in choose.ts and nowhere else", () => {
    // The rule #179 inherited and did not delete. Before it, no file under
    // `src/` mentioned both stores, so there was nowhere a selection could have
    // been written — which is what "nothing chooses between them" meant while
    // the implementations were being built.
    //
    // Something has to choose now, and what is worth keeping is that **exactly
    // one file does**. `choose.ts` is it: it reads `@lingtai/env`'s
    // `chosenStore()` and nothing else, and the moment a second file here names
    // both, this fails.
    //
    // **No other file is exempt**, least of all `index.ts` and `store.ts` — a
    // barrel re-exporting both, or a store module picking one from an env var,
    // is precisely the second decision
    // [0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md)
    // exists to remove.
    const both = sources
      .filter((s) => {
        const c = code(s.text);
        return c.includes("createPostgresProjectionStore") && c.includes("createSqliteProjectionStore");
      })
      .map((s) => s.file);

    expect(both).toEqual([CHOICE]);
  });
});
