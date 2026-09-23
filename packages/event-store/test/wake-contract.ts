/**
 * What a `Waker` is, stated once and run against every implementation (#177).
 *
 * The pattern is `contract.ts`'s, and so is the reason: a second waker held to
 * nothing is worth nothing. It was written while Postgres's was the only one,
 * so that the SQLite store arrived to a list it had to pass rather than one
 * drawn around whatever it happens to do.
 *
 * - `integration/subscribe.test.ts` runs it against `createPostgresWaker`, where a
 *   database is available.
 * - `integration/sqlite.test.ts` runs it against `createPollingWaker` (#178).
 * - `unit/wake.test.ts` runs it against a waker rung by hand beside the
 *   in-memory store — which proves the contract asks nothing of Postgres, not
 *   that any real store wakes.
 *
 * **It asserts only what a caller may rely on, and that is very little.** An
 * append made once a session is ready is followed by a nudge, and closing never
 * waits. Everything else is deliberately *allowed*: a nudge may be late, may
 * come twice, may come for nothing, and one nudge may stand for several appends.
 * The last test holds `subscribe` to that — it runs over this waker made
 * worse on purpose, and must still deliver each event once and in order. What
 * is Postgres's alone — a pooler that eats the `LISTEN`, a backend killed
 * mid-stream — stays in the Postgres suite.
 */
import type { Envelope } from "@lingtai/domain";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../src/event-store.ts";
import { subscribe } from "../src/subscribe.ts";
import type { Waker, WakeListener } from "../src/wake.ts";

export interface WakerHarness {
  /** A waker of its own, for this assertion. */
  waker: Waker;
  /** The store the waker wakes for, so a subscriber can read what it is nudged about. */
  store: EventStore;
  /**
   * Appends one event **from somewhere other than the waker** — for Postgres, a
   * different connection, which is the only shape 0009 accepts as proof — and
   * returns it.
   */
  append(title: string): Promise<Envelope>;
  /** The log's current head, so a subscriber can start from now. */
  head(): Promise<bigint>;
}

const WAIT_MS = 20_000;

async function eventually(predicate: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out after ${WAIT_MS}ms: ${what()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The waker made as bad as the contract allows: every nudge arrives late and
 * twice, and nudges for nothing arrive all the while. A subscriber that is
 * correct over this is correct over anything that keeps the contract.
 */
function unreliable(inner: Waker): Waker {
  return {
    open(listener: WakeListener) {
      const timers = new Set<NodeJS.Timeout>();
      const later = (ms: number) => {
        const t = setTimeout(() => {
          timers.delete(t);
          listener.nudge();
        }, ms);
        timers.add(t);
      };
      const session = inner.open({
        nudge: () => {
          later(120);
          later(180);
        },
        lost: (error) => listener.lost(error),
      });
      const spurious = setInterval(() => listener.nudge(), 40);
      return {
        ready: session.ready,
        close() {
          clearInterval(spurious);
          for (const t of timers) clearTimeout(t);
          timers.clear();
          session.close();
        },
      };
    },
  };
}

export function describeWakerContract(name: string, make: () => WakerHarness | Promise<WakerHarness>): void {
  describe(`${name}: the waker contract`, () => {
    it("nudges after an append made once it is ready", async () => {
      const h = await make();
      let nudges = 0;
      const session = h.waker.open({ nudge: () => void (nudges += 1), lost: () => {} });
      try {
        await session.ready;
        // Counted from here: anything before this was allowed to be spurious.
        const before = nudges;
        await h.append("wake-once");
        await eventually(
          () => nudges > before,
          () => "no nudge arrived after the append",
        );
      } finally {
        session.close();
      }
    });

    it("nudges again for a later append, not only the first", async () => {
      const h = await make();
      let nudges = 0;
      const session = h.waker.open({ nudge: () => void (nudges += 1), lost: () => {} });
      try {
        await session.ready;
        for (const title of ["wake-1", "wake-2", "wake-3"]) {
          const before = nudges;
          await h.append(title);
          await eventually(
            () => nudges > before,
            () => `no nudge arrived after ${title}`,
          );
        }
      } finally {
        session.close();
      }
    });

    it("closes without waiting, before it is ready, and twice", async () => {
      // `subscribe()` followed at once by `close()` once hung for ever, and a
      // daemon that cannot be stopped in its first second is one its supervisor
      // has to kill. `close` is synchronous so that it cannot be awaited into
      // that again.
      const h = await make();
      const session = h.waker.open({ nudge: () => {}, lost: () => {} });
      expect(session.close()).toBeUndefined();
      expect(() => session.close()).not.toThrow();
      // Whatever `ready` does now is the waker's business, and must not be an
      // unhandled rejection.
      await Promise.race([session.ready.catch(() => {}), new Promise((r) => setTimeout(r, 100))]);
    });

    it("is enough for a subscriber when its nudges are late, doubled and spurious", async () => {
      const h = await make();
      const seen: Envelope[] = [];
      const from = await h.head();
      const sub = subscribe({
        fromSeq: from,
        store: h.store,
        waker: unreliable(h.waker),
        onEvent: (e) => void seen.push(e),
      });
      try {
        await sub.caughtUp();
        const written: Envelope[] = [];
        for (let i = 0; i < 4; i++) {
          written.push(await h.append(`noisy-${i}`));
          // Some appends land inside the late window of the one before, so a
          // single nudge stands for two of them.
          if (i % 2 === 1) await new Promise((r) => setTimeout(r, 250));
        }
        const mine = () => seen.filter((e) => written.some((w) => w.seq === e.seq)).map((e) => e.seq);
        await eventually(
          () => mine().length >= written.length,
          () => `${mine().length} of ${written.length} events arrived`,
        );
        // Let the tail of late and spurious nudges run out before judging duplicates.
        await new Promise((r) => setTimeout(r, 400));
        // Once each, in order: a duplicate or a spurious nudge re-delivered nothing.
        expect(mine()).toEqual(written.map((e) => e.seq));
        expect(sub.lastSeq).toBeGreaterThanOrEqual(written[written.length - 1]!.seq);
        expect(sub.stopped).toBe(false);
      } finally {
        await sub.close();
      }
    });
  });
}
