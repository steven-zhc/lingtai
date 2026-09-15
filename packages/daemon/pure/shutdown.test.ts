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
import { createMemoryEventStore } from "@lingtai/event-store/memory";
import { conductorWorker } from "@lingtai/conductor/claim";
import { afterEach, describe, expect, it } from "vitest";
import { killWorker } from "../src/reconcile.ts";
import {
  readControl,
  recordStart,
  requestShutdown,
  requestShutdownUnlessStanding,
  startAfter,
  type StartDecision,
} from "../src/control.ts";

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
   * Nothing needs a resume to lift a request any more — the next start ends it
   * (`0045`) — but a person who typed one over a drain meant it.
   */
  it("is lifted by a resume", async () => {
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

/** A store that keeps what it is given and refuses a stale expected version, as Postgres does. */
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

const code = { sha: "2926f2d", dirty: false };
const daemon = (): StartDecision => ({ record: true, by: "daemon", reason: null, handoff: null, note: null });

/**
 * A restart's drain has to be its own, and never one it hid somebody else's
 * behind — the start ends whatever stands, so a request appended over a second
 * person's would take theirs with it unread.
 */
describe("asking for a drain", () => {
  it("never asks over a request that landed after the read that decided to ask", async () => {
    const { store, held, appended, before } = recording([]);
    before.next = () =>
      held.push({ type: "ConductorShutdownRequested", data: { by: "human:ops", reason: "moving the database", timeoutMs: null } });

    const asked = await requestShutdownUnlessStanding("human:steven", "restarting", null, store);

    expect(asked).toMatchObject({ asked: false, standing: { by: "human:ops", version: 1 } });
    expect(appended).toEqual([]);
    expect((await readControl(store)).shutdown?.by).toBe("human:ops");
  });

  it("asks, and names the version it landed at, when nothing stands", async () => {
    const { store, appended } = recording([{ type: "ConductorPaused", data: { by: "human:ops", reason: "x", until: null } }]);

    expect(await requestShutdownUnlessStanding("human:steven", "restarting", 300_000, store)).toEqual({ asked: true, version: 2 });
    expect(appended.map((e) => e.type)).toEqual(["ConductorShutdownRequested"]);
  });

  it("carries the commit a supervised restart checked, for the start that ends it", async () => {
    const { store } = recording([]);
    await requestShutdownUnlessStanding("human:steven", "restarting", null, store, false, code);
    expect((await readControl(store)).shutdown?.handoff).toEqual(code);
  });
});

/**
 * The record is the watermark (`0045` §2): the start is decided off the stream
 * it lands on, and the version it lands at is where the daemon's hearing
 * begins. Nothing can be said between the two.
 */
describe("recording a start", () => {
  /**
   * A `RunRequested` landing between the start's read and its append used to
   * cost the record. It is read, decided and appended again.
   */
  it("records a start even when a control append lands in the middle, and returns where it landed", async () => {
    const { store, held, appended, before } = recording([
      { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "restarting", timeoutMs: null } },
    ]);
    before.next = () => held.push({ type: "RunRequested", data: { project: "lingtai", issue: "88", by: "human:ops" } });

    const recorded = await recordStart(daemon, code, store);

    expect(recorded).toMatchObject({ recorded: true, version: 3 });
    expect(appended.map((e) => e.type)).toEqual(["ConductorStarted"]);
    expect(held.map((e) => e.type)).toEqual(["ConductorShutdownRequested", "RunRequested", "ConductorStarted"]);
  });

  /**
   * The race the watermark closes. A drain lands between the start's read and
   * its append: a start appended over it blind would end a request nobody
   * decided about — and a restart in this process is the start that must not
   * (`attributeStart`). It reads again, so the decision is taken with the drain
   * in view, and anything later lands *after* the start, where the new daemon
   * hears it.
   */
  it("decides again off a drain that landed in the middle, so the decision has it in view", async () => {
    const { store, held, before } = recording([]);
    before.next = () =>
      held.push({ type: "ConductorShutdownRequested", data: { by: "human:ops", reason: "moving the database", timeoutMs: null } });
    const seen: (string | null)[] = [];

    await recordStart((control) => (seen.push(control.shutdown?.by ?? null), daemon()), code, store);

    expect(seen).toEqual([null, "human:ops"]);
  });

  it("appends nothing when the decision is not to start", async () => {
    const { store, appended } = recording([]);
    expect(await recordStart(() => ({ record: false, why: "somebody asked it not to" }), code, store)).toEqual({
      recorded: false,
      why: "somebody asked it not to",
    });
    expect(appended).toEqual([]);
  });

  it("names the restart's request when the start answers its handoff", async () => {
    const { store } = recording([
      { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "restarting", timeoutMs: null, handoff: code } },
    ]);
    await recordStart(
      (control) => ({ record: true, by: control.shutdown!.by, reason: control.shutdown!.reason, handoff: control.shutdown!.version, note: null }),
      code,
      store,
    );
    expect(await startAfter(1, store)).toMatchObject({ by: "human:steven", handoff: 1, sha: "2926f2d" });
  });
});

