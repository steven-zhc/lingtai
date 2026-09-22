/**
 * The questions a production path asks of the log that are not a stream read
 * (#221).
 *
 * `EventStore` covers appending and reading. It does not cover *which streams
 * are there* or *which items ended with a point that never ran* — so four files
 * asked those by opening a `pg.Client` of their own and writing SQL:
 * `listProjectStreams`, `endedWithoutEndActions` and the gate audit in
 * `packages/conductor/src/`, and `wake.ts` next door. That is
 * [0055](../../../doc/decisions/0055-two-implementations-chosen-at-init.md)
 * §1's defect in one sentence — **a direct `pg.Client` outside a Postgres
 * implementation is a place the init-time choice does not reach** — and it is
 * why `lingtai status`, the first command anybody types, died on a machine with
 * no Postgres.
 *
 * The shape is `EventStore`'s, `ProjectionStore`'s (#219) and `DaemonStore`'s
 * (#220), deliberately and exactly: an interface, two implementations beside
 * each other, and a contract (`test/queries-contract.ts`) that neither of them
 * owns deciding whether they agree.
 *
 * ## The comparison happens in the database, and that is the whole design
 *
 * Every question here is *a fold that would be wrong to do in the process*. The
 * gate audit compares fourteen event types' whole history against a plan, and
 * `GatePassed` carries an agent's entire build or review output. Answering it
 * by reading those rows out and comparing them here would transfer — and zod-
 * parse — tens of megabytes of review prose on every `lingtai doctor`, growing
 * with the log for ever, to produce a result that is two queries returning
 * nothing. So the interface is a list of *named questions* and not a query
 * language: each implementation answers its own in its own dialect, and both
 * return only the offending rows.
 *
 * ## What each caller keeps
 *
 * The domain stays with the caller. This takes the stream prefix and the list
 * of event types that count as proof, and hands back column names; parsing
 * `wi-lingtai-52` into a project and an issue is the conductor's, as it was.
 *
 * ## Nothing here chooses, and since #179 `choose.ts` does
 *
 * A caller reaches these through `log.queries`, and which implementation is
 * behind them is whichever of the two this machine wrote down
 * ([0056](../../../doc/decisions/0056-the-store-is-a-written-choice.md)), and
 * **nothing outside `choose.ts` names this implementation.** `lingtai doctor`
 * was the last that did: it put two of the questions below through a URL it had
 * been handed, so they could only be asked of a Postgres machine, though both
 * are questions about a log.
 * [#214](https://github.com/steven-zhc/lingtai/issues/214) moved it onto
 * `processLog()` — which is why `packages/env/test/one-choice.test.ts` carries
 * no exception any more, and why a second direct caller here would be a new
 * one rather than company.
 */
import pg from "pg";
import { postgresUrl } from "./env.ts";

/** Which ending an item reached. The recipe's `when:` at `end` names one of these. */
export type EndedOutcome = "landed" | "closed";

/** An item that ended with a plan at `end` and no record of it running, as a store finds it. */
export interface EndedWithoutEnd {
  streamId: string;
  outcome: EndedOutcome;
}

/** One landed item, one run, one point that was planned and recorded nothing. */
export interface PointNeverRan {
  workItemId: string;
  runId: string;
  gate: string;
}

export interface LogQueries {
  /**
   * Every stream whose id starts with `prefix`, in id order.
   *
   * `loadProjects` is this over `prj-`: a handful of projects with a handful of
   * events each is a stream to fold rather than a projection to maintain, and
   * the only thing missing from `EventStore` is being told which ones exist.
   */
  projectStreams(prefix: string): Promise<string[]>;

  /**
   * Every item that ended whose `end` point was configured and did not run —
   * the comparison [0015](../../../doc/decisions/0015-five-gates-and-two-extensions.md)
   * promised, computed from the log alone.
   *
   * `GatesResolved` on the run says the recipe asked for something at `end`;
   * `EndActionsResolved` on the item's own stream, *for the outcome it
   * reached*, is the record that the point ran. The outcome matters: an item
   * that resolved `end` while it was blocked, came back and then landed has one
   * of each and is not settled by the first.
   */
  endedWithoutEndActions(): Promise<EndedWithoutEnd[]>;

