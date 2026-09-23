/**
 * The waker contract, against a waker rung by hand (#177).
 *
 * Not a second implementation: nothing in the system is woken this way. It is
 * here so the contract is run somewhere that has no `LISTEN`, which is what
 * says `test/wake-contract.ts` asks a waker for what a caller relies on and not
 * for what Postgres happens to do. Its twin, `integration/subscribe.test.ts`, runs the
 * same contract against `createPostgresWaker` in `pnpm test:db`.
 *
 * It also puts `subscribe` itself under `pnpm test`: the last assertion of the
 * contract is a subscriber over late, doubled and spurious nudges, and here
 * that runs with no connection at all.
 */
import { describeWakerContract } from "../test/wake-contract.ts";
import { createMemoryEventStore } from "../test/memory.ts";
import type { Waker, WakeListener } from "../src/wake.ts";

/** A waker that nudges every open session when `ring` is called, and at no other time. */
function handRung(): Waker & { ring(): void } {
  const listening = new Set<WakeListener>();
  return {
    ring: () => {
      for (const l of listening) l.nudge();
    },
    open(listener) {
      listening.add(listener);
      return {
        ready: Promise.resolve(),
        close: () => void listening.delete(listener),
      };
    },
  };
}

/** `support.ts` has the same one, and reads a database URL at import. */
const discovered = (title: string) => ({
  type: "WorkItemDiscovered",
  actor: "conductor",
  data: { project: "lingtai", source: "manual" as const, externalRef: "test", title, kind: "tech-debt" as const, labels: [] },
});

let n = 0;
describeWakerContract("rung by hand", () => {
  const store = createMemoryEventStore();
  const waker = handRung();
  return {
    waker,
    store,
    async append(title) {
      const [written] = await store.append(`wi-wake-${n++}`, 0, [discovered(title)]);
      waker.ring();
      return written!;
    },
    head: async () => BigInt(store.all().length),
  };
});