/**
 * **One command to stop and one to start** — the complaint `#159` was opened
 * for. `lingtai shutdown` and then `lingtai start`, as the events they append,
 * against the in-memory store the real one is held to the same contract as.
 *
 * Before `37013f4` the second daemon read the first's request and stopped too,
 * and a `lingtai resume` had to come between them. Before `0045` the daemon was
 * fine and every whole-stream reader — the board, `doctor`, a restart asking
 * whether a drain stands — still said *stopping* for ever.
 */
describe("stopping and starting", () => {
  it("takes one command each, and nothing appended between them", async () => {
    const store = createMemoryEventStore();

    // The daemon that is running.
    const first = await recordStart(daemon, code, store);
    if (!first.recorded) throw new Error("the first start was not recorded");

    // `lingtai shutdown`. The running daemon hears it, from its own start.
    await requestShutdown("human:steven", "stopping for the day", null, store);
    expect((await readControl(store, first.version)).shutdown?.reason).toBe("stopping for the day");
    expect((await readControl(store)).shutdown?.reason).toBe("stopping for the day");

    // `lingtai start`. Nothing lifted first.
    const second = await recordStart(daemon, code, store);
    if (!second.recorded) throw new Error("the second start was not recorded");

    // The new daemon hears nothing, and neither does anybody folding the whole
    // stream: the start ended the request.
    expect((await readControl(store, second.version)).shutdown).toBeNull();
    expect((await readControl(store)).shutdown).toBeNull();
    expect((await store.read("ctl-conductor")).map((e) => e.type)).toEqual([
      "ConductorStarted",
      "ConductorShutdownRequested",
      "ConductorStarted",
    ]);
  });

  /**
   * `lingtai restart` is the same two appends, with its checks around them —
   * there used to be a `ConductorShutdownWithdrawn` between, undoing the first.
   */
  it("is what a restart appends, and a drain asked after the new start is the new daemon's", async () => {
    const store = createMemoryEventStore();
    await recordStart(daemon, code, store);

    const asked = await requestShutdownUnlessStanding("human:steven", "restarting: picking up #88", null, store);
    if (!asked.asked) throw new Error("the restart's drain was not asked");
    const restarted = await recordStart(
      () => ({ record: true, by: "human:steven", reason: "picking up #88", handoff: null, note: null }),
      code,
      store,
    );
    if (!restarted.recorded) throw new Error("the restart's start was not recorded");

    expect((await store.read("ctl-conductor")).map((e) => e.type)).toEqual([
      "ConductorStarted",
      "ConductorShutdownRequested",
      "ConductorStarted",
    ]);
    expect((await readControl(store)).shutdown).toBeNull();

    await requestShutdown("human:ops", "moving the database", null, store);
    expect((await readControl(store, restarted.version)).shutdown?.by).toBe("human:ops");
  });
});

/**
 * A signal is aimed at one daemon, and does not outlive it (`#159`).
 *
 * The complaint was that stopping the daemon took two commands to undo:
 * `lingtai shutdown` appended a request that stood until withdrawn, so the
 * *next* daemon read it and stopped too, and `lingtai resume` — a command about
 * taking work — became the way to make a process stay up. The log carries the
 * evidence: `ConductorShutdownRequested` at v59, `ConductorResumed` at v61,
 * `ConductorStarted` at v62, all within the same minute one morning.
 *
 * The fix is one parameter. A conductor reads the control stream from where it
 * was when it started, so what was said before it began is not addressed to it.
 * That makes the two axes independent, which is the whole of the design:
 * `start` and `shutdown` are about the process, `pause` and `resume` about the
 * process that is running.
 */
