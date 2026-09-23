/**
 * The Postgres `LogQueries`, held to the contract (#221).
 *
 * This is the run that says the SQL is really the SQL: three anti-joins over
 * `events` with `jsonb_array_elements` and `distinct on` in them, which no fake
 * can demonstrate. Its twin is `integration/sqlite.test.ts`, where the same file runs
 * against `createSqliteLogQueries` with nothing installed — so a question one
 * store answers differently is a failing test rather than a machine that
 * quietly reports no findings.
 *
 * Every stream this file creates is removed afterwards, which needs the
 * append-only rule disabled for the delete: do not run it against a database a
 * conductor is writing to.
 */
import { afterAll, beforeAll } from "vitest";
import { createDb, createEventStore, type Db, directPostgresUrl } from "../src/index.ts";
// The implementation under test by its own module, not the barrel (#179).
import { createPostgresLogQueries } from "../src/queries.ts";
import { cleanupStreams, created } from "../test/support.ts";
import { describeLogQueriesContract } from "../test/queries-contract.ts";

let client: Db;

beforeAll(() => {
  client = createDb();
});

afterAll(async () => {
  await client.close();
  await cleanupStreams();
});

describeLogQueriesContract("postgres", () => ({
  store: createEventStore(client),
  // The direct connection, which is what `lingtai doctor` asks these on: the
  // pooler is where a dropped connection turns an audit into a red check that
  // has nothing to do with the log (`#157`).
  queries: createPostgresLogQueries({ url: directPostgresUrl() }),
  // A project per assertion, because the contract reuses issue numbers and the
  // database does not go away between them.
  project: `esctest${crypto.randomUUID().slice(0, 6)}`,
  note: (streamId) => created.add(streamId),
}));