  /**
   * The same comparison for the four points that produce verdicts, whose record
   * lives on the run's stream — one row per point, anchored on what landed.
   *
   * `ranTypes` is the caller's: which events are proof a pipeline reached a
   * point is the conductor's rule, not a store's.
   */
  landedWithoutGatePoints(ranTypes: readonly string[]): Promise<PointNeverRan[]>;
}

export interface PostgresLogQueriesOptions {
  /** Defaults to `postgresUrl()`, which is what every caller read before this existed. */
  url?: string;
}

/**
 * A connection per question, opened and closed around it.
 *
 * Exactly what the four callers did, and kept rather than pooled on purpose:
 * these are asked by `lingtai doctor`, `lingtai status` and a board render, not
 * in a loop, and a pool held here would be a connection a short command has to
 * remember to end.
 */
export function createPostgresLogQueries(options: PostgresLogQueriesOptions = {}): LogQueries {
  // Read per question rather than at construction, so building one of these
  // never throws: `postgresUrl()` refuses when nothing is configured, and a
  // caller that is about to hand this to something else should not be the one
  // to find out.
  const url = () => options.url ?? postgresUrl();

  async function ask<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      return (await client.query<T>(text, [...values])).rows;
    } finally {
      await client.end();
    }
  }

  return {
    async projectStreams(prefix) {
      const rows = await ask<{ stream_id: string }>(
        "select distinct stream_id from events where stream_id like $1 order by stream_id",
        [`${prefix}%`],
      );
      return rows.map((r) => r.stream_id);
    },

    async endedWithoutEndActions() {
      const rows = await ask<{ stream_id: string; outcome: string }>(
        `with over as (
           select distinct on (stream_id) stream_id,
                  case when type = 'WorkItemClosed' then 'closed' else 'landed' end as outcome
           from events
           where type in ('WorkItemLanded', 'WorkItemClosed')
           order by stream_id, seq desc
         ),
         planned as (
           select distinct started.data->>'workItemId' as work_item
           from events started
           join events plan
             on plan.stream_id = started.stream_id and plan.type = 'GatesResolved'
           where started.type = 'RunStarted'
             and exists (
               select 1 from jsonb_array_elements(plan.data->'points') point
               where point->>'gate' = 'end' and jsonb_array_length(point->'actions') > 0
             )
         )
         select over.stream_id, over.outcome
         from over
         join planned on planned.work_item = over.stream_id
         where not exists (
           select 1 from events resolved
           where resolved.stream_id = over.stream_id
             and resolved.type = 'EndActionsResolved'
             and resolved.data->>'outcome' = over.outcome
         )
         order by over.stream_id`,
      );
      return rows.map((r) => ({
        streamId: r.stream_id,
        outcome: r.outcome === "closed" ? ("closed" as const) : ("landed" as const),
      }));
    },

    async landedWithoutGatePoints(ranTypes) {
      const rows = await ask<{ work_item: string; run_id: string; gate: string }>(
        `with landed as (
           select distinct stream_id as work_item from events where type = 'WorkItemLanded'
         ),
         last_run as (
           select distinct on (data->>'workItemId')
                  data->>'workItemId' as work_item, stream_id as run_id
           from events
           where type = 'RunStarted'
           order by data->>'workItemId', seq desc
         ),
         planned as (
           select plan.stream_id as run_id, point->>'gate' as gate
           from events plan, lateral jsonb_array_elements(plan.data->'points') point
           where plan.type = 'GatesResolved'
             and point->>'gate' <> 'end'
             and jsonb_array_length(point->'actions') > 0
         )
         select last_run.work_item, planned.run_id, planned.gate
         from landed
         join last_run on last_run.work_item = landed.work_item
         join planned on planned.run_id = last_run.run_id
         where not exists (
           select 1 from events ran
           where ran.stream_id = planned.run_id
             and ran.type = any($1::text[])
             and ran.data->>'gate' = planned.gate
         )
         order by last_run.work_item, planned.gate`,
        [[...ranTypes]],
      );
      return rows.map((r) => ({ workItemId: r.work_item, runId: r.run_id, gate: r.gate }));
    },
  };
}