describe("a signal belongs to the daemon it was sent to", () => {
  const shutdown = { type: "ConductorShutdownRequested", data: { by: "human:steven", reason: "stopping for the day" } };
  const pause = { type: "ConductorPaused", data: { by: "human:steven", reason: "thinking" } };

  it("is obeyed by the daemon that was running when it was sent", async () => {
    // Watermark 0: nothing had been said before this one started.
    const state = await readControl(storeOf([shutdown]), 0);

    expect(state.shutdown).not.toBeNull();
    expect(state.shutdown?.reason).toBe("stopping for the day");
  });

  it("is invisible to the daemon that started after it", async () => {
    // The request is at version 1; this daemon started with the stream one
    // event long, so the request belongs to its predecessor.
    const state = await readControl(storeOf([shutdown]), 1);

    expect(state.shutdown).toBeNull();
  });

  it("does not carry a pause across a restart either", async () => {
    // The same rule, and the one that made `restart` useless against a pause:
    // it never resumes, so before `#159` a pause survived every restart and
    // only `resume` lifted it.
    const state = await readControl(storeOf([pause]), 1);

    expect(state.paused).toBe(false);
  });

  it("still reaches a daemon told to stop after it started", async () => {
    // The half that must keep working: one event was there when it started,
    // and the request came after.
    const state = await readControl(storeOf([pause, shutdown]), 1);

    expect(state.shutdown?.reason).toBe("stopping for the day");
    // And the pause from before is still not this daemon's.
    expect(state.paused).toBe(false);
  });

  it("folds the whole stream for a reader that passes nothing", async () => {
    // The board, `doctor` and `status` ask *what is standing now*, not *what am
    // I being told*, so they keep the unscoped read.
    const state = await readControl(storeOf([shutdown]));

    expect(state.shutdown).not.toBeNull();
  });
});

/**
 * Safe by default, forced by name (`#159`).
 *
 * A drain is what anybody wants nine times in ten — the *pass*, so the gates
 * and the merge lane run too — and a command whose ordinary form throws away a
 * run in progress is one people stop reaching for while anything is happening,
 * which is exactly when a restart is wanted. So the flag carries the dangerous
 * meaning and the bare command carries the safe one.
 *
 * What `--force` asks for is not a new state: it is where `--timeout` already
 * went when it tripped, and where a second Ctrl+C goes. The agent is left
 * running and the next conductor's `reconcile` kills it and releases the claim.
 */
describe("a shutdown is safe unless it says otherwise", () => {
  const asked = (data: object) => ({ type: "ConductorShutdownRequested", data });

  it("is a drain when nothing said force", async () => {
    const state = await readControl(storeOf([asked({ by: "human:steven", reason: "stopping" })]));

    expect(state.shutdown?.force).toBe(false);
  });

  it("is forced when it said so", async () => {
    const state = await readControl(storeOf([asked({ by: "human:steven", reason: "wedged", force: true })]));

    expect(state.shutdown?.force).toBe(true);
  });

  it("reads a request written before the flag existed as the drain it was", async () => {
    // Every request on the log before `#159` is a drain, and the field is
    // absent rather than false on all of them. Absent has to mean drain, or
    // replaying this system's own history would turn old shutdowns into kills.
    const state = await readControl(storeOf([asked({ by: "human:steven", reason: "stopping for the day" })]));

    expect(state.shutdown).not.toBeNull();
    expect(state.shutdown?.force).toBe(false);
  });

  it("keeps force with the request an old withdrawal does not lift", async () => {
    // A withdrawal from before `0045` names its own request by version;
    // somebody else's forced request stands, and stands as forced.
    const state = await readControl(
      storeOf([
        asked({ by: "human:ops", reason: "wedged", force: true }),
        { type: "ConductorShutdownWithdrawn", data: { by: "human:steven", version: 99 } },
      ]),
    );

    expect(state.shutdown?.force).toBe(true);
  });
});
