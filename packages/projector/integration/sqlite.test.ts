/**
 * The SQLite projection store, held to the contract Postgres is (#219).
 *
 * No server: each assertion gets a database in a directory of its own and
 * throws it away. In `integration/` all the same, because a directory of its
 * own is still the filesystem
 * ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1) — *does
 * this need Postgres* was the old line and is not the one a gate asks (#225).
 *
 * The contract is the same file `integration/projection.test.ts` runs against
 * Postgres — not a variant of it — so a behaviour one store has and the other
 * does not is a failing test rather than a silent divergence.
 *
 * **This whole file is the answer to "on a machine with no Postgres there is no
 * board".** It folds the real `taskViewProjection` and the real
 * `backlogProjection`, rebuilds through the real runner, and reads the board
 * back, with nothing installed.
 *
 * Below the contract is what only this store has to answer for: the seven lines
 * of dialect between the projections' Postgres SQL and the database underneath.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteEventStore, openSqliteLog } from "@lingtai/event-store/sqlite";
import {
  createSqliteProjectionStore,
  openSqliteProjections,
  translate,
} from "../src/sqlite.ts";
import { describeProjectionStoreContract, type ProjectionFixture } from "../test/contract.ts";

const dirs: string[] = [];

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-projections-"));
  dirs.push(dir);
  return join(dir, "log.db");
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeProjectionStoreContract("sqlite", async (): Promise<ProjectionFixture> => {
  const path = freshPath();
  // The log and the projections in one file, which is what makes `lag` one
  // question — the same arrangement `events` and `checkpoints` have in
  // Postgres. Two connections, because a store must never wait on the thread
  // (0009, and `openSqliteProjections`).
  const logDb = openSqliteLog(path);
  const store = createSqliteProjectionStore(openSqliteProjections(path));
  const seconds: { close(): Promise<void> }[] = [];
  const project = `esctest-sqlite-${crypto.randomUUID().slice(0, 8)}`;

  return {
    store,
    events: createSqliteEventStore(logDb),
    project,
    stream: (kind, suffix) => (kind === "wi" ? `wi-${project}-${suffix}` : `run-${project}-${suffix}`),
    async another() {
      const s = createSqliteProjectionStore(openSqliteProjections(path));
      seconds.push(s);
      return s;
    },
    async close() {
      await store.close();
      for (const s of seconds.splice(0)) await s.close();
      logDb.close();
    },
  };
});

describe("sqlite: the dialect the projections are written in", () => {
  it("renumbers a parameter used twice, in the order the statement uses them", () => {
    // `set updated_seq = $2 … where updated_seq <= $2` is how every guarded
    // write in `task-view.ts` is spelled. Positional placeholders mean the
    // value has to be bound as many times as it appears.
    const q = translate(
      "update t set a = $3, s = $2::bigint where id = $1 and s <= $2::bigint",
      ["id-1", "7", "note"],
    );
    expect(q.text).toBe("update t set a = ?, s = ? where id = ? and s <= ?");
    expect(q.params).toEqual(["note", 7n, "id-1", 7n]);
  });

  it("binds a seq as a number, because the statement said bigint", () => {
    // The one rewrite that would be wrong rather than loud. SQLite's `max`
    // orders an integer before *any* text, so `max(941, '12')` is `'12'` — a
    // checkpoint that goes backwards, silently, on the gate verdict path.
    const q = translate("update t set s = greatest(s, $1::bigint)", ["12"]);
    expect(q.text).toBe("update t set s = max(s, ?)");
    expect(q.params).toEqual([12n]);
  });

  it("merges a key into a map rather than concatenating two strings", () => {
    // `||` is a jsonb merge in Postgres and string concatenation in SQLite. Left
    // alone, `verdicts` would become `{}{"g":"passed"}` and every card would
    // count no verdicts while nothing threw.
    const q = translate(
      "update t set verdicts = verdicts || jsonb_build_object($1::text, $2::text)",
      ["run-1:proposed:build", "passed"],
    );
    expect(q.text).toBe("update t set verdicts = json_patch(verdicts, json_object(?, ?))");
  });

  it("leaves a placeholder inside a string literal alone", () => {
    const q = translate("select * from t where note = '$1 is not a parameter' and id = $1", ["x"]);
    expect(q.text).toBe("select * from t where note = '$1 is not a parameter' and id = ?");
    expect(q.params).toEqual(["x"]);
  });

  it("drops the comments before it rewrites anything", () => {
    // `task_view` documents half its columns in prose, and prose holds the word
    // `jsonb`, an apostrophe and the occasional `now()`. A rewrite that read
    // them would be rewriting documentation.
    const q = translate(
      `create table if not exists t (
         -- the event's own clock, never now(), and not jsonb
         at timestamptz not null,
         payload jsonb not null default '{}'::jsonb
       )`,
    );
    expect(q.text).not.toContain("--");
    expect(q.text).toContain("at text not null");
    expect(q.text).toContain("payload text not null default '{}'");
  });

  it("holds a time as something that sorts as a time", () => {
    const q = translate("insert into t (at) values ($1)", [new Date("2026-09-21T08:30:00.000Z")]);
    expect(q.params).toEqual(["2026-09-21T08:30:00.000Z"]);
  });

  it("holds a boolean and a payload as something SQLite can bind", () => {
    const q = translate("insert into t (b, d) values ($1, $2)", [true, { what: "a conflict" }]);
    expect(q.params).toEqual([1, '{"what":"a conflict"}']);
  });
});
