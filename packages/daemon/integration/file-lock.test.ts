/**
 * The lock, with no database anywhere near it (#193).
 *
 * The exclusion is the whole point of the package, so a fake lock would test
 * nothing: every holder here that has to be *another* holder is another
 * process, because a lock that only excludes itself is the bug #178's attempt 1
 * shipped. And this file runs on Linux in CI as well as on a Mac
 * (`.github/workflows/lock.yml`) — that attempt passed on the machine it was
 * written on and threw on the other.
 *
 * Each test has its own directory, so nothing here touches `~/.lingtai/locks`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { acquireDaemonLock, conductorLockHolder, createFileLocker, queueForDaemonLock } from "../src/lock.ts";
import { describeLockerContract } from "../test/lock-contract.ts";

const dir = () => mkdtempSync(join(tmpdir(), "lingtai-lock-"));
const key = () => `lingtai:test:${crypto.randomUUID().slice(0, 8)}`;
const lock = fileURLToPath(new URL("../../env/src/lock.ts", import.meta.url));

/** A node process running `body` against the file locker, with `createFileLocker`, `dir` and `key` in scope. */
function child(d: string, k: string, body: string): { process: ChildProcess; exited: Promise<void>; lines: string[] } {
  const script = `
    const { createFileLocker } = await import(${JSON.stringify(lock)});
    const [dir, key] = process.argv.slice(1);
    ${body}
  `;
  // `--experimental-strip-types`, so the floor `engines` names can import the
  // source too: types are stripped without a flag only from 22.18.
  const proc = spawn(process.execPath, ["--input-type=module", "--no-warnings", "--experimental-strip-types", "-e", script, d, k], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines: string[] = [];
  let out = "";
  proc.stdout!.on("data", (b: Buffer) => {
    out += b.toString();
    const cut = out.lastIndexOf("\n");
    if (cut >= 0) {
      lines.push(...out.slice(0, cut).split("\n"));
      out = out.slice(cut + 1);
    }
  });
  let err = "";
  proc.stderr!.on("data", (b: Buffer) => void (err += b.toString()));
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  void exited.then(() => {
    if (err) lines.push(`stderr: ${err}`);
  });
  return { process: proc, exited, lines };
}

/** A conductor in another process, holding `k` until it is killed with SIGKILL — no `finally` runs. */
async function holdElsewhere(d: string, k: string): Promise<{ kill(): Promise<void> }> {
  const c = child(
    d,
    k,
    `const got = await createFileLocker({ dir }).tryLock(key, "lingtai-test-elsewhere");
     console.log(got.ok ? "held" : "refused");
     if (!got.ok) process.exit(1);
     setInterval(() => {}, 60_000);`,
  );
  await vi.waitFor(
    () => {
      if (c.lines.includes("refused")) throw new Error("the other process was refused the lock");
      expect(c.lines).toContain("held");
    },
    { timeout: 20_000, interval: 20 },
  );
  return {
    async kill() {
      c.process.kill("SIGKILL");
      await c.exited;
    },
  };
}

describeLockerContract("file", () => {
  const d = dir();
  return {
    locker: () => createFileLocker({ dir: d }),
    key,
    holdElsewhere: (k) => holdElsewhere(d, k),
  };
});

describe("the daemon lock", () => {
  it("names the holder to whoever it turns away", async () => {
    const d = dir();
    const k = key();
    const first = await acquireDaemonLock({ locker: createFileLocker({ dir: d }), key: k, name: "lingtai daemon" });
    expect(first.ok).toBe(true);
    try {
      const second = await acquireDaemonLock({ locker: createFileLocker({ dir: d }), key: k });
      expect(second).toEqual({ ok: false, holder: expect.stringContaining(`lingtai daemon pid ${process.pid} on `) });
    } finally {
      if (first.ok) await first.lock.release();
    }
  });
});

/**
 * `lingtai doctor`, `lingtai restart` and the board all ask this, and none of
 * them may take the lock to find out: a conductor starting in the same instant
 * would be turned away by a diagnostic.
 */
describe("who holds the lock", () => {
  it("says nobody when nobody does", async () => {
    expect(await conductorLockHolder({ dir: dir(), key: key() })).toBeNull();
  });

  it("names a holder in another process, with its pid and host", async () => {
    const d = dir();
    const k = key();
    const holder = await holdElsewhere(d, k);
    try {
      expect(await conductorLockHolder({ dir: d, key: k })).toMatch(/^lingtai-test-elsewhere pid \d+ on .+/);
    } finally {
      await holder.kill();
    }
    // Its name is still on disk; a dead holder's name is never reported.
    await vi.waitFor(async () => expect(await conductorLockHolder({ dir: d, key: k })).toBeNull(), { timeout: 20_000 });
  });

  it("never takes the lock to answer: a try racing the question always wins", async () => {
    const d = dir();
    const k = key();
    const asking = child(
      d,
      k,
      `const l = createFileLocker({ dir });
       const until = Date.now() + 1500;
       while (Date.now() < until) await l.holder(key);
       console.log("done");`,
    );
    const locker = createFileLocker({ dir: d });
    let tries = 0;
    while (!asking.lines.includes("done")) {
      const got = await locker.tryLock(k, "lingtai-test-racer");
      expect(got.ok).toBe(true);
      if (got.ok) await got.lock.release();
      tries++;
      // The locker never yields to I/O on its own, and the child's "done" arrives as I/O.
      await new Promise((r) => setImmediate(r));
    }
    await asking.exited;
    expect(tries).toBeGreaterThan(10);
  });

  /**
   * A holder takes the lock and raises its flag as two steps, and gives them
   * back as two. Whichever order they come in, there must be no step at which
   * the lock is held and the flag is down: that is `holder` answering *free*
   * for a lock a try is then refused, which is `lingtai restart` ending its
   * wait and starting nothing. So every statement the locker runs is stopped
   * and the two files asked, from connections of the test's own.
   */
  it("never reads as free at any step of taking or giving back the lock", async () => {
    const d = dir();
    const k = key();
    const base = join(d, encodeURIComponent(k));
    const { DatabaseSync } = await import("node:sqlite");
    const exec = DatabaseSync.prototype.exec;
    const close = DatabaseSync.prototype.close;
    const refusedBy = (path: string, begin: string) => {
      const db = new DatabaseSync(path);
      try {
        exec.call(db, begin);
        exec.call(db, "ROLLBACK");
        return false;
      } catch (err) {
        if (((err as { errcode?: number }).errcode ?? 0) % 256 === 5) return true;
        throw err;
      } finally {
        close.call(db);
      }
    };
    const free: string[] = [];
    const check = (step: string) => {
      if (refusedBy(`${base}.lock`, "BEGIN IMMEDIATE") && !refusedBy(`${base}.held`, "BEGIN EXCLUSIVE")) free.push(step);
    };
    const onExec = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: InstanceType<typeof DatabaseSync>, sql: string) {
      check(`before ${sql}`);
      return exec.call(this, sql);
    });
    const onClose = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: InstanceType<typeof DatabaseSync>) {
      check("before a close");
      return close.call(this);
    });
    try {
      const locker = createFileLocker({ dir: d });
      const got = await locker.tryLock(k, "lingtai-test");
      expect(got.ok).toBe(true);
      if (got.ok) await got.lock.release();
      const place = await locker.queue(k, "lingtai-test-place");
      await vi.waitFor(() => expect(place.held()).toBe(true));
      await place.leave();
    } finally {
      onExec.mockRestore();
      onClose.mockRestore();
    }
    expect(free).toEqual([]);
  });

  /**
   * The flag's open waits out another process's instant on it. That wait is
   * SQLite's busy timeout, and the constructor's `timeout` that could set it is
   * ignored below Node 22.16 — so a holder raising its flag while a probe had
   * it would be refused, and `tryLock` would throw rather than answer.
   */
  it("waits out another process's instant on the flag rather than throwing", async () => {
    const d = dir();
    const k = key();
    const probe = child(
      d,
      k,
      `const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
       const db = new DatabaseSync(dir + "/" + encodeURIComponent(key) + ".held");
       db.exec("BEGIN EXCLUSIVE");
       console.log("in");
       setTimeout(() => { db.exec("COMMIT"); console.log("out"); }, 750);`,
    );
    await vi.waitFor(() => expect(probe.lines).toContain("in"), { timeout: 20_000 });
    const got = await createFileLocker({ dir: d }).tryLock(k, "lingtai-test");
    expect(got.ok).toBe(true);
    if (got.ok) await got.lock.release();
    await probe.exited;
  });

  it("throws when the lock cannot be asked about, rather than saying nobody holds it", async () => {
    await expect(conductorLockHolder({ dir: "/dev/null/not-a-directory", key: key() })).rejects.toThrow();
  });
});

