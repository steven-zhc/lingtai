/**
 * The daemon, against the real database.
 *
 * The lock itself needs none since #193, and is tested in `pure/lock.test.ts`
 * — the contract, a killed holder, the queue. What is left here starts a
 * daemon, which follows the log.
 *
 * Each test uses its own key so the suite does not fight the operator's daemon
 * — or itself.
 */
import { directPostgresUrl } from "@lingtai/env";
import { taskViewProjection } from "@lingtai/projector";
import { describe, expect, it } from "vitest";
import { acquireDaemonLock, createFileLocker, startDaemon } from "../src/index.ts";

const locker = createFileLocker();
const key = () => `lingtai:test:${crypto.randomUUID().slice(0, 8)}`;

describe("the daemon lock", () => {
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
    const after = await acquireDaemonLock({ locker, key: k });
    expect(after.ok).toBe(true);
    if (after.ok) await after.lock.release();
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
    expect(directPostgresUrl()).toBeTruthy();
  });
});
