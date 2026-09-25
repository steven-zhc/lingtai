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
 * - `integration/queries.test.ts` runs it against `createPostgresLogQueries`, where a
 *   database is available. That run is what says the SQL is really the SQL.
 * - `integration/sqlite.test.ts` runs it against `createSqliteLogQueries`, with
 *   nothing installed — the machine
 *   [#179](https://github.com/steven-zhc/lingtai/issues/179) exists for.
 *
 * **Every assertion is a negative one made positive.** Each question is an
 * anti-join: *which items landed past a point that was configured and did not
 * run*. The failure that matters is not a wrong row but a silent empty answer,
 * so every case here seeds both an offender and a near-miss and checks that the
 * offender comes back and the near-miss does not.
 */
import { STEPS, parsePayload, workItemStream } from "@lingtai/domain";
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

/**
 * All ten steps, with actions only where a case asks for them.
 *
 * From `STEPS` rather than a list here: `GatesResolved` asserts `.length(10)`,
 * so a fixture with its own copy of the names would be a schema failure the
 * day the set changes rather than a test that moved with it.
 */
const plan = (steps: Record<string, string[]>) =>
  STEPS.map((step) => ({ gate: step, actions: steps[step] ?? [] }));

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
    steps: Record<string, string[]>,
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
        data: parsePayload("GatesResolved", { runId, configHash: "seeded", points: plan(steps) }),
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

    // ----------------------------------------------- landedWithoutSteps ----

    const RAN = ["GatePassed", "GateFailed", "GateWaived", "ApprovalGranted"];

    it("finds a change that merged past a point the recipe configured", async () => {
      const h = await make();
      const item = workItemStream(h.project, 401);
      h.note?.(item);
      const runId = await run(h, item, { proposed: ["build"], merge: ["approval"] }, [
        { gate: "proposed", action: "build" },
      ]);
      await h.store.append(item, 0, [landed()]);

      const found = (await h.queries.landedWithoutSteps(RAN)).filter(
        (f) => f.workItemId === item,
      );

      expect(found).toEqual([{ workItemId: item, runId, step: "merge" }]);
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

      expect((await h.queries.landedWithoutSteps(RAN)).map((f) => f.workItemId)).not.toContain(
        item,
      );
    });

    it("names every point that was skipped, one row each", async () => {
      const h = await make();
      const item = workItemStream(h.project, 403);
      h.note?.(item);
      await run(h, item, { prepared: ["install"], proposed: ["build"], merge: ["approval"] });
      await h.store.append(item, 0, [landed()]);

      const found = (await h.queries.landedWithoutSteps(RAN))
        .filter((f) => f.workItemId === item)
        .map((f) => f.step);

      expect(found.sort()).toEqual(["merge", "prepared", "proposed"]);
    });

    /** `end`'s record is on the item's stream, and the query above is the one that can see it. */
    it("leaves the end point to the question that can see it", async () => {
      const h = await make();
      const item = workItemStream(h.project, 404);
      h.note?.(item);
      await run(h, item, { end: ["close the ticket"] });
      await h.store.append(item, 0, [landed()]);

      expect((await h.queries.landedWithoutSteps(RAN)).map((f) => f.workItemId)).not.toContain(
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

      const found = (await h.queries.landedWithoutSteps(RAN)).filter(
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

      expect((await h.queries.landedWithoutSteps(RAN)).map((f) => f.workItemId)).not.toContain(
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

      const withStepPassed = (await h.queries.landedWithoutSteps(RAN)).filter(
        (f) => f.workItemId === item,
      );
      const without = (await h.queries.landedWithoutSteps(["ApprovalGranted"])).filter(
        (f) => f.workItemId === item,
      );

      expect(withStepPassed).toEqual([]);
      expect(without.map((f) => f.step)).toEqual(["merge"]);
    });

    // ---------------------------------------------------------- typeCounts ----

    /**
     * **The pair the two collations disagree about is seeded, not waited for.**
     *
     * `IssueUpdated` and `IssueUpdateFailed` are the near-miss for *in type
     * order*: under the `en_US.UTF-8` a Supabase database is created with,
     * Postgres weighs `IssueUpdated` first — the primary weights run
     * `…update`, then `d` before `f` — while byte order, which is SQLite's
     * BINARY and `.sort()`'s, puts `IssueUpdateFailed` first (`F` 0x46 < `d`
     * 0x64). Without both rows in the log the assertion was true of either
     * store by accident, and red on the Postgres run whenever some other test
     * had left the pair in the shared database.
     */
    it("counts the rows of each type it holds, in byte order of the type", async () => {
      const h = await make();
      const item = workItemStream(h.project, 501);
      h.note?.(item);
      // Failed then updated, on one change: converged, so `unconvergedUpdates`
      // below goes on saying nothing about this item.
      const update = (type: "IssueUpdated" | "IssueUpdateFailed") => ({
        type,
        actor: "conductor",
        data: parsePayload(
          type,
          type === "IssueUpdated"
            ? { project: h.project, issue: "501", change: "labels", detail: "set" }
            : { project: h.project, issue: "501", change: "labels", error: "403" },
        ),
      });
      await h.store.append(item, 0, [
        landed(),
        resolved("landed"),
        resolved("closed"),
        update("IssueUpdateFailed"),
        update("IssueUpdated"),
      ]);

      const counts = await h.queries.typeCounts();
      const byType = new Map(counts.map((c) => [c.type, c.rows]));

      // A shared database holds other tests' rows too, so the assertion is on
      // this log holding *at least* what was just put in it — and on the shape,
      // which is what a caller reads.
      expect(byType.get("WorkItemLanded") ?? 0).toBeGreaterThanOrEqual(1);
      expect(byType.get("EndActionsResolved") ?? 0).toBeGreaterThanOrEqual(2);
      expect(counts.map((c) => c.type)).toEqual([...counts.map((c) => c.type)].sort());
      // And the pair, named: one order for both stores, or this contract means
      // two different things by the same word.
      const names = counts.map((c) => c.type);
      expect(names.indexOf("IssueUpdateFailed")).toBeGreaterThanOrEqual(0);
      expect(names.indexOf("IssueUpdateFailed")).toBeLessThan(names.indexOf("IssueUpdated"));
      for (const c of counts) expect(Number.isInteger(c.rows)).toBe(true);
    });

    // ------------------------------------------------- unconvergedUpdates ----

    const said = (type: "IssueUpdated" | "IssueUpdateFailed", project: string, issue: string, change: string) => ({
      type,
      actor: "conductor",
      data: parsePayload(
        type,
        type === "IssueUpdated"
          ? { project, issue, change, detail: "set" }
          : { project, issue, change, error: "403" },
      ),
    });

    it("finds an issue whose last word about a change was a failure", async () => {
      const h = await make();
      const item = workItemStream(h.project, 502);
      h.note?.(item);
      await h.store.append(item, 0, [said("IssueUpdateFailed", h.project, "502", "labels")]);

      expect(await h.queries.unconvergedUpdates()).toContainEqual({
        project: h.project,
        issue: "502",
        change: "labels",
      });
    });

    /** Only the last one is the state of the world: the log keeps both. */
    it("says nothing about a failure a later attempt fixed", async () => {
      const h = await make();
      const item = workItemStream(h.project, 503);
      h.note?.(item);
      await h.store.append(item, 0, [
        said("IssueUpdateFailed", h.project, "503", "labels"),
        said("IssueUpdated", h.project, "503", "labels"),
      ]);

      expect(await h.queries.unconvergedUpdates()).not.toContainEqual({
        project: h.project,
        issue: "503",
        change: "labels",
      });
    });

    /**
     * The near-miss that a join on the issue alone would swallow: the same
     * issue converged on one change and not on another.
     */
    it("is per change, not per issue", async () => {
      const h = await make();
      const item = workItemStream(h.project, 504);
      h.note?.(item);
      await h.store.append(item, 0, [
        said("IssueUpdateFailed", h.project, "504", "comment"),
        said("IssueUpdated", h.project, "504", "labels"),
      ]);

      const found = (await h.queries.unconvergedUpdates()).filter((u) => u.issue === "504");
      expect(found).toEqual([{ project: h.project, issue: "504", change: "comment" }]);
    });

    /** A success that came *before* the failure converges nothing. */
    it("is not satisfied by a success older than the failure", async () => {
      const h = await make();
      const item = workItemStream(h.project, 505);
      h.note?.(item);
      await h.store.append(item, 0, [
        said("IssueUpdated", h.project, "505", "closed"),
        said("IssueUpdateFailed", h.project, "505", "closed"),
      ]);

      expect(await h.queries.unconvergedUpdates()).toContainEqual({
        project: h.project,
        issue: "505",
        change: "closed",
      });
    });

    // ------------------------------------------------- subscriberFailures ----

    const failed = (name: string, reason: string) => ({
      type: "PluginFailed" as const,
      actor: "conductor",
      data: parsePayload("PluginFailed", {
        name,
        eventType: "WorkItemLanded",
        project: null,
        reason,
      }),
    });

    it("counts a subscriber's failures all-time and since the cutoff, with the latest reason", async () => {
      const h = await make();
      const item = workItemStream(h.project, 506);
      h.note?.(item);
      const name = `sub-${h.project}`;
      await h.store.append(item, 0, [failed(name, "first"), failed(name, "second")]);

      const [row] = (await h.queries.subscriberFailures(new Date(0))).filter((r) => r.name === name);

      expect(row).toEqual({ name, total: 2, recent: 2, lastReason: "second" });
    });

    /**
     * The cutoff is the whole of what `since` means, and the reason travels
     * with it: past the cutoff there is no *latest recent reason* to give.
     */
    it("keeps the all-time count and drops the recent one past the cutoff", async () => {
      const h = await make();
      const item = workItemStream(h.project, 507);
      h.note?.(item);
      const name = `sub-${h.project}-later`;
      await h.store.append(item, 0, [failed(name, "only")]);

      const [row] = (await h.queries.subscriberFailures(new Date(Date.now() + 60_000))).filter(
        (r) => r.name === name,
      );

      expect(row).toEqual({ name, total: 1, recent: 0, lastReason: null });
    });

    it("says nothing about a subscriber that never failed", async () => {
      const h = await make();
      const names = (await h.queries.subscriberFailures(new Date(0))).map((r) => r.name);
      expect(names).not.toContain(`sub-${h.project}-never`);
    });
  });
}
