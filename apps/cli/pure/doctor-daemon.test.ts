/**
 * `lingtai doctor`'s two daemon rows, answered off a beacon in a file (#220).
 *
 * Both rows read the one mutable row — liveness asks *is a daemon up*, currency
 * asks *is it up on the code we merged* — and until the beacon had an interface
 * both of them could only be asked of Postgres. Here they are asked of a file,
 * and they answer.
 *
 * No database and no git is reached: a beacon that recorded no commit is
 * answered before `codeCurrency` shells out, and that is deliberate — what is
 * under test is which store the row came from, not what the rows say about a
 * commit, which `test/doctor.test.ts` covers against the real one.
 *
 * **What was still Postgres's is the module graph**, and #179 closed that:
 * importing `@lingtai/daemon/control` used to build the process-wide log client
 * at import, so a machine that had configured no Postgres at all could not run
 * `doctor` however file-backed these two rows were. The store is a written
 * choice now and it is read when a store is opened, so nothing here is reached
 * by importing anything.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pauseConductor, readControl, readStatus } from "@lingtai/daemon/control";
import { createSqliteDaemonStore, openSqliteDaemon } from "@lingtai/daemon/sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { daemonCurrency, daemonLiveness } from "../src/doctor.ts";

const dirs: string[] = [];

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "lingtai-doctor-"));
  dirs.push(dir);
  return createSqliteDaemonStore(openSqliteDaemon(join(dir, "log.db")));
}

afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("the daemon rows, read from a beacon in a file", () => {
  it("says no daemon has run where none ever has", async () => {
    const store = freshStore();
    try {
      const liveness = await daemonLiveness(
        () => readStatus(store),
        // The control stream is the same file's log, which is the other half
        // of what one store names.
        () => readControl(store.events),
      );
      expect(liveness.status).toBe("ok");
      expect(liveness.detail).toContain("no daemon has run");

      const currency = await daemonCurrency(() => readStatus(store));
      expect(currency.status).toBe("ok");
      expect(currency.detail).toContain("nothing is holding code open");
    } finally {
      await store.close();
    }
  });

  it("reads a beat back as a daemon that is up and cannot say what it is running", async () => {
    const store = freshStore();
    try {
      await store.beat({
        pid: 321,
        host: "laptop",
        state: "starting",
        currentRunId: null,
        // A daemon older than #98, which is the state `daemon: currency` was
        // written for: up, and unable to say from where.
        codeSha: null,
        codeDirty: false,
      });

      const liveness = await daemonLiveness(() => readStatus(store), () => readControl(store.events));
      expect(liveness.detail).toContain("starting");
      expect(liveness.detail).not.toContain("not running");
      expect(liveness.detail).toContain("takes no work");

      const currency = await daemonCurrency(() => readStatus(store));
      expect(currency.status).toBe("warn");
      expect(currency.detail).toContain("recorded no commit");
    } finally {
      await store.close();
    }
  });

  it("reports a pause on the file's own log beside the beacon", async () => {
    const store = freshStore();
    try {
      // Appended through the store's log rather than a memory one: the point is
      // that *this* store answers both questions.
      await pauseConductor("human:ops", "migrating", store.events);

      const liveness = await daemonLiveness(() => readStatus(store), () => readControl(store.events));
      expect(liveness.detail).toContain("paused by human:ops (migrating)");
    } finally {
      await store.close();
    }
  });
});
