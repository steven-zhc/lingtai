/**
 * `lingtai upgrade`'s drain against a memory log: what it asks for, that what
 * it asked for does not outlive the upgrade, and that a request left standing by
 * an earlier upgrade is neither waited on for ever nor left unsaid.
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
    despiteDoctor: false,
    doctor: async () => 0,
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

  it("lifts its own earlier drain and asks again while something conducts, so a daemon started since reads it", async () => {
    const store = createMemoryEventStore();

    // Ctrl-c during the first upgrade's wait: its request stands.
    await drainForUpgrade(how(store, { holder: async () => "steven@host pid 777", wait: async () => "interrupted" }));
    const first = (await readControl(store)).shutdown!;

    // That daemon exits and another starts, whose watermark is past `first` —
    // it reads only what is appended after it started. `lingtai upgrade` again.
    let readByTheNewDaemon: number | null = null;
    const drained = await drainForUpgrade(
      how(store, {
        holder: async () => "steven@host pid 888",
        wait: async () => {
          const standing = (await readControl(store)).shutdown;
          readByTheNewDaemon = standing !== null && standing.version > first.version ? standing.version : null;
          return "free";
        },
      }),
    );
    expect(readByTheNewDaemon).not.toBeNull();
    expect(drained.ok).toBe(true);
    if (drained.ok) await drained.after();
    expect((await readControl(store)).shutdown).toBeNull();
  });

  it("refuses on somebody else's drain while something conducts, and asks nothing", async () => {
    const store = createMemoryEventStore();
    await requestShutdownUnlessStanding("human:alice", "maintenance", null, store);
    const lines: string[] = [];
    const drained = await drainForUpgrade(how(store, { holder: async () => "steven@host pid 777", log: (l) => lines.push(l) }));
    expect(drained).toEqual({ ok: false, code: 1 });
    expect(lines.join("\n")).toContain("theirs to lift");
    expect((await readControl(store)).shutdown?.by).toBe("human:alice");
  });

  it("refuses on a red doctor before asking anything, and says so", async () => {
    const store = createMemoryEventStore();
    const lines: string[] = [];
    const drained = await drainForUpgrade(
      how(store, { doctor: async () => 1, holder: async () => "steven@host pid 777", log: (l) => lines.push(l) }),
    );
    expect(drained).toEqual({ ok: false, code: 1 });
    expect(lines.join("\n")).toContain("nothing was asked to stop");
    expect((await readControl(store)).shutdown).toBeNull();
  });

  it("names its own earlier drain, still standing, when a retried upgrade is refused on a red doctor", async () => {
    const store = createMemoryEventStore();
    await drainForUpgrade(how(store, { holder: async () => "steven@host pid 777", wait: async () => "interrupted" }));

    const lines: string[] = [];
    const drained = await drainForUpgrade(
      how(store, { doctor: async () => 2, holder: async () => "steven@host pid 777", log: (l) => lines.push(l) }),
    );
    expect(drained).toEqual({ ok: false, code: 1 });
    const said = lines.join("\n");
    expect(said).not.toContain("nothing was asked to stop");
    expect(said).toContain("the drain you asked for earlier (upgrading 1.0.0 to 1.0.1) is still standing");
    expect(said).toContain("lingtai resume lifts it");
  });

  it("upgrades despite a red doctor when told to", async () => {
    const store = createMemoryEventStore();
    const drained = await drainForUpgrade(how(store, { doctor: async () => 1, despiteDoctor: true }));
    expect(drained.ok).toBe(true);
  });
});
