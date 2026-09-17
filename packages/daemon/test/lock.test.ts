/**
 * One daemon, against the real database.
 *
 * The exclusion is the whole point of the package, so a fake lock would test
 * nothing: what has to be true is that Postgres refuses the second caller, and
 * that a released lock is immediately available again.
 *
 * Each test uses its own key so the suite does not fight the operator's daemon
 * — or itself.
 */
import { directDatabaseUrl } from "@lingtai/env";
import { taskViewProjection } from "@lingtai/projector";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { acquireDaemonLock, conductorLockHolder, queueForDaemonLock, startDaemon } from "../src/index.ts";

const key = () => `lingtai:test:${crypto.randomUUID().slice(0, 8)}`;

describe("the daemon lock", () => {
  it("lets the first caller in and turns the second away", async () => {
    const k = key();
    const first = await acquireDaemonLock({ key: k });
    expect(first.ok).toBe(true);

    try {
      const second = await acquireDaemonLock({ key: k });
      // Not an error. Running `lingtai daemon` while launchd's copy is up is a
      // reasonable thing to do; it needs an answer, not a stack trace.
      expect(second.ok).toBe(false);
    } finally {
      if (first.ok) await first.lock.release();
    }
  });

  it("frees the lock on release, with nothing to clean up", async () => {
    const k = key();
    const first = await acquireDaemonLock({ key: k });
    expect(first.ok).toBe(true);
    if (first.ok) await first.lock.release();

    // Held by the connection, so releasing it leaves no file and no row that a
    // later run has to reason about.
    const again = await acquireDaemonLock({ key: k });
    expect(again.ok).toBe(true);
    if (again.ok) await again.lock.release();
  });

  it("does not take the lock hostage when a projection cannot start", async () => {
    const k = key();
    const broken = {
      name: `esctest_broken_${crypto.randomUUID().slice(0, 6)}`,
      async create() {
        throw new Error("no");
      },
      async reset() {},
      async apply() {},
    };

    await expect(startDaemon({ projections: [broken], lockKey: k })).rejects.toThrow();

    // The failure path releases. A daemon that dies while starting must not
    // keep the next one out — that is an outage produced by a bug in the
    // thing meant to survive bugs.
    const after = await acquireDaemonLock({ key: k });
    expect(after.ok).toBe(true);
    if (after.ok) await after.lock.release();
  });
});

/**
 * `lingtai service shutdown` has to be the next holder, not a racer (#174): the
 * copy KeepAlive starts the moment the drained daemon exits tries for the lock
 * and, since #159, would take work if it won.
 */
describe("a place in the queue for the lock", () => {
  it("is handed the lock on release, before a try from anybody else can find it free", async () => {
    const k = key();
    const daemon = await acquireDaemonLock({ key: k });
    expect(daemon.ok).toBe(true);
    const place = await queueForDaemonLock({ key: k });
    try {
      expect(place.held()).toBe(false);
      if (daemon.ok) await daemon.lock.release();
      const copy = await acquireDaemonLock({ key: k });
      expect(copy.ok).toBe(false);
      await vi.waitFor(() => expect(place.held()).toBe(true));
    } finally {
      await place.leave();
    }
    const after = await acquireDaemonLock({ key: k });
    expect(after.ok).toBe(true);
    if (after.ok) await after.lock.release();
  });

  it("leaves the queue when it leaves before its turn, so it never holds the lock afterwards", async () => {
    const k = key();
    const daemon = await acquireDaemonLock({ key: k });
    expect(daemon.ok).toBe(true);
    const place = await queueForDaemonLock({ key: k });
    await place.leave();
    await place.leave();
    expect(place.held()).toBe(false);
    if (daemon.ok) await daemon.lock.release();
    const next = await acquireDaemonLock({ key: k });
    expect(next.ok).toBe(true);
    if (next.ok) await next.lock.release();
  });
});

/**
 * `lingtai restart` waits on this read, and only an answer of *nobody* ends the
 * wait. A query that failed after the connection opened — a statement timeout,
 * a backend the pooler dropped — used to come back as that answer, so the drain
 * was withdrawn while the old daemon was still in its pass (0042 §6).
 */
describe("who holds the lock", () => {
  it("throws when the query fails after connecting, rather than saying nobody holds it", async () => {
    const k = key();
    const held = await acquireDaemonLock({ key: k });
    expect(held.ok).toBe(true);
    const query = vi.spyOn(pg.Client.prototype, "query").mockImplementation((() =>
      Promise.reject(new Error("terminating connection due to administrator command"))) as never);
    try {
      await expect(conductorLockHolder({ key: k })).rejects.toThrow("administrator command");
    } finally {
      query.mockRestore();
      if (held.ok) await held.lock.release();
    }
  });

  it("says nobody when the query answered and nobody holds it", async () => {
    expect(await conductorLockHolder({ key: key() })).toBeNull();
  });
});

describe("the daemon", () => {
  it("starts, follows, and stops when asked", async () => {
    const started = await startDaemon({ projections: [taskViewProjection], lockKey: key() });
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    started.daemon.stop();
    expect(await started.daemon.stopped).toBe("asked");
    expect(started.daemon.failure).toBeNull();

    // The connection string is read through the loader, never process.env —
    // asserting it here keeps that rule true in the package that opens the
    // longest-lived connection in the system.
    expect(directDatabaseUrl()).toBeTruthy();
  });
});
