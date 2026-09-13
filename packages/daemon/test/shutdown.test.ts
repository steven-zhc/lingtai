/**
 * The two halves of [0030](../../../doc/decisions/0030-shutting-down-safely.md)
 * that are not the loop: what the control stream says, and what recovery does
 * about a process.
 *
 * The fold is tested against a stub store rather than the real log, because
 * `ctl-conductor` is one stream for the whole installation — appending a
 * shutdown request to the test database would leave every later test reading a
 * conductor that has been told to stop.
 *
 * `killWorker` is tested against real processes, because every claim it makes
 * is about a real one: that a pid on another machine is a local stranger, that
 * a pid can be reused, and that the guard is what stands between recovery and
 * killing something that was never ours.
 */
import { spawn } from "node:child_process";
import type { Envelope } from "@lingtai/domain";
import { ConcurrencyError, type EventStore } from "@lingtai/event-store";
import { conductorWorker } from "@lingtai/conductor/claim";
import { afterEach, describe, expect, it } from "vitest";
import { killWorker } from "../src/reconcile.ts";
import { readControl, requestShutdownUnlessStanding, withdrawShutdown } from "../src/control.ts";

/** Just enough of a store to fold. `readControl` reads one stream and nothing else. */
function storeOf(events: { type: string; data: unknown }[]): EventStore {
  const envelopes = events.map(
    (e, i) =>
      ({
        seq: BigInt(i + 1),
        streamId: "ctl-conductor",
        version: i + 1,
        type: e.type,
        schemaVer: 1,
        data: e.data,
        actor: "human:test",
        causation: null,
        at: new Date(),
      }) as Envelope,
  );
  return {
    read: async () => envelopes,
    append: async () => [],
    readAll: async () => [],
  };
}

/** This machine, spelled as a claim spells it. */
const HOST = conductorWorker().split(":")[0]!;

const spawned: ReturnType<typeof spawn>[] = [];

afterEach(() => {
  for (const child of spawned) child.kill("SIGKILL");
  spawned.length = 0;
});

/**
 * A process that looks exactly like one of ours: node, with `lingtai` in its
 * command line. Nothing about it is a conductor, which is the point — the guard
 * is on what can be read from outside, and this is what that reads.
 */
function decoy(marker: string): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)", marker], {
    stdio: "ignore",
  });
  spawned.push(child);
  return child;
}

/** Still there, asked the way `killWorker` asks. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("the control stream, folded", () => {
  it("holds a shutdown request beside the pause, not instead of it", async () => {
    const state = await readControl(
      storeOf([
        { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "picking up #88", timeoutMs: null } },
      ]),
    );
    expect(state.shutdown).toMatchObject({ by: "human:steven", reason: "picking up #88", timeoutMs: null });
    // Being told to stop is not being paused. Two facts, and the board and
    // doctor say them separately (#77 is the precedent).
    expect(state.paused).toBe(false);
  });

  it("keeps the timeout, because it is the difference between waiting and walking away", async () => {
    const state = await readControl(
      storeOf([
        { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "now", timeoutMs: 1_200_000 } },
      ]),
    );
    expect(state.shutdown?.timeoutMs).toBe(1_200_000);
  });

  /**
   * The request outlives the daemon it was aimed at. Without a withdrawal it
   * would stop every daemon started after it, for ever — so `resume` lifts it,
   * exactly as it lifts a pause.
   */
  it("is withdrawn by a resume", async () => {
    const state = await readControl(
      storeOf([
        { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "restarting", timeoutMs: null } },
        { type: "ConductorResumed", data: { by: "human:steven" } },
      ]),
    );
    expect(state.shutdown).toBeNull();
  });
});

describe("the process a dead claim names", () => {
  it("is killed when the host matches and it is one of ours", async () => {
    const child = decoy("lingtai-decoy-daemon");
    const pid = child.pid!;
    const exited = new Promise<string | null>((r) => child.on("exit", (_c, signal) => r(signal)));

    const said = await killWorker(`${HOST}:${pid}`);

    expect(said).toContain(`killed pid ${pid}`);
    expect(await exited).toBe("SIGKILL");
  });

  /**
   * A pid from another machine names a local stranger. There is no way to tell
   * from here whether it is even the same number space, so the claim is still
   * released and the process is reported rather than killed.
   */
  it("is reported, not killed, when the host is somebody else's", async () => {
    const child = decoy("lingtai-decoy-elsewhere");
    const said = await killWorker(`some-other-laptop:${child.pid}`);

    expect(said).toContain("not this machine");
    expect(said).toContain("reported, not killed");
    expect(alive(child.pid!)).toBe(true);
  });

  /**
   * Pids are reused, and the cost of getting this wrong is killing something
   * that was never ours. `sleep` is alive, is local, and is not us.
   */
  it("is reported, not killed, when the argv is not the runtime we started", async () => {
    const child = spawn("sleep", ["60"], { stdio: "ignore" });
    spawned.push(child);
    const said = await killWorker(`${HOST}:${child.pid}`);

    expect(said).toContain("is not ours");
    expect(said).toContain("reported, not killed");
    expect(alive(child.pid!)).toBe(true);
  });

  /** The ordinary case: the conductor died, which is why recovery is running. */
  it("says so when there is nothing there", async () => {
    const child = decoy("lingtai-decoy-gone");
    const pid = child.pid!;
    const exited = new Promise<void>((r) => child.on("exit", () => r()));
    child.kill("SIGKILL");
    await exited;

    expect(await killWorker(`${HOST}:${pid}`)).toBe(`pid ${pid} is gone`);
  });

  it("refuses a worker that names no process at all", async () => {
    expect(await killWorker("nonsense")).toContain("names no process");
  });
});

