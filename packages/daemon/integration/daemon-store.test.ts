/**
 * The Postgres daemon store, against the real row and the real log (#220).
 *
 * The contract is `test/contract.ts`, the same file `integration/sqlite.test.ts` runs
 * — not a variant of it — so a behaviour one store has and the other does not
 * is a failing test rather than a silent divergence.
 *
 * `daemon_status` is one row for the whole installation, so every assertion
 * removes it on the way out: a test that left one behind would tell the next
 * package's `lingtai doctor` that a daemon is up.
 */
import { directPostgresUrl } from "@lingtai/env";
import pg from "pg";
import { afterAll } from "vitest";
import { createPostgresDaemonStore } from "../src/postgres.ts";
import { describeDaemonStoreContract, type DaemonFixture } from "../test/contract.ts";

const created = new Set<string>();

async function onDirect<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: directPostgresUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  await onDirect(async (c) => {
    await c.query("delete from daemon_status where id = 1").catch(() => {});
    try {
      await c.query("alter table events disable rule lingtai_events_no_delete");
      for (const id of created) await c.query("delete from events where stream_id = $1", [id]);
    } finally {
      await c.query("alter table events enable rule lingtai_events_no_delete");
    }
  });
});

describeDaemonStoreContract("postgres", async (): Promise<DaemonFixture> => {
  const store = createPostgresDaemonStore();
  // A project of its own per fixture — that is, per assertion — so that the
  // `like` patterns below name this test's streams and nothing the rest of the
  // suite left in the log. `esctest` is what `test-support/teardown.ts` sweeps.
  const project = `esctest${crypto.randomUUID().slice(0, 6)}`;
  return {
    store,
    async another() {
      // A second store is a second connection: the implementation opens one per
      // operation, so this is two processes as far as the row is concerned.
      return createPostgresDaemonStore();
    },
    async forget() {
      await onDirect(async (c) => {
        // No table means no row, which is the state this asks for.
        await c.query("delete from daemon_status where id = 1").catch(() => {});
      });
    },
    prefix: `wi-${project}-%`,
    stream(issue) {
      const id = `wi-${project}-${issue}`;
      created.add(id);
      return id;
    },
    async close() {
      await store.close();
    },
  };
});
