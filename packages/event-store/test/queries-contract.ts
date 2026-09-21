/**
 * What a `LogQueries` is, stated once and run against every implementation
 * (#221).
 *
 * The pattern is `contract.ts`'s and `wake-contract.ts`'s, and so is the
 * reason: a second implementation held to nothing is worth nothing. Three
 * questions that used to be raw SQL in `packages/conductor/src/` are now an
 * interface with two answers, and the only thing that makes the second one
 * trustworthy is that both are asked the same things here and must agree.
 *
 * - `test/queries.test.ts` runs it against `createPostgresLogQueries`, where a
 *   database is available. That run is what says the SQL is really the SQL.
 * - `pure/sqlite.test.ts` runs it against `createSqliteLogQueries`, with
 *   nothing installed — the machine
 *   [#179](https://github.com/steven-zhc/lingtai/issues/179) exists for.
 *
 * **Every assertion is a negative one made positive.** Each question is an
 * anti-join: *which items landed past a point that was configured and did not
 * run*. The failure that matters is not a wrong row but a silent empty answer,
 * so every case here seeds both an offender and a near-miss and checks that the
 * offender comes back and the near-miss does not.
 */
import { parsePayload, workItemStream } from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../src/event-store.ts";
import type { LogQueries } from "../src/queries.ts";

/** What a caller of this contract supplies: one log, read two ways. */
export interface LogQueriesHarness {
  /** Where the events go in. */
  store: EventStore;
  /** The same log, asked. */
  queries: LogQueries;
  /** A project name nothing else in the test database is using. */
  project: string;
  /**
   * Told about every stream this contract creates, so a shared database can be
   * cleaned up by name afterwards. Nothing to do where the log is a file the
   * test throws away.
   */
  note?: (streamId: string) => void;
}

const SHA = "a".repeat(40);
const MERGE = "b".repeat(40);

/** The five points, with actions only where a case asks for them. */
const plan = (points: Record<string, string[]>) =>
  (["admit", "prepared", "proposed", "merge", "end"] as const).map((gate) => ({
    gate,
    actions: points[gate] ?? [],
  }));