/**
 * `lingtai restart` has to lift the drain it asked for — the request stands in
 * the stream for ever, so the daemon it is about to start would read it and
 * stop again — and nothing else (0042).
 *
 * Against a store that enforces expected versions the way Postgres does,
 * because the defect this replaces was a race: a resume and a re-pause as two
 * appends, with a person's pause lost to whatever landed between them.
 */
describe("withdrawing a drain", () => {
  /** A store that keeps what it is given and refuses a stale expected version. */
  function recording(initial: { type: string; data: unknown }[] = []): {
    store: EventStore;
    held: { type: string; data: unknown }[];
    appended: { type: string; data: unknown }[];
    /** Runs once, just before the next append is checked — the concurrent writer. */
    before: { next: (() => void) | null };
  } {
    const held = [...initial];
    const appended: { type: string; data: unknown }[] = [];
    const before: { next: (() => void) | null } = { next: null };
    const store: EventStore = {
      read: async () => storeOf(held).read("ctl-conductor"),
      append: async (stream, at, events) => {
        const race = before.next;
        before.next = null;
        race?.();
        if (at !== held.length) throw new ConcurrencyError(stream, at, [at + 1]);
        for (const e of events) {
          held.push({ type: e.type, data: e.data });
          appended.push({ type: e.type, data: e.data });
        }
        return [];
      },
      readAll: async () => [],
    };
    return { store, held, appended, before };
  }

  const restarting = { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "restarting", timeoutMs: null } };

  it("lifts the request it names, with one append", async () => {
    const { store, appended } = recording([restarting]);

    const lifted = await withdrawShutdown("human:steven", 1, "restarted", null, store);

    expect(lifted.withdrew).toBe(true);
    expect(appended.map((e) => e.type)).toEqual(["ConductorShutdownWithdrawn"]);
    expect((await readControl(store)).shutdown).toBeNull();
  });

  it("appends nothing when there was nothing to withdraw", async () => {
    const { store, appended } = recording([]);

    expect(await withdrawShutdown("human:steven", 1, "restarted", null, store)).toEqual({ withdrew: false, standing: null });
    expect(appended).toEqual([]);
  });

  /**
   * Restarting a paused conductor must not start it taking work. Nothing is
   * appended about the pause at all, so there is nothing to lose a race with.
   */
  it("leaves a pause alone, even when a control append lands in the middle", async () => {
    const { store, held, appended, before } = recording([
      { type: "ConductorPaused", data: { by: "human:ops", reason: "the importer is flaky today", until: null } },
      { ...restarting },
    ]);
    before.next = () => held.push({ type: "RunRequested", data: { project: "lingtai", issue: "88", by: "human:ops" } });

    const lifted = await withdrawShutdown("human:steven", 2, "restarted", null, store);

    expect(lifted.withdrew).toBe(true);
    expect(appended.map((e) => e.type)).toEqual(["ConductorShutdownWithdrawn"]);
    const after = await readControl(store);
    expect(after.shutdown).toBeNull();
    expect(after.paused).toBe(true);
    expect(after.by).toBe("human:ops");
  });

  /** The one refusal a restart may not waive: a drain somebody else asked for. */
  it("leaves standing a drain a second person asked for, even one that raced the withdrawal", async () => {
    const { store, held, appended, before } = recording([restarting]);
    before.next = () =>
      held.push({ type: "ConductorShutdownRequested", data: { by: "human:ops", reason: "moving the database", timeoutMs: null } });

    const lifted = await withdrawShutdown("human:steven", 1, "restarted", null, store);

    expect(lifted.withdrew).toBe(false);
    expect(appended).toEqual([]);
    expect((await readControl(store)).shutdown?.by).toBe("human:ops");
  });

  /**
   * The race on the other side: the restart read no request, and a second
   * person's landed before the restart's append. Appended over it, the fold
   * would show only the restart's — and withdrawing that by version would lift
   * ops's with no event withdrawing it.
   */
  it("never asks over a request that landed after the read that decided to ask", async () => {
    const { store, held, appended, before } = recording([]);
    before.next = () =>
      held.push({ type: "ConductorShutdownRequested", data: { by: "human:ops", reason: "moving the database", timeoutMs: null } });

    const asked = await requestShutdownUnlessStanding("human:steven", "restarting", null, store);

    expect(asked).toMatchObject({ asked: false, standing: { by: "human:ops", version: 1 } });
    expect(appended).toEqual([]);
    // And so the restart has nothing of its own to withdraw, and ops's stands.
    expect((await readControl(store)).shutdown?.by).toBe("human:ops");
  });

  it("asks, and names the version it landed at, when nothing stands", async () => {
    const { store, appended } = recording([{ type: "ConductorPaused", data: { by: "human:ops", reason: "x", until: null } }]);

    expect(await requestShutdownUnlessStanding("human:steven", "restarting", 300_000, store)).toEqual({ asked: true, version: 2 });
    expect(appended.map((e) => e.type)).toEqual(["ConductorShutdownRequested"]);
    expect(await withdrawShutdown("human:steven", 2, "restarted", null, store)).toMatchObject({ withdrew: true });
  });
});