/**
 * `lingtai service shutdown` has to be the next holder, not a racer (#174): the
 * copy KeepAlive starts the moment the drained daemon exits tries for the lock
 * and, since #159, would take work if it won. `pg_advisory_lock` gave this
 * order for free; a file lock does not, and this is the requirement that gets
 * dropped quietly.
 */
describe("a place in the queue for the lock", () => {
  it("is handed the lock on release, before a try from anybody else can find it free", async () => {
    const d = dir();
    const k = key();
    const locker = createFileLocker({ dir: d });
    const daemon = await acquireDaemonLock({ locker, key: k });
    expect(daemon.ok).toBe(true);
    const place = await queueForDaemonLock({ dir: d, key: k, name: "lingtai-service-shutdown" });
    try {
      expect(place.held()).toBe(false);
      if (daemon.ok) await daemon.lock.release();
      const copy = await acquireDaemonLock({ locker, key: k });
      expect(copy.ok).toBe(false);
      await vi.waitFor(() => expect(place.held()).toBe(true));
      expect(await place.confirm()).toBe(true);
      expect(await conductorLockHolder({ dir: d, key: k })).toContain("lingtai-service-shutdown");
      expect((await acquireDaemonLock({ locker, key: k })).ok).toBe(false);
    } finally {
      await place.leave();
    }
    const after = await acquireDaemonLock({ locker, key: k });
    expect(after.ok).toBe(true);
    if (after.ok) await after.lock.release();
  });

  it("wins against a copy that tries in a tight loop from another process, from the moment the holder dies", async () => {
    const d = dir();
    const k = key();
    const daemon = await holdElsewhere(d, k);
    const place = await queueForDaemonLock({ dir: d, key: k, name: "lingtai-service-shutdown" });
    // The supervisor's copy: every millisecond or so, for as long as it is let.
    const copy = child(
      d,
      k,
      `const l = createFileLocker({ dir });
       console.log("trying");
       for (;;) {
         const got = await l.tryLock(key, "lingtai daemon copy");
         if (got.ok) { console.log("WON"); await got.lock.release(); }
         await new Promise((r) => setTimeout(r, 1));
       }`,
    );
    try {
      await vi.waitFor(() => expect(copy.lines).toContain("trying"), { timeout: 20_000 });
      await daemon.kill();
      await vi.waitFor(() => expect(place.held()).toBe(true), { timeout: 20_000 });
      // Held a while, with the copy still hammering.
      await new Promise((r) => setTimeout(r, 500));
      expect(await place.confirm()).toBe(true);
      expect(copy.lines).not.toContain("WON");
    } finally {
      copy.process.kill("SIGKILL");
      await copy.exited;
      await place.leave();
    }
  }, 60_000);

  it("leaves the queue when it leaves before its turn, so it never holds the lock afterwards", async () => {
    const d = dir();
    const k = key();
    const locker = createFileLocker({ dir: d });
    const daemon = await acquireDaemonLock({ locker, key: k });
    expect(daemon.ok).toBe(true);
    const place = await queueForDaemonLock({ dir: d, key: k });
    await place.leave();
    await place.leave();
    expect(place.held()).toBe(false);
    if (daemon.ok) await daemon.lock.release();
    const next = await acquireDaemonLock({ locker, key: k });
    expect(next.ok).toBe(true);
    if (next.ok) await next.lock.release();
  });

  it("is released by a queued process that is killed, holding or waiting", async () => {
    const d = dir();
    const k = key();
    const waiter = child(
      d,
      k,
      `const place = await createFileLocker({ dir }).queue(key, "lingtai-test-waiter");
       const t = setInterval(() => { if (place.held()) { console.log("held"); clearInterval(t); } }, 10);
       setInterval(() => {}, 60_000);`,
    );
    await vi.waitFor(() => expect(waiter.lines).toContain("held"), { timeout: 20_000 });
    const locker = createFileLocker({ dir: d });
    expect((await locker.tryLock(k, "lingtai-test")).ok).toBe(false);
    waiter.process.kill("SIGKILL");
    await waiter.exited;
    await vi.waitFor(async () => {
      const got = await locker.tryLock(k, "lingtai-test");
      expect(got.ok).toBe(true);
      if (got.ok) await got.lock.release();
    });
  }, 60_000);

  it("does not confirm a lock whose file was deleted under it", async () => {
    const d = dir();
    const k = key();
    const place = await queueForDaemonLock({ dir: d, key: k });
    try {
      await vi.waitFor(() => expect(place.held()).toBe(true));
      const { rmSync } = await import("node:fs");
      rmSync(join(d, `${encodeURIComponent(k)}.lock`));
      // Somebody locks a new file at the same path — two holders, which is why
      // `confirm` asks, and why nothing in Lingtai deletes a lock file.
      const copy = await createFileLocker({ dir: d }).tryLock(k, "lingtai-test-copy");
      expect(copy.ok).toBe(true);
      if (copy.ok) await copy.lock.release();
      expect(await place.confirm()).toBe(false);
      expect(place.lost()).not.toBeNull();
    } finally {
      await place.leave();
    }
  });
});
