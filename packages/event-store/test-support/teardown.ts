/**
 * What the suite leaves behind, removed.
 *
 * Every database-touching test invents a throwaway project called
 * `esctest<random>` and appends **real** events for it — that is deliberate,
 * these tests are not mocked. What was missing is the other half: nothing ever
 * removed them, so the test log gained a project per run for ever.
 *
 * That is not merely untidy, and the way it failed is worth writing down. An
 * `esctest*` project's outbox rows named GitHub issues that never existed, so
 * delivery answered 404, `attempts` climbed, and past `MAX_ATTEMPTS` the row
 * was dead for good. (The outbox itself is gone — 0022 — but the lesson is not:
 * residue from one suite is what fails the next one.) Twelve such rows
 * accumulated, and then
 * `lingtai doctor`'s own test — which asserts the whole database is green —
 * started failing on residue no test in that file had created. A suite that
 * fails because of what an *earlier* suite left is a suite nobody trusts.
 *
 * Deleting from `events` is the thing this system says it should never make
 * routine. That rule is about the operator's log; this is not that log, and the
 * guard below is what keeps the distinction real rather than assumed — it
 * refuses to delete anything if the log holds a stream for a project that is
 * not throwaway.
 *
 * Set `LINGTAI_KEEP_TEST_DATA=1` to skip this and inspect what a run produced.
 *
 * Three things here fail *silently* if you get them wrong, and all three did
 * once, in this order:
 *
 * - It is wired as vitest's **`globalSetup`**, whose module may export a
 *   `teardown`. There is no `globalTeardown` option — that is Jest's name, and
 *   vitest drops the unknown key without a word.
 * - This module runs *outside* the test files, so nothing has loaded
 *   `.env.local` yet. Importing `@lingtai/env` for its side effect is what makes
 *   `LINGTAI_TEST_DATABASE_URL` exist here at all; without it the URL is `undefined`,
 *   the function returns at its first line, and every run looks like a run that
 *   cleaned up.
 * - `delete from events` does nothing unless `lingtai_events_no_delete` is
 *   disabled first. The rule answers `DO INSTEAD NOTHING`, so the statement
 *   succeeds and removes no rows. The rule is re-enabled in a `finally`: a live
 *   database left without its append-only guarantee is far worse than a test
 *   database left dirty.
 */
// Side effect: loads `.env.local` from the workspace root. See above.
import "@lingtai/env";
import pg from "pg";

/**
 * The names the suite invents for itself, as one pattern.
 *
 * **Two of them**, because the fixtures come in two shapes: `esctest…` is a
 * throwaway *project*, and `test-<8 hex>` is `event-store/test/support.ts`'s
 * throwaway *stream*, which belongs to no project at all and so cannot carry a
 * project's name.
 *
 * The guard below has to know both, and until 2026-09-11 it knew one. That is
 * not a tidiness point, and what it cost is the reason this comment is long.
 * An interrupted event-store run left twenty-two `wi-test-<hex>` rows behind at
 * 22:09 on 2026-09-10; the guard read them as a log with real history in it and
 * from that moment deleted **nothing**. Six hours of runs added 1,650 events
 * nobody swept, `task_view`'s rebuild — which costs a round trip per event —
 * went past the 60s its own test allows, and `pnpm test` began failing on a
 * change that had not touched the projector.
 *
 * **A guard a crashed run can disarm for ever removes cleanup rather than
 * protecting it.** The protection that is wanted is against a *real* log, and a
 * stream the suite itself named is not one.
 */
const THROWAWAY = String.raw`(esctest|test-[0-9a-f]{8}$)`;

/** Nothing to prepare. The suite builds its own fixtures. */
export function setup(): void {}

export async function teardown(): Promise<void> {
  if (process.env["LINGTAI_KEEP_TEST_DATA"]) return;
  // Session mode, like every other statement that is not an ordinary query.
  // `LINGTAI_`-prefixed since `#63`: every name Lingtai reads for itself is.
  const url =
    process.env["LINGTAI_TEST_DIRECT_DATABASE_URL"] ?? process.env["LINGTAI_TEST_DATABASE_URL"];
  // Read by name rather than through `databaseUrl()`, which decides between the
  // two by whether it thinks it is in a test. This file may only ever touch the
  // test one, and naming it is how that stays checkable.
  //
  // Missing means the suite could not have run at all, and saying so here would
  // be the second complaint — `@lingtai/env` already refuses, by name, before a
  // single test starts.
  if (!url) return;

  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    // The guard. A work item, run, integration or project stream that is not a
    // throwaway means this is pointed at a log with real history in it, and
    // nothing here may touch it.
    const real = await c.query(
      `select distinct stream_id from events
       where stream_id ~ '^(wi|run|int|prj)-' and stream_id !~ $1 limit 5`,
      [`^(wi|run|int|prj)-${THROWAWAY}`],
    );
    if (real.rows.length > 0) {
      console.warn(
        `[teardown] leaving the test log alone: it holds streams that are not throwaway — ` +
          real.rows.map((r: { stream_id: string }) => r.stream_id).join(", "),
      );
      return;
    }

    try {
      await c.query("alter table events disable rule lingtai_events_no_delete");
      // The work the suite invented, and the control aggregate beside it.
      //
      // **`ctl-` is swept wholesale, and it has to be.** There is one control
      // stream for the whole system, so a reconcile test cannot give it a
      // throwaway name the way it gives one to a work item — every run appends
      // to `ctl-conductor` itself and nothing ever removed any of it. 1,016
      // `Reconciled` events had collected in it by 2026-09-11, every one of them
      // naming a temporary worktree that stopped existing when the test that
      // made it ended, and each costing a replay the same round trip a real
      // event costs.
      //
      // Safe **here and nowhere else**: the guard above has already established
      // that this log holds no real work item, and a log with no real work has
      // no real control history either.
      await c.query(`delete from events where stream_id ~ $1 or stream_id ~ '^ctl-'`, [
        `^(wi|run|int|prj)-${THROWAWAY}`,
      ]);
    } finally {
      await c.query("alter table events enable rule lingtai_events_no_delete");
    }

    // Every projection that names a project, found rather than listed: a table
    // added later is covered without anyone remembering to add it here.
    const projections = await c.query(
      `select table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'project'
         and table_name != 'events'`,
    );
    for (const { table_name } of projections.rows as { table_name: string }[]) {
      await c.query(`delete from "${table_name}" where project like $1`, [`${THROWAWAY}%`]);
    }
  } finally {
    await c.end();
  }
}
