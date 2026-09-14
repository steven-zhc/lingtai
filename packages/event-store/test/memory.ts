/**
 * An `EventStore` that keeps the log in an array (`#157`).
 *
 * ## Why this exists
 *
 * `#158` split the suite into the tests that need a database and the ones that
 * do not, and found 29 files in the first half. Most of them do not need one.
 * `waive.test.ts` is the pattern:
 *
 * ```ts
 * store = createEventStore(client);          // a real pg client
 * await store.append(workItemId, 0, [ … ]);
 * (await store.read(runId)).filter((e) => e.type === "GateWaived")
 * ```
 *
 * It appends events and reads them back. Nothing in it asserts anything about
 * Postgres — the database is being used as an event recorder, and a recorder is
 * the one thing that is cheap to write. What that costs today is that those
 * tests run over a cross-region pooler, where a dropped connection fails a gate
 * for a reason that has nothing to do with the diff (`#157`).
 *
 * ## Why you can trust it
 *
 * **Because a real test proves the real store behaves the same way.** A fake is
 * worth exactly the contract it is held to, so this is not held to a
 * hand-written list of behaviours: `test/contract.ts` states the contract once
 * and both stores are run against it — the real one in `test/` where a database
 * is available, this one in `pure/` where none is. A behaviour that only this
 * store has is a failing test, not a silent divergence.
 *
 * The properties that matter are the ones the callers rely on and would
 * otherwise only find out about in production:
 *
 * - **`UNIQUE (stream_id, version)`.** Appending at a version a stream has
 *   already passed throws `ConcurrencyError`. In Postgres that is an index; here
 *   it is a length check. The real test is what says the index is really there.
 * - **All or none.** A batch whose last event conflicts leaves none of the
 *   earlier ones behind. Postgres gets that from a transaction; this gets it by
 *   validating and checking the version before touching the array.
 * - **Validation before writing.** An unknown type, a retired one, a bad actor
 *   or a payload the schema refuses costs nothing and writes nothing.
 * - **`seq` is global and increasing**, across streams, in append order.
 *
 * ## What it is not
 *
 * It is not a Postgres. It does not enforce foreign keys, it has no
 * `LISTEN`/`NOTIFY`, no advisory locks and no transaction isolation between
 * concurrent callers — so the tests that assert *those* keep a real database
 * and stay in `test/`. That is the whole of the remaining DB half, and a
 * dropped connection there is worth failing on: those tests are about the
 * connection.
 */
import {
  Actor,
  type Envelope,
  SCHEMA_VER,
  StreamId,
  type ToAppend,
  isEventType,
  isRetiredEventType,
  parsePayload,
} from "@lingtai/domain";
// The narrow path, never the barrel. `../src/index.ts` constructs the
// process-wide client at import, so a fake store reached through it would
// require the database it exists to avoid — the trap this file is the answer
// to, and one it must not fall into itself.
import {
  ConcurrencyError,
  type EventStore,
  RetiredEventTypeError,
  UnknownEventTypeError,
} from "../src/event-store.ts";

export interface MemoryEventStore extends EventStore {
  /** Everything appended, in `seq` order. For a test that wants to assert on the log as a whole. */
  all(): Envelope[];
}

/**
 * A fresh, empty log.
 *
 * Per test rather than shared: the real store's isolation comes from each suite
 * writing to stream ids of its own, and a fake handed out as a singleton would
 * quietly give one test the events of the one before it.
 *
 * `now` is injectable for the same reason the projector's is (0027): a fold that
 * reads a clock is not a fold, and a test that asserts on `at` should not have
 * to wait.
 */
export function createMemoryEventStore(
  options: { now?: () => Date } = {},
): MemoryEventStore {
  const now = options.now ?? (() => new Date());
  const log: Envelope[] = [];
  let seq = 0n;

  const versionOf = (streamId: string): number =>
    log.reduce((max, e) => (e.streamId === streamId && e.version > max ? e.version : max), 0);

  return {
    async append(streamId, expectedVersion, events) {
      StreamId.parse(streamId);
      if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
        throw new RangeError(
          `expectedVersion must be a non-negative integer, got ${expectedVersion}`,
        );
      }
      if (events.length === 0) return [];

      // Everything validated before anything is written, which is the real
      // store's rule and its reason: a batch must not be able to fail halfway
      // through validation with rows already in the log.
      const rows = events.map((e: ToAppend, i) => {
        if (!isEventType(e.type)) throw new UnknownEventTypeError(e.type, "append");
        if (isRetiredEventType(e.type)) throw new RetiredEventTypeError(e.type);
        Actor.parse(e.actor);
        return {
          streamId,
          version: expectedVersion + 1 + i,
          type: e.type,
          schemaVer: e.schemaVer ?? SCHEMA_VER[e.type],
          data: parsePayload(e.type, e.data),
          actor: e.actor,
          causation: e.causation ?? null,
        };
      });

      // `UNIQUE (stream_id, version)`, as a length check. Postgres raises this
      // on the insert; here it is asked before, which is the same answer for a
      // single writer and is all a test has.
      const at = versionOf(streamId);
      if (at !== expectedVersion) {
        throw new ConcurrencyError(
          streamId,
          expectedVersion,
          rows.map((r) => r.version),
        );
      }

      const written = rows.map((r) => {
        seq += 1n;
        return { ...r, seq, at: now() } as Envelope;
      });
      log.push(...written);
      return written;
    },

    async read(streamId, fromVersion = 1) {
      return log
        .filter((e) => e.streamId === streamId && e.version >= fromVersion)
        .sort((a, b) => a.version - b.version);
    },

    async readAll(fromSeq, limit) {
      return log.filter((e) => e.seq > fromSeq).slice(0, limit);
    },

    all() {
      return [...log];
    },
  };
}
