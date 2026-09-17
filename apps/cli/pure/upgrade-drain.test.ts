/**
 * `lingtai upgrade`'s drain against a memory log: what it asks for, and that
 * what it asked for does not outlive the upgrade.
 */
import { readControl, requestShutdownUnlessStanding, withdrawShutdown } from "@lingtai/daemon/control";
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { describe, expect, it } from "vitest";
import { drainForUpgrade, type UpgradeDrain } from "../src/upgrade-drain.ts";

type Store = ReturnType<typeof createMemoryEventStore>;

function how(store: Store, over: Partial<UpgradeDrain> = {}): UpgradeDrain {
  return {
    by: "human:steven",
    reason: "upgrading 1.0.0 to 1.0.1",
    holder: async () => null,
    control: () => readControl(store),
    request: (by, reason) => requestShutdownUnlessStanding(by, reason, null, store),
    withdraw: (by, version, reason) => withdrawShutdown(by, version, reason, store),
    inFlight: async () => "nothing in flight",
    wait: async () => "free",
    log: () => {},
    ...over,
  };
}

describe("lingtai upgrade's drain", () => {
  it("withdraws its own drain on the next upgrade, after a ctrl-c, once the daemon has let go of the lock", async () => {
    const store = createMemoryEventStore();

    // A daemon mid-pass; the operator presses ctrl-c during the wait.
    const first = await drainForUpgrade(how(store, { holder: async () => "steven@host pid 777", wait: async () => "interrupted" }));
    expect(first).toEqual({ ok: false, code: 130 });
    expect((await readControl(store)).shutdown?.by).toBe("human:steven");

    // The daemon finishes its pass and exits; `lingtai upgrade` again.
    const second = await drainForUpgrade(how(store));
    expect(second.ok).toBe(true);
    if (second.ok) await second.after();
    expect((await readControl(store)).shutdown).toBeNull();
  });

  it("leaves a drain somebody else asked for where it is when nothing conducts", async () => {
    const store = createMemoryEventStore();
    await requestShutdownUnlessStanding("human:alice", "maintenance", null, store);

    const drained = await drainForUpgrade(how(store));
    expect(drained.ok).toBe(true);
    if (drained.ok) await drained.after();
    expect((await readControl(store)).shutdown?.by).toBe("human:alice");
  });

  it("asks for a drain while something conducts, and withdraws it once the lock is free and the shim has moved", async () => {
    const store = createMemoryEventStore();
    const drained = await drainForUpgrade(
      how(store, {
        holder: async () => "steven@host pid 777",
        wait: async () => {
          expect((await readControl(store)).shutdown?.by).toBe("human:steven");
          return "free";
        },
      }),
    );
    expect(drained.ok).toBe(true);
    if (drained.ok) await drained.after();
    expect((await readControl(store)).shutdown).toBeNull();
  });
});
