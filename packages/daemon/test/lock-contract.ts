/**
 * What a `Locker` is, stated once and run against every implementation (#177).
 *
 * `packages/event-store/test/contract.ts` is the pattern, and its sentence is
 * the reason: a fake held to a hand-written contract is worth exactly the
 * contract it is held to. Written while Postgres's advisory lock was the only
 * locker, and passed unchanged by the file lock that replaced it (#193).
 *
 * Two promises, and they are the two #93 and 0027 stand on:
 *
 * - **One holder.** While a key is held, every other try on it is refused —
 *   from a different locker, as a second conductor would be, and from the same
 *   one.
 * - **Released when the holder dies.** Not released *by* it: a conductor that
 *   is SIGKILLed runs no `finally`, and a lock that outlives it keeps every
 *   later conductor out until somebody cleans up by hand. So the holder here is
 *   another process, and it is killed.
 *
 * `integration/file-lock.test.ts` runs it against `createFileLocker`. What is not every
 * locker's — who holds it without taking it, and the queue
 * `queueForDaemonLock` waits in — stays in that file below the contract.
 */
import { describe, expect, it } from "vitest";
import type { Locker } from "../src/lock.ts";

export interface LockerHarness {
  /** A locker of its own. Called more than once per assertion, and each is a separate would-be holder. */
  locker(): Locker;
  /** A key nobody else in the suite uses. */
  key(): string;
  /**
   * Takes `key` in **another process**, resolving once that process holds it.
   * `kill` ends the process without letting it release — SIGKILL, not a
   * shutdown — and resolves once it is gone.
   */
  holdElsewhere(key: string): Promise<{ kill(): Promise<void> }>;
}

const WAIT_MS = 30_000;

export function describeLockerContract(name: string, make: () => LockerHarness): void {
  describe(`${name}: the locker contract`, () => {
    it("has one holder: a second try on a held key is refused, from another locker or the same one", async () => {
      const h = make();
      const k = h.key();
      const mine = h.locker();
      const first = await mine.tryLock(k, "lingtai-test-first");
      expect(first.ok).toBe(true);
      try {
        expect((await h.locker().tryLock(k, "lingtai-test-second")).ok).toBe(false);
        expect((await mine.tryLock(k, "lingtai-test-again")).ok).toBe(false);
      } finally {
        if (first.ok) await first.lock.release();
      }
    });

    it("holds one key without holding another", async () => {
      const h = make();
      const a = await h.locker().tryLock(h.key(), "lingtai-test-a");
      const b = await h.locker().tryLock(h.key(), "lingtai-test-b");
      try {
        expect(a.ok).toBe(true);
        expect(b.ok).toBe(true);
      } finally {
        if (a.ok) await a.lock.release();
        if (b.ok) await b.lock.release();
      }
    });

    it("is free again once released", async () => {
      const h = make();
      const k = h.key();
      const first = await h.locker().tryLock(k, "lingtai-test-first");
      expect(first.ok).toBe(true);
      if (first.ok) await first.lock.release();

      const next = await h.locker().tryLock(k, "lingtai-test-next");
      expect(next.ok).toBe(true);
      if (next.ok) await next.lock.release();
    });

    it("is released when the holder dies without releasing it", async () => {
      const h = make();
      const k = h.key();
      const holder = await h.holdElsewhere(k);
      try {
        // Held, or the kill below proves nothing.
        expect((await h.locker().tryLock(k, "lingtai-test-while-alive")).ok).toBe(false);
      } finally {
        await holder.kill();
      }

      // Not necessarily at once — the implementation notices a death the way it
      // notices one — but without anybody cleaning up.
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const next = await h.locker().tryLock(k, "lingtai-test-after-death");
        if (next.ok) {
          await next.lock.release();
          return;
        }
        if (Date.now() > deadline) throw new Error(`still held ${WAIT_MS}ms after its holder was killed`);
        await new Promise((r) => setTimeout(r, 200));
      }
    });
  });
}
