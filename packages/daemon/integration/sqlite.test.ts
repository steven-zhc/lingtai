/**
 * The SQLite daemon store, held to the contract Postgres is (#220).
 *
 * No server: each assertion gets a database in a directory of its own and
 * throws it away. In `integration/` all the same, because a directory of its
 * own is still the filesystem
 * ([0060](../../../doc/decisions/0060-the-gate-runs-unit-tests.md) §1) — *does
 * this need Postgres* was the old line and is not the one a gate asks (#225).
 *
 * The contract is the same file `integration/daemon-store.test.ts` runs against
 * Postgres — not a variant of it — so a behaviour one store has and the other
 * does not is a failing test rather than a silent divergence.
 *
 * **This whole file is the answer to "on a machine with no Postgres nothing
 * says whether a daemon is up".** It beats, reads the beat back, tells a
 * stopped daemon from one that never started, pauses and resumes the conductor
 * and reads the log's head — with nothing installed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createSqliteDaemonStore, openSqliteDaemon } from "../src/sqlite.ts";
import { describeDaemonStoreContract, type DaemonFixture } from "../test/contract.ts";

const dirs: string[] = [];

function freshPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-daemon-"));
  dirs.push(dir);
  return join(dir, "log.db");
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describeDaemonStoreContract("sqlite", async (): Promise<DaemonFixture> => {
  const path = freshPath();
  // The beacon and the log in one file, which is what makes `head()` and the
  // control stream the same system's — the arrangement `events` and
  // `daemon_status` have in Postgres.
  const db = openSqliteDaemon(path);
  const store = createSqliteDaemonStore(db);
  const seconds: { close(): Promise<void> }[] = [];
  const project = `esctest-sqlite-${crypto.randomUUID().slice(0, 8)}`;

  return {
    store,
    async another() {
      // A second connection to the same file: another process, as far as the
      // row is concerned.
      const s = createSqliteDaemonStore(openSqliteDaemon(path));
      seconds.push(s);
      return s;
    },
    async forget() {
      db.exec("DELETE FROM daemon_status");
    },
    prefix: `wi-${project}-%`,
    stream: (issue) => `wi-${project}-${issue}`,
    async close() {
      for (const s of seconds.splice(0)) await s.close().catch(() => {});
      await store.close();
    },
  };
});

describe("sqlite: what only this store answers for", () => {
  it("reads null from a file that has no beacon table, rather than throwing", async () => {
    // *No daemon has ever run* — the same answer Postgres gives for `relation
    // does not exist`, which `lingtai doctor` prints as "no daemon has run".
    // A store is asked this on a machine where nothing has started yet, so it
    // is an ordinary answer and not an error to show a person.
    const db = openSqliteDaemon(freshPath());
    const store = createSqliteDaemonStore(db);
    try {
      db.exec("DROP TABLE daemon_status");
      expect(await store.status()).toBeNull();
    } finally {
      await store.close();
    }
  });
});
