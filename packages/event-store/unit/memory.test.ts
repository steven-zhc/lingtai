/**
 * The in-memory store, held to the same contract as Postgres (`#157`).
 *
 * This file opens no connection, which is the point: it sits in `unit/` and
 * runs at the `build` gate. Its twin, `integration/event-store.test.ts`, runs
 * the same contract against a real database, after the merge. Neither is the
 * authority on its own — the pair is. A behaviour the fake has and Postgres
 * does not fails there; a behaviour Postgres has and the fake does not fails
 * here.
 */
import { describe, expect, it } from "vitest";
import { describeEventStoreContract } from "../test/contract.ts";
import { createMemoryEventStore } from "../test/memory.ts";

// Any id will do: this log is thrown away with the test, so there is nothing
// to clean up and no `support.ts` to register with.
let n = 0;
describeEventStoreContract("in memory", () => createMemoryEventStore(), () => `wi-mem-${n++}`);

/**
 * What only the fake has, and what a caller may therefore not rely on.
 *
 * Kept beside the contract rather than inside it: these are conveniences for
 * tests, not promises an `EventStore` makes. Anything asserted here is
 * deliberately *not* asserted of Postgres.
 */
describe("in memory: what is not in the contract", () => {
  it("starts empty, per store", () => {
    // Per test rather than shared. A singleton fake would quietly hand one test
    // the events of the one before it, which is the failure mode the real
    // store avoids by giving each suite stream ids of its own.
    expect(createMemoryEventStore().all()).toEqual([]);
  });

  it("hands back the whole log, in append order", async () => {
    const s = createMemoryEventStore();
    await s.append("wi-p-1", 0, [{ type: "WorkItemClaimed", actor: "conductor", data: { runId: "run-1", worker: "t", title: null, kind: null } }]);
    await s.append("wi-p-2", 0, [{ type: "WorkItemClaimed", actor: "conductor", data: { runId: "run-2", worker: "t", title: null, kind: null } }]);

    expect(s.all().map((e) => e.streamId)).toEqual(["wi-p-1", "wi-p-2"]);
  });

  it("takes a clock, so a test need not wait for one", async () => {
    // The same rule the projector follows (0027): a fold that reads a clock is
    // not a fold. Here it is so that `at` can be asserted on exactly.
    const at = new Date("2026-09-14T12:00:00.000Z");
    const s = createMemoryEventStore({ now: () => at });

    const [written] = await s.append("wi-p-1", 0, [
      { type: "WorkItemClaimed", actor: "conductor", data: { runId: "run-1", worker: "t", title: null, kind: null } },
    ]);

    expect(written!.at).toEqual(at);
  });
});
