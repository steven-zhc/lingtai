/**
 * Empty the test database's log.
 *
 *   LINGTAI_TEST=1 pnpm --filter @lingtai/event-store db:reset-test
 *
 * The suite appends real events and cleans up its own streams, but the log as a
 * whole only grows: 945 events and a sequence past 11,000 after a few weeks of
 * runs. Most tests do not care. `rebuilding changes nothing on screen` does,
 * because a rebuild replays the *whole* log — so that test's cost is the log's
 * length, and it got slower with every suite run anyone had ever done until it
 * crossed the 60s timeout and started failing for a reason that had nothing to
 * do with the code being tested.
 *
 * Deliberately a separate command rather than a hook in `beforeAll`. Wiping a
 * database is not something a test run should do on its own initiative, and a
 * suite that silently truncates is one nobody can point at a database they care
 * about — which is exactly the mistake this is cleaning up after.
 *
 * ## Why this cannot hit the real log
 *
 * Two independent checks, because one is a typo away from nothing. The test
 * flag must be set, *and* no connection string the test side resolves may be
 * one the operator's side resolves. If someone points LINGTAI_TEST_DATABASE_URL at their own
 * database, the second check is what refuses.
 *
 * Every string on each side, pooled and direct, rather than the direct pair
 * alone: since #176 an absent direct URL is the pooled one, so the test side's
 * direct string can be the operator's *pooled* one while the operator's direct
 * string is a different spelling of the same database. Compared direct against
 * direct, that passed and truncated the real log.
 */
import pg from "pg";
import { databaseUrl, directDatabaseUrl } from "@lingtai/event-store";

if (!process.env["LINGTAI_TEST"] && !process.env["VITEST"]) {
  console.error("refusing: set LINGTAI_TEST=1 to say which database you mean");
  process.exit(2);
}

const testUrl = directDatabaseUrl();

/** Every string a side resolves, pooled and direct; one that throws is absent. */
function resolved(env) {
  const urls = new Set();
  for (const read of [databaseUrl, directDatabaseUrl]) {
    try {
      urls.add(read(env));
    } catch {
      // Not configured on this side. Nothing to collide with.
    }
  }
  return urls;
}

const testSide = resolved(process.env);
const operatorSide = resolved({ ...process.env, LINGTAI_TEST: "", VITEST: "" });
const collision = [...testSide].find((url) => operatorSide.has(url));

if (collision) {
  console.error(
    "refusing: a connection string the test log resolves to (LINGTAI_TEST_DATABASE_URL, or LINGTAI_TEST_DIRECT_DATABASE_URL " +
      "or its stand-in) is one the operator's log resolves to (LINGTAI_DATABASE_URL or LINGTAI_DIRECT_DATABASE_URL)",
  );
  process.exit(2);
}

const client = new pg.Client({ connectionString: testUrl });
await client.connect();
try {
  const before = await client.query("select count(*)::int as n from events");

  // The table carries a rule that turns deletes into no-ops — the log is
  // append-only and means it. Cleaning up is an explicit, temporary exception.
  await client.query("alter table events disable rule lingtai_events_no_delete");
  try {
    await client.query("truncate table events restart identity");
    // Checkpoints name a sequence that no longer exists; a projection resuming
    // from one would sit forever waiting for events behind it.
    await client.query("truncate table checkpoints");
    // The outbox outlives a log reset because the contract owns the table and
    // no projection drops it. Left behind, a dead letter from a suite that
    // exercised a permanent failure makes `lingtai doctor` red forever — the check
    // being right about data that no longer means anything.
    await client.query("truncate table outbox");
  } finally {
    await client.query("alter table events enable rule lingtai_events_no_delete");
  }

  console.log(`test log reset — ${before.rows[0].n} events removed, sequence restarted`);
  console.log("projection tables are rebuilt on next start; their checkpoints are cleared");
} finally {
  await client.end();
}
