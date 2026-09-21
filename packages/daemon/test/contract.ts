/**
 * What a `DaemonStore` is, stated once and run against every implementation.
 *
 * **This file is why there can be two of them** (#220). An interface with one
 * implementation is a shape; an interface with two and no contract is a pair of
 * codebases that agree until the day they do not. So the behaviours are written
 * down here, once, and both stores are run against them:
 *
 * - `test/daemon-store.test.ts` runs it against Postgres, where a database is
 *   available. That run is what says the beacon `lingtai doctor` and the board
 *   read answers this way.
 * - `pure/sqlite.test.ts` runs it against `createSqliteDaemonStore`, where none
 *   is. That run is what says a laptop with nothing installed can be asked
 *   whether a daemon is up.
 *
 * ## It asserts a *mutable row*, and none of the event store's contract transfers
 *
 * `event-store/test/contract.ts` is about append-and-replay: nothing it says is
 * true of `daemon_status`, which is one row that is written over. So what is
 * asserted here is what a beacon has to be:
 *
 * - **liveness** — a beat lands and a later read sees it, near enough to now
 *   that `lastBeat` calls it up;
 * - **last-write-wins** — one row, and the last word written is the word read,
 *   whichever process wrote it. The row's *beginning* survives the overwriting,
 *   which is what makes a beat an update of a running daemon rather than a new
 *   life for it;
 * - **stopped is not never-started** — a daemon that died leaves a row that has
 *   gone stale, and a machine where none has ever run has no row at all. Both
 *   are ordinary answers, and every reader of this row — two `doctor` rows,
 *   three chips on the board — says a different sentence about each.
 *
 * ## And the control stream beside it, because they are one question
 *
 * *Is a daemon up* is the beacon; *is it being told anything* is the log. The
 * store names which log, so the watermark (`#159`) — the reason a fresh daemon
 * ignores a drain that was already acted on — is asserted here too, against
 * whichever log the implementation under test carries.
 *
 * Written against **properties, not a database**: nothing below names a
 * dialect, a connection or a driver. That is the rule that let
 * `event-store/test/contract.ts` be passed unchanged by a store written months
 * later (#178).
 */
import { describe, expect, it } from "vitest";
import {
  controlWatermark,
  startBeacon,
  pauseConductor,
  readControl,
  requestShutdownUnlessStanding,
  resumeConductor,
  withdrawShutdown,
} from "../src/control.ts";
import { STALE_AFTER_MS, lastBeat, type Beat, type DaemonStore } from "../src/store.ts";

export interface DaemonFixture {
  /** The store under test. */
  store: DaemonStore;
  /** A second store over the same beacon and the same log — what "two processes" means. */
  another(): Promise<DaemonStore>;
  /**
   * Removes the beacon's row, leaving the state a machine is in before any
   * daemon has ever run.
   *
   * A fixture's rather than the contract's, because "no row" is the one thing
   * this interface cannot express: a store writes beats and reads them, and
   * nothing in it deletes. Postgres shares one row with the rest of the suite,
   * so a test that left one behind would tell the next file a daemon is up.
   */
  forget(): Promise<void>;
  /**
   * A `like` pattern matching every stream `stream()` hands out, and nothing
   * else in the log.
   *
   * The fixture's, because only it knows what it named its throwaway project —
   * and `streams()` is asked in exactly this shape by `reconcile`.
   */
  prefix: string;
  /** A work-item stream id nothing else in the log uses. */
  stream(issue: number): string;
  /** Closes everything this fixture opened. */
  close(): Promise<void>;
}

/** A beat with everything named, so an assertion can be about one field. */
function beating(over: Partial<Beat> = {}): Beat {
  return {
    pid: 4242,
    host: "contract-host",
    state: "up",
    currentRunId: null,
    codeSha: null,
    codeDirty: false,
    ...over,
  };
}

const claimed = (runId: string) => ({
  type: "WorkItemClaimed",
  actor: "conductor",
  data: { runId, worker: "local:1", title: null, kind: "bug" },
});