export function describeLogQueriesContract(
  name: string,
  make: () => LogQueriesHarness | Promise<LogQueriesHarness>,
): void {
  /**
   * A run for `workItemId` that planned `points` and recorded a verdict at each
   * of `ran`. Written as events, because that is what the questions read.
   */
  async function run(
    h: LogQueriesHarness,
    workItemId: string,
    points: Record<string, string[]>,
    ran: { gate: string; action: string }[] = [],
  ): Promise<string> {
    const runId = `run-${h.project}-${crypto.randomUUID().slice(0, 8)}`;
    h.note?.(runId);
    await h.store.append(runId, 0, [
      {
        type: "RunStarted",
        actor: "conductor",
        data: parsePayload("RunStarted", {
          workItemId,
          runtime: "claude-code",
          model: "",
          promptVersion: "ticket@1",
          baseSha: SHA,
          configHash: "seeded",
          worktree: "/tmp/none",
          invocation: null,
        }),
      },
      {
        type: "GatesResolved",
        actor: "conductor",
        data: parsePayload("GatesResolved", { runId, configHash: "seeded", points: plan(points) }),
      },
      ...ran.map((r) => ({
        type: "GatePassed",
        actor: "conductor",
        data: parsePayload("GatePassed", { ...r, runId, onSha: SHA, evidence: "ok", findings: [] }),
      })),
    ]);
    return runId;
  }

  const landed = () => ({
    type: "WorkItemLanded",
    actor: "conductor",
    data: parsePayload("WorkItemLanded", { mergeCommit: MERGE, base: "main" }),
  });

  const closed = () => ({
    type: "WorkItemClosed",
    actor: "human:test",
    data: parsePayload("WorkItemClosed", { by: "human:test", reason: "done elsewhere" }),
  });

  const resolved = (outcome: "landed" | "closed" | "blocked") => ({
    type: "EndActionsResolved",
    actor: "conductor",
    data: parsePayload("EndActionsResolved", { outcome, actions: [{ name: "close", close: true }] }),
  });

  describe(`${name}: the log queries contract`, () => {
    // ------------------------------------------------------ projectStreams ----

    it("lists the streams under a prefix, in id order, once each", async () => {
      const h = await make();
      const one = `prj-${h.project}-one`;
      const two = `prj-${h.project}-two`;
      h.note?.(one);
      h.note?.(two);
      const configured = (project: string) => ({
        type: "ProjectConfigured" as const,
        actor: "conductor",
        data: parsePayload("ProjectConfigured", {
          project,
          owner: "steven-zhc",
          base: "main",
          configHash: "h",
          fromSha: "s",
        }),
      });
      // Two events on `two`, so a query that forgot `distinct` says so.
      await h.store.append(two, 0, [configured(`${h.project}-two`), configured(`${h.project}-two`)]);
      await h.store.append(one, 0, [configured(`${h.project}-one`)]);

      const found = await h.queries.projectStreams(`prj-${h.project}-`);

      expect(found).toEqual([one, two]);
    });

    it("answers nothing, rather than everything, for a prefix nothing matches", async () => {
      const h = await make();
      expect(await h.queries.projectStreams(`prj-${h.project}-absent-`)).toEqual([]);
    });

    // ------------------------------------------------ endedWithoutEndActions ----

    it("finds a landed item whose run planned end actions and resolved none", async () => {
      const h = await make();
      const item = workItemStream(h.project, 301);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });
      await h.store.append(item, 0, [landed()]);

      const found = await h.queries.endedWithoutEndActions();

      expect(found).toContainEqual({ streamId: item, outcome: "landed" });
    });

    it("says nothing about an item that resolved the point for the outcome it reached", async () => {
      const h = await make();
      const item = workItemStream(h.project, 302);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });
      await h.store.append(item, 0, [landed(), resolved("landed")]);

      expect((await h.queries.endedWithoutEndActions()).map((f) => f.streamId)).not.toContain(item);
    });

    /**
     * The widening 0044 and the resolver's own per-outcome dedupe make
     * necessary: an item blocked, unblocked and then landed has a resolution,
     * and it is not this one. An implementation that asked only *whether* an
     * `EndActionsResolved` exists passes every other case here and misses this.
     */
    it("is not satisfied by a resolution for a different outcome", async () => {
      const h = await make();
      const item = workItemStream(h.project, 303);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });
      await h.store.append(item, 0, [resolved("blocked"), landed()]);

      expect(await h.queries.endedWithoutEndActions()).toContainEqual({
        streamId: item,
        outcome: "landed",
      });
    });

    /** A close is a terminal outcome too (0044), and it reaches `end` as one. */
    it("reports a closed item as closed, not as landed", async () => {
      const h = await make();
      const item = workItemStream(h.project, 304);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });
      await h.store.append(item, 0, [closed()]);

      expect(await h.queries.endedWithoutEndActions()).toContainEqual({
        streamId: item,
        outcome: "closed",
      });
    });

    /** The last ending, not the first: an item that landed and was then closed ended closed. */
    it("takes the ending the item actually reached last", async () => {
      const h = await make();
      const item = workItemStream(h.project, 305);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });
      await h.store.append(item, 0, [landed(), closed()]);

      const found = (await h.queries.endedWithoutEndActions()).filter((f) => f.streamId === item);

      expect(found).toEqual([{ streamId: item, outcome: "closed" }]);
    });

    /**
     * The distinction the whole model rests on: *nothing was configured* and
     * *something was configured and did not run* must not look the same.
     */
    it("says nothing about an item whose run planned nothing at end", async () => {
      const h = await make();
      const item = workItemStream(h.project, 306);
      h.note?.(item);
      await run(h, item, { proposed: ["build"] });
      await h.store.append(item, 0, [landed()]);

      expect((await h.queries.endedWithoutEndActions()).map((f) => f.streamId)).not.toContain(item);
    });

    it("says nothing about an item that has not ended", async () => {
      const h = await make();
      const item = workItemStream(h.project, 307);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });

      expect((await h.queries.endedWithoutEndActions()).map((f) => f.streamId)).not.toContain(item);
    });

    // ----------------------------------------------- landedWithoutGatePoints ----

    const RAN = ["GatePassed", "GateFailed", "GateWaived", "ApprovalGranted"];

    it("finds a change that merged past a point the recipe configured", async () => {
      const h = await make();
      const item = workItemStream(h.project, 401);
      h.note?.(item);
      const runId = await run(h, item, { proposed: ["build"], merge: ["approval"] }, [
        { gate: "proposed", action: "build" },
      ]);
      await h.store.append(item, 0, [landed()]);

      const found = (await h.queries.landedWithoutGatePoints(RAN)).filter(
        (f) => f.workItemId === item,
      );

      expect(found).toEqual([{ workItemId: item, runId, gate: "merge" }]);
    });

    it("says nothing when every planned point recorded a verdict", async () => {
      const h = await make();
      const item = workItemStream(h.project, 402);
      h.note?.(item);
      await run(h, item, { proposed: ["build"], merge: ["approval"] }, [
        { gate: "proposed", action: "build" },
        { gate: "merge", action: "approval" },
      ]);
      await h.store.append(item, 0, [landed()]);

      expect((await h.queries.landedWithoutGatePoints(RAN)).map((f) => f.workItemId)).not.toContain(
        item,
      );
    });

    it("names every point that was skipped, one row each", async () => {
      const h = await make();
      const item = workItemStream(h.project, 403);
      h.note?.(item);
      await run(h, item, { prepared: ["install"], proposed: ["build"], merge: ["approval"] });
      await h.store.append(item, 0, [landed()]);

      const found = (await h.queries.landedWithoutGatePoints(RAN))
        .filter((f) => f.workItemId === item)
        .map((f) => f.gate);

      expect(found.sort()).toEqual(["merge", "prepared", "proposed"]);
    });

    /** `end`'s record is on the item's stream, and the query above is the one that can see it. */
    it("leaves the end point to the question that can see it", async () => {
      const h = await make();
      const item = workItemStream(h.project, 404);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });
      await h.store.append(item, 0, [landed()]);

      expect((await h.queries.landedWithoutGatePoints(RAN)).map((f) => f.workItemId)).not.toContain(
        item,
      );
    });

    /**
     * The last run of the item, because one that failed early and landed on a
     * second attempt has a first run that legitimately stopped at `prepared`.
     */
    it("judges the last run of an item, not an earlier one that stopped early", async () => {
      const h = await make();
      const item = workItemStream(h.project, 405);
      h.note?.(item);
      await run(h, item, { proposed: ["build"], merge: ["approval"] });
      const second = await run(h, item, { proposed: ["build"], merge: ["approval"] }, [
        { gate: "proposed", action: "build" },
        { gate: "merge", action: "approval" },
      ]);
      await h.store.append(item, 0, [landed()]);

      const found = (await h.queries.landedWithoutGatePoints(RAN)).filter(
        (f) => f.workItemId === item,
      );

      expect(found).toEqual([]);
      expect(second).toMatch(/^run-/);
    });

    it("says nothing about an item that has not landed", async () => {
      const h = await make();
      const item = workItemStream(h.project, 406);
      h.note?.(item);
      await run(h, item, { merge: ["approval"] });

      expect((await h.queries.landedWithoutGatePoints(RAN)).map((f) => f.workItemId)).not.toContain(
        item,
      );
    });

    /**
     * `ranTypes` is the caller's list and the store must use it rather than one
     * of its own — the whole reason it is a parameter.
     */
    it("counts only the event types it was given as proof", async () => {
      const h = await make();
      const item = workItemStream(h.project, 407);
      h.note?.(item);
      await run(h, item, { merge: ["approval"] }, [{ gate: "merge", action: "approval" }]);
      await h.store.append(item, 0, [landed()]);

      const withGatePassed = (await h.queries.landedWithoutGatePoints(RAN)).filter(
        (f) => f.workItemId === item,
      );
      const without = (await h.queries.landedWithoutGatePoints(["ApprovalGranted"])).filter(
        (f) => f.workItemId === item,
      );

      expect(withGatePassed).toEqual([]);
      expect(without.map((f) => f.gate)).toEqual(["merge"]);
    });
  });
}
