/**
 * What an `EventStore` is, stated once and run against every implementation.
 *
 * **This file is why the in-memory store can be trusted** (`#157`). A fake is
 * worth exactly the contract it is held to, and a fake held to a hand-written
 * list of behaviours drifts the moment the real thing changes and nobody
 * notices. So the behaviours are written down here, once, and both stores are
 * run against them:
 *
 * - `test/event-store.test.ts` runs it against Postgres, where a database is
 *   available. That run is what says the `UNIQUE (stream_id, version)` index
 *   really exists and really raises.
 * - `pure/memory.test.ts` runs it against `createMemoryEventStore`, where none
 *   is. That run is what says the fake answers the same way.
 * - `pure/sqlite.test.ts` runs it against `createSqliteEventStore` (#178), a
 *   real store in a file, where its own `UNIQUE (stream_id, version)` is what
 *   raises.
 *
 * A behaviour only one of them has is a failing test rather than a silent
 * divergence — which is the whole of the argument for moving a test off the
 * database. The contract is small on purpose: what is in here is what a caller
 * may rely on from *any* store, and everything else — `LISTEN`/`NOTIFY`,
 * advisory locks, isolation between concurrent writers — is Postgres-only and
 * stays in tests that keep a real one.
 */
import { describe, expect, it } from "vitest";
import { ConcurrencyError, type EventStore } from "../src/event-store.ts";

const claimed = (runId: string) => ({
  type: "WorkItemClaimed" as const,
  actor: "conductor",
  data: { runId, worker: "test", title: null, kind: null },
});

/**
 * `make` returns a store to test. Called once per assertion, so an
 * implementation that keeps its log in memory gets a clean one each time and
 * the Postgres one gets the same client — the isolation there is the fresh
 * stream id, as it is for every other suite in this package.
 *
 * **`freshStream` comes from the caller, and that is not a detail.** A stream
 * id invented here would not be registered with `support.ts`, whose
 * `cleanupStreams` deletes exactly the ids it handed out — so every run would
 * leave streams in the test log that nothing removes, and the teardown says so
 * rather than silently accumulating them. The Postgres caller passes
 * `streamId()`; the in-memory one passes anything, because its log is thrown
 * away with the test. `support.ts` cannot be imported here: it reads
 * `directDatabaseUrl()`, which is the database this contract exists to let a
 * caller do without.
 */
export function describeEventStoreContract(
  name: string,
  make: () => EventStore | Promise<EventStore>,
  freshStream: () => string,
): void {
  const store = async () => await make();

  describe(`${name}: the event store contract`, () => {
    it("writes a new stream from version 1", async () => {
      const s = await store();
      const id = freshStream();

      const written = await s.append(id, 0, [claimed("run-1")]);

      expect(written.map((e) => e.version)).toEqual([1]);
      expect(written[0]?.streamId).toBe(id);
      expect(written[0]?.type).toBe("WorkItemClaimed");
    });

    it("numbers a batch in the order it was given", async () => {
      const s = await store();
      const id = freshStream();

      const written = await s.append(id, 0, [claimed("run-1"), claimed("run-2")]);

      expect(written.map((e) => e.version)).toEqual([1, 2]);
      expect(written.map((e) => (e.data as { runId: string }).runId)).toEqual(["run-1", "run-2"]);
    });

    it("refuses a stream that has moved", async () => {
      // `UNIQUE (stream_id, version)`, which is the whole of the concurrency
      // model: two writers that read the same version cannot both append.
      const s = await store();
      const id = freshStream();
      await s.append(id, 0, [claimed("run-1")]);

      await expect(s.append(id, 0, [claimed("run-2")])).rejects.toThrow(ConcurrencyError);
    });

    it("leaves nothing behind when a batch conflicts", async () => {
      // All or none. The first event of this batch would be legal on its own;
      // what must not happen is that it lands and the second does not.
      const s = await store();
      const id = freshStream();
      await s.append(id, 0, [claimed("run-1")]);

      await expect(s.append(id, 0, [claimed("run-2"), claimed("run-3")])).rejects.toThrow(
        ConcurrencyError,
      );

      const back = await s.read(id);
      expect(back.map((e) => (e.data as { runId: string }).runId)).toEqual(["run-1"]);
    });

    it("writes nothing when the batch has a bad event in it", async () => {
      // Validated before anything is written, so a rejected payload costs
      // nothing — and, more to the point, cannot leave the events before it in
      // the batch written.
      const s = await store();
      const id = freshStream();

      await expect(
        s.append(id, 0, [claimed("run-1"), { type: "NoSuchEvent", actor: "conductor", data: {} }]),
      ).rejects.toThrow();

      expect(await s.read(id)).toEqual([]);
    });

    it("refuses an actor the envelope does not allow", async () => {
      const s = await store();
      const id = freshStream();

      await expect(s.append(id, 0, [{ ...claimed("run-1"), actor: "" }])).rejects.toThrow();
    });

    it("refuses a negative expected version", async () => {
      const s = await store();

      await expect(s.append(freshStream(), -1, [claimed("run-1")])).rejects.toThrow(RangeError);
    });

    it("appends nothing for an empty batch", async () => {
      const s = await store();
      const id = freshStream();

      expect(await s.append(id, 0, [])).toEqual([]);
      expect(await s.read(id)).toEqual([]);
    });

    it("reads one stream in version order, and only that stream", async () => {
      const s = await store();
      const mine = freshStream();
      const other = freshStream();
      await s.append(mine, 0, [claimed("run-1"), claimed("run-2")]);
      await s.append(other, 0, [claimed("run-3")]);

      const back = await s.read(mine);

      expect(back.map((e) => e.version)).toEqual([1, 2]);
      expect(back.every((e) => e.streamId === mine)).toBe(true);
    });

    it("reads from a version, inclusive", async () => {
      const s = await store();
      const id = freshStream();
      await s.append(id, 0, [claimed("run-1"), claimed("run-2"), claimed("run-3")]);

      expect((await s.read(id, 2)).map((e) => e.version)).toEqual([2, 3]);
    });

    it("gives seq to the whole log, increasing in append order", async () => {
      // The projection catch-up read depends on this and on nothing else: a
      // checkpoint is a `seq`, and `readAll` from it must not go backwards.
      const s = await store();
      const a = freshStream();
      const b = freshStream();
      const first = await s.append(a, 0, [claimed("run-1")]);
      const second = await s.append(b, 0, [claimed("run-2")]);

      expect(second[0]!.seq).toBeGreaterThan(first[0]!.seq);

      const after = await s.readAll(first[0]!.seq, 100);
      expect(after.map((e) => e.seq)).toEqual([...after.map((e) => e.seq)].sort((x, y) => (x < y ? -1 : 1)));
      expect(after.some((e) => e.seq === second[0]!.seq)).toBe(true);
      expect(after.some((e) => e.seq === first[0]!.seq)).toBe(false);
    });

    it("honours the limit on the global read", async () => {
      const s = await store();
      const id = freshStream();
      const before = await s.readAll(0n, 1);
      await s.append(id, 0, [claimed("run-1"), claimed("run-2"), claimed("run-3")]);

      expect(before.length).toBeLessThanOrEqual(1);
      expect((await s.readAll(0n, 2)).length).toBeLessThanOrEqual(2);
    });

    it("stamps every event with a time", async () => {
      const s = await store();
      const id = freshStream();

      const [written] = await s.append(id, 0, [claimed("run-1")]);

      expect(written!.at).toBeInstanceOf(Date);
      expect(Number.isNaN(written!.at.getTime())).toBe(false);
    });
  });
}