export function describeDaemonStoreContract(
  name: string,
  open: () => Promise<DaemonFixture>,
): void {
  /** Opened per assertion: a store that leaked between them would hide a leak. */
  async function withStore<T>(fn: (f: DaemonFixture) => Promise<T>): Promise<T> {
    const fixture = await open();
    try {
      await fixture.store.create();
      // Every assertion starts where a fresh machine does: the table exists and
      // nothing has beaten. Postgres shares one row with the rest of the suite,
      // so this is what makes the order of these tests not matter.
      await fixture.forget();
      return await fn(fixture);
    } finally {
      await fixture.forget().catch(() => {});
      await fixture.close().catch(() => {});
    }
  }

  describe(`${name}: the beacon`, () => {
    it("has no row until something beats, and says so rather than guessing", async () => {
      await withStore(async ({ store }) => {
        expect(await store.status()).toBeNull();
      });
    });

    it("lands a beat that a later read sees, and reads as up", async () => {
      await withStore(async ({ store }) => {
        await store.beat(beating({ state: "starting", currentRunId: "run-1", codeSha: "abc1234" }));

        const status = await store.status();
        expect(status).not.toBeNull();
        expect(status!.pid).toBe(4242);
        expect(status!.host).toBe("contract-host");
        expect(status!.state).toBe("starting");
        expect(status!.currentRunId).toBe("run-1");
        expect(status!.codeSha).toBe("abc1234");
        expect(status!.codeDirty).toBe(false);
        // The whole point of the row: `lingtai doctor` and the board's health
        // dot decide on the age, and the age has to be near enough to now.
        expect(lastBeat(status!).up).toBe(true);
        expect(lastBeat(status!).state).toBe("starting");
      });
    });

    it("carries a dirty worktree and an absent commit back exactly as written", async () => {
      // `code_dirty` is a boolean in one store and an integer in the other, and
      // `code_sha` is null on every daemon older than #98. Both are read by
      // `daemon: currency` to decide whether a restart is owed.
      await withStore(async ({ store }) => {
        await store.beat(beating({ codeSha: "def5678", codeDirty: true }));
        expect((await store.status())!.codeDirty).toBe(true);

        await store.beat(beating({ codeSha: null, codeDirty: false }));
        const later = await store.status();
        expect(later!.codeSha).toBeNull();
        expect(later!.codeDirty).toBe(false);
      });
    });

    it("keeps the last word, whichever process wrote it, and one row for all of them", async () => {
      await withStore(async (fixture) => {
        const { store } = fixture;
        await store.beat(beating({ state: "starting" }));
        const first = await store.status();

        const second = await fixture.another();
        try {
          await second.beat(beating({ state: "draining", pid: 9999, currentRunId: "run-2" }));
        } finally {
          await second.close();
        }

        // One row: the second process did not add a beacon of its own, it
        // overwrote the one there is. Two daemons cannot both be up — the
        // conductor lock sees to that — so a second row would be a lie.
        const status = await store.status();
        expect(status!.state).toBe("draining");
        expect(status!.pid).toBe(9999);
        expect(status!.currentRunId).toBe("run-2");
        // And the row's beginning survives the overwriting. `started_at` is
        // what makes a beat an update of a running daemon rather than a new
        // life for it.
        expect(status!.startedAt.getTime()).toBe(first!.startedAt.getTime());
        // Beating moves, because that is the only field liveness is read from.
        expect(status!.lastSeenAt.getTime()).toBeGreaterThanOrEqual(first!.lastSeenAt.getTime());
      });
    });

    it("tells a daemon that stopped from one that never started", async () => {
      await withStore(async ({ store }) => {
        // Never started: no row at all, and a reader says "no daemon has run —
        // lingtai run works by hand".
        expect(await store.status()).toBeNull();

        // Stopped: a row, holding the word the process last said, and stale.
        // The clock is the reader's, so this needs no wait — what the contract
        // asserts is that the *row* carries enough to decide it.
        await store.beat(beating({ state: "stopping" }));
        const status = await store.status();
        expect(status).not.toBeNull();

        const later = status!.lastSeenAt.getTime() + STALE_AFTER_MS + 1;
        const gone = lastBeat(status!, later);
        expect(gone.up).toBe(false);
        // Still carried: `stopping` is a daemon that was told to go and
        // `starting` one that died on the way up, and `doctor` says which.
        expect(gone.state).toBe("stopping");
      });
    });

    it("stops beating when the process holding it stops, and leaves its last word", async () => {
      // The beacon is the one timer in the system, and what a *killed* daemon
      // looks like is this: the row stops moving and goes stale, carrying the
      // word the process last said. Run here rather than only against Postgres
      // (`beacon.test.ts`) because it is the whole of how either store reports
      // a daemon that is gone.
      await withStore(async ({ store }) => {
        const beacon = startBeacon("up", { store, every: 50 });
        await beacon.stop("stopping");

        const stopped = await store.status();
        expect(stopped!.state).toBe("stopping");

        // Two ticks' worth of the period it was started with. Nothing writes,
        // because the timer went with the process.
        await new Promise((resolve) => setTimeout(resolve, 200));
        const later = await store.status();
        expect(later!.lastSeenAt.getTime()).toBe(stopped!.lastSeenAt.getTime());
        expect(later!.state).toBe("stopping");

        // And a reader past the threshold calls it down — which is the only
        // thing that can call it down, the word being what it *said*.
        expect(lastBeat(later!, later!.lastSeenAt.getTime() + STALE_AFTER_MS + 1).up).toBe(false);
      });
    });

    it("creates the row's table more than once without losing the row", async () => {
      // Called at every daemon start, so it has to be idempotent in the way
      // that matters: a start must not wipe what the last daemon said.
      await withStore(async ({ store }) => {
        await store.beat(beating({ state: "up" }));
        await store.create();
        expect((await store.status())!.state).toBe("up");
      });
    });
  });

  describe(`${name}: the log the control stream lives in`, () => {
    it("holds a pause until somebody lifts it", async () => {
      await withStore(async ({ store }) => {
        await pauseConductor("human:ada", "the queue is wrong", store.events);
        const paused = await readControl(store.events);
        expect(paused.paused).toBe(true);
        expect(paused.by).toBe("human:ada");
        expect(paused.reason).toBe("the queue is wrong");

        await resumeConductor("human:ada", store.events);
        expect((await readControl(store.events)).paused).toBe(false);
      });
    });

    it("hides what was said before the watermark from the daemon that read it", async () => {
      await withStore(async ({ store }) => {
        // A drain somebody asked of the *previous* daemon.
        await pauseConductor("human:ada", "before this process", store.events);

        // What a daemon reads once, before the lock, and keeps (#159).
        const since = await controlWatermark(store.events);

        // Its own view: nothing was said to *it*.
        expect((await readControl(store.events, since)).paused).toBe(false);
        // Everybody else's — the board, `doctor`, `status` — is the whole
        // stream, and there the pause is plainly standing.
        expect((await readControl(store.events)).paused).toBe(true);

        // And a pause appended after the watermark is this daemon's to obey.
        await pauseConductor("human:bob", "and this one is mine", store.events);
        const mine = await readControl(store.events, since);
        expect(mine.paused).toBe(true);
        expect(mine.by).toBe("human:bob");

        await resumeConductor("human:bob", store.events);
      });
    });

    it("asks for one drain at a time and withdraws the one it asked for", async () => {
      await withStore(async ({ store }) => {
        const asked = await requestShutdownUnlessStanding("human:ada", "restarting", null, store.events);
        expect(asked.asked).toBe(true);
        const version = asked.asked ? asked.version : 0;

        // A second ask finds the first standing and appends nothing over it:
        // the fold keeps the newest request, so hiding one would leave the
        // withdrawal below lifting a request nobody withdrew.
        const again = await requestShutdownUnlessStanding("human:bob", "me too", null, store.events);
        expect(again.asked).toBe(false);

        const lifted = await withdrawShutdown("human:ada", version, "it finished", store.events);
        expect(lifted.withdrew).toBe(true);
        expect((await readControl(store.events)).shutdown).toBeNull();
      });
    });
  });

  describe(`${name}: the log, as the daemon asks it`, () => {
    it("reports a head that has moved past everything appended", async () => {
      await withStore(async (fixture) => {
        const { store } = fixture;
        const before = await store.head();

        const written = await store.events.append(fixture.stream(1), 0, [claimed("run-a")]);
        const seq = written.at(-1)!.seq;

        const after = await store.head();
        expect(after).toBeGreaterThan(before);
        // The log's end, which is where a starting daemon subscribes from: an
        // answer below this would replay, and one above it would skip.
        expect(after).toBeGreaterThanOrEqual(seq);
      });
    });

    it("finds the streams that hold a named type, and no others", async () => {
      await withStore(async (fixture) => {
        const { store } = fixture;
        const claimedStream = fixture.stream(2);
        const landedStream = fixture.stream(3);
        await store.events.append(claimedStream, 0, [claimed("run-b")]);
        await store.events.append(landedStream, 0, [
          { type: "WorkItemLanded", actor: "conductor", data: { mergeCommit: "abc1234", base: "main" } },
        ]);

        const found = await store.streams({
          prefixes: [fixture.prefix],
          types: ["WorkItemClaimed"],
        });
        expect(found).toContain(claimedStream);
        expect(found).not.toContain(landedStream);

        // Ordered, because `reconcile` reports in this order and a report that
        // shuffles between passes is one nobody can diff.
        expect(found).toEqual([...found].sort());
      });
    });

    it("matches a prefix as SQL like does, case and all", async () => {
      // SQLite's `LIKE` folds ASCII case and Postgres's does not. Left alone,
      // the two stores would disagree about which work items a reconcile even
      // looks at — so this is the assertion that keeps `sqlite.ts`'s pragma
      // honest.
      await withStore(async (fixture) => {
        const { store } = fixture;
        const id = fixture.stream(4);
        await store.events.append(id, 0, [claimed("run-c")]);

        expect(
          await store.streams({ prefixes: [fixture.prefix], types: ["WorkItemClaimed"] }),
        ).toContain(id);
        expect(
          await store.streams({
            prefixes: [fixture.prefix.toUpperCase()],
            types: ["WorkItemClaimed"],
          }),
        ).toEqual([]);
      });
    });

    it("asks nothing of the log when there is nothing to ask", async () => {
      // `reconcile` runs with no projects registered on a fresh machine, and
      // `type = any('{}')` matches nothing — so the empty answer is returned
      // rather than paid for.
      await withStore(async ({ store }) => {
        expect(await store.streams({ prefixes: [], types: ["WorkItemClaimed"] })).toEqual([]);
        expect(await store.streams({ prefixes: ["wi-%"], types: [] })).toEqual([]);
      });
    });
  });
}
