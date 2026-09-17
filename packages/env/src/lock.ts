/**
 * A named lock for this process, held in a file under `~/.lingtai/locks/` (#193).
 *
 * Every lock Lingtai takes is this one — the conductor's (`daemon/lock.ts`), the
 * merge lane's (`repo/integrate.ts`) and a decision's (`conductor/approve.ts`).
 * None of them needs a database, so a SQLite install is locked exactly as a
 * Postgres one is. **All three answer *not twice on this machine*** — the claim
 * moved to the GitHub assignee in [0046 §2](../../../doc/decisions/0046-lingtai-is-personal.md),
 * and that is precisely a file lock's scope.
 *
 * ## What it is built on, and what it is not
 *
 * The decision is [0052](../../../doc/decisions/0052-the-lock-is-sqlite-on-a-file.md).
 *
 * - **Chosen: SQLite's own locks, on the default `unix` VFS.** `BEGIN IMMEDIATE`
 *   on `<key>.lock` is the lock; `SQLITE_BUSY` is the refusal. SQLite takes it
 *   as a POSIX advisory lock (`fcntl`) on the file, so the kernel drops it when
 *   the process dies — the property 0046 §1 wanted from `flock(2)`. The `unix`
 *   VFS is compiled into every build, and `node:sqlite` ships inside Node, so
 *   there is no native file for #185's single binary to carry. SQLite also
 *   papers over the two traps of raw `fcntl` locks: two connections in one
 *   process exclude each other (it tracks locks per inode), and closing one
 *   descriptor does not drop another's lock (it defers the close).
 * - **Rejected: `flock(2)`**, which 0046 §1 named. Node has no binding for it at
 *   any version — `fs.flock` is undefined and `LOCK_EX` is absent.
 * - **Rejected: SQLite's `unix-flock` VFS**, #178's attempt 1. It is compiled in
 *   only where `SQLITE_ENABLE_LOCKING_STYLE` is set, which by default is Apple's
 *   builds: the tests passed on a Mac and the locker threw on Linux.
 * - **Rejected: `O_EXCL` and a pid.** A killed holder leaves the file, and the
 *   next process has to decide whether a pid is alive — the staleness this lock
 *   exists to avoid. 0046 §1 refuses it by name.
 * - **Rejected: a native addon.** Real `flock(2)`, and a SEA cannot carry a
 *   `.node` file (#185).
 *
 * **Never delete a lock file while anything might hold it.** A lock is on an
 * inode: a process that opens the path after it was removed locks a new file,
 * and two holders each believe they are alone. The files are a few bytes and are
 * left in place on release for that reason.
 *
 * ## Three files per key, because a lock cannot be looked at without taking it
 *
 * SQLite answers *can I have this* and nothing else. The two other questions
 * Lingtai asks are each answered by a second lock, used as a flag:
 *
 * - `<key>.held` — **who holds it, without taking it.** The holder keeps a read
 *   transaction open on it (a `SHARED` lock), and a reader asks for `EXCLUSIVE`,
 *   which a `SHARED` lock refuses. Asked on the lock itself, that question would
 *   *be* a try, and would turn away a conductor starting in the same instant.
 *   The name is beside it in `<key>.who`, written by the holder and trusted only
 *   while `.held` says somebody is there, so a killed holder's name is never
 *   reported.
 * - `<key>.queue` — **wait in line.** See `queue`.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stateDir } from "./index.ts";

export interface HeldLock {
  /** Gives the lock up. Safe to call twice; the kernel does it too if the process dies first. */
  release(): Promise<void>;
}

export type LockResult =
  | { ok: true; lock: HeldLock }
  /** Somebody else holds it. `holder` is their name, pid and host, when they recorded one. */
  | { ok: false; holder: string | null };

/**
 * Something that can hold a named lock for this process.
 *
 * Two promises, and a locker that breaks either is not a lock: **one holder** —
 * while a lock is held, every other `tryLock` on its key is refused, from this
 * process or any other — and **released when the holder dies**, with nothing
 * left behind for the next one to clean up.
 */
export interface Locker {
  /**
   * Takes `key` if nobody holds it; never waits. `name` is what the holder
   * calls itself, reported back to whoever is refused — best effort.
   */
  tryLock(key: string, name: string): Promise<LockResult>;
}

/** A place in the queue for a lock. See `FileLocker.queue`. */
export interface LockPlace {
  /** Whether the place has become the lock. */
  held(): boolean;
  /** Why the place was lost — a lock file that could not be opened; null while it stands. */
  lost(): Error | null;
  /**
   * Whether the lock is still held. A file lock is not dropped behind its
   * holder's back, with one exception: the file was deleted and something
   * locked a new one at the same path. So this checks the inode is still the
   * one it locked.
   */
  confirm(): Promise<boolean>;
  /** Releases the lock when held and leaves the queue when not. Safe to call twice. */
  leave(): Promise<void>;
}

export interface FileLocker extends Locker {
  /**
   * Who holds `key`, or null if nobody does — **without taking it**, which is
   * what a diagnostic must not do. Throws when the lock files cannot be read,
   * rather than answering *nobody*: `lingtai restart` ends a wait on null.
   */
  holder(key: string): Promise<string | null>;
  /**
   * Wait in line for `key` rather than race for it, and be handed it ahead of
   * any `tryLock` issued once this place is taken (#174).
   *
   * No file-locking primitive orders its waiters — `flock`, `fcntl` and SQLite's
   * busy handler all poll or wake at random — so the order is made here, and
   * this is the part that would be easiest to lose. `pg_advisory_lock` used to
   * give it for free. A waiter holds a `SHARED` lock on `<key>.queue` while it
   * waits; **a `tryLock` that wins the lock then looks at the queue, and gives
   * the lock back if anybody is in it.** So between the holder's release and the
   * waiter's next poll, every try finds the lock free, takes it, sees the queue,
   * and is refused — which is exactly what `pg_advisory_lock` did, one poll late.
   *
   * What it does not order is two waiters against each other; nothing queues
   * twice for one key.
   */
  queue(key: string, name: string): Promise<LockPlace>;
}

export interface FileLockerOptions {
  /** Where the lock files live. `~/.lingtai/locks`, or `$LINGTAI_HOME/locks`. */
  dir?: string;
}

/** SQLite's `SQLITE_BUSY` and `SQLITE_LOCKED`, the two ways of being refused. */
function refused(err: unknown): boolean {
  const code = (err as { errcode?: number }).errcode;
  return code !== undefined && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

/** How often a place in the queue asks for the lock. */
const QUEUE_POLL_MS = 25;
/**
 * How long a flag has to stay up to be believed. A reader of `.held` can be
 * refused for an instant by another reader's probe; a holder's flag stays up.
 */
const FLAG_SETTLE_MS = 100;
/** How long opening a flag waits on somebody else's instant on it. */
const FLAG_WAIT_MS = 5_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `node:sqlite`, loaded when a lock is first asked for rather than when this
 * file is imported. The CLI imports this at startup — `lingtai doctor` reads the
 * holder — so on a Node without the module a static import would take every
 * command down with it, where this fails only the lock, by name. It is
 * unflagged from 22.13, which is why `engines` says so.
 */
function sqlite(): typeof import("node:sqlite") {
  const mod = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite") | undefined;
  if (mod === undefined) {
    throw new Error(`the lock needs node:sqlite, which Node ${process.version} does not have without a flag — Node 22.13 or later has it`);
  }
  return mod;
}

/**
 * Opens a lock file. `waitMs` is SQLite's busy timeout, which blocks the thread: zero, or a flag's instant.
 *
 * Set with the pragma and not the constructor's `timeout`, which arrived in
 * 22.16 and before that is ignored without a word — leaving a flag's open to
 * fail with `SQLITE_BUSY` on another process's probe instead of waiting it out.
 */
function open(path: string, waitMs: number): DatabaseSync {
  const db = new (sqlite().DatabaseSync)(path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(waitMs)}`);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Takes the lock on `path`, or null when somebody holds it. */
function take(path: string): DatabaseSync | null {
  const db = open(path, 0);
  try {
    db.exec("BEGIN IMMEDIATE");
    return db;
  } catch (err) {
    db.close();
    if (refused(err)) return null;
    throw err;
  }
}

function giveBack(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {}
  db.close();
}

/** Raises a flag: a read transaction left open, which holds a `SHARED` lock until it is lowered. */
function raise(path: string): DatabaseSync {
  const db = open(path, FLAG_WAIT_MS);
  try {
    db.exec("BEGIN");
    db.prepare("SELECT count(*) FROM sqlite_schema").get();
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

/** Whether a flag is raised, asked once: `EXCLUSIVE` is refused while any `SHARED` lock stands. */
function raisedNow(path: string): boolean {
  const db = open(path, 0);
  try {
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
    return false;
  } catch (err) {
    if (refused(err)) return true;
    throw err;
  } finally {
    db.close();
  }
}

export function createFileLocker(options: FileLockerOptions = {}): FileLocker {
  const dir = options.dir ?? join(stateDir(), "locks");

  const paths = (key: string) => {
    mkdirSync(dir, { recursive: true });
    const base = join(dir, encodeURIComponent(key));
    return { lock: `${base}.lock`, held: `${base}.held`, who: `${base}.who`, queue: `${base}.queue` };
  };

  const whoIs = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8").trim() || null;
    } catch {
      return null;
    }
  };

  /**
   * Takes the lock for `name`: `null` when somebody holds it, `"queued"` when
   * it was free but somebody is waiting in line and `giveWay` says to let them.
   *
   * **The flag goes up before the lock is taken and comes down after it is
   * given back**, so there is no instant in which the lock is held and `.held`
   * says nobody is — `holder` would answer *free*, `lingtai restart` would end
   * its wait on that, and its own try would then be refused by a lock still
   * held. The flag of a try that is refused is down again at once, which
   * `holder`'s settle window does not believe. The name is written as soon as
   * the lock is this process's, well inside that window.
   */
  const acquire = (p: ReturnType<typeof paths>, name: string, giveWay: boolean) => {
    const flag = raise(p.held);
    let lock: DatabaseSync | null = null;
    try {
      lock = take(p.lock);
      if (lock === null) {
        giveBack(flag);
        return null;
      }
      // Somebody queued for it: this try was never theirs to win.
      if (giveWay && raisedNow(p.queue)) {
        giveBack(lock);
        giveBack(flag);
        return "queued" as const;
      }
      const inode = statSync(p.lock).ino;
      const tmp = `${p.who}.${process.pid}`;
      writeFileSync(tmp, `${name} pid ${process.pid} on ${hostname()}\n`);
      renameSync(tmp, p.who);
      const held: DatabaseSync = lock;
      let released = false;
      return {
        inode,
        release() {
          if (released) return;
          released = true;
          giveBack(held);
          giveBack(flag);
        },
      };
    } catch (err) {
      if (lock !== null) giveBack(lock);
      giveBack(flag);
      throw err;
    }
  };

  return {
    async tryLock(key, name) {
      const p = paths(key);
      const held = acquire(p, name, true);
      if (held === null) return { ok: false, holder: whoIs(p.who) };
      if (held === "queued") return { ok: false, holder: "a process waiting in line for it" };
      return { ok: true, lock: { release: async () => held.release() } };
    },

    async holder(key) {
      const p = paths(key);
      // Refused for the whole window, or it was only another reader's instant.
      const until = Date.now() + FLAG_SETTLE_MS;
      for (;;) {
        if (!raisedNow(p.held)) return null;
        if (Date.now() >= until) return whoIs(p.who) ?? "a holder that has not named itself";
        await sleep(FLAG_SETTLE_MS / 4);
      }
    },

    async queue(key, name) {
      const p = paths(key);
      const place = raise(p.queue);
      let lowered = false;
      const lower = () => {
        if (lowered) return;
        lowered = true;
        giveBack(place);
      };

      let held: Exclude<ReturnType<typeof acquire>, null | "queued"> | null = null;
      let lost: Error | null = null;
      let leaving = false;
      let timer: NodeJS.Timeout | undefined;

      const ask = () => {
        timer = undefined;
        if (leaving) return;
        try {
          const got = acquire(p, name, false);
          if (got !== null && got !== "queued") {
            held = got;
            // Lowered only once the lock is this place's, so there is no instant
            // in which the lock is free and the queue looks empty.
            lower();
            return;
          }
        } catch (err) {
          lost = err as Error;
          lower();
          return;
        }
        timer = setTimeout(ask, QUEUE_POLL_MS);
      };
      ask();

      return {
        held: () => held !== null,
        lost: () => lost,
        async confirm() {
          if (held === null || lost !== null || leaving) return false;
          try {
            if (statSync(p.lock).ino === held.inode) return true;
            lost = new Error(`${p.lock} is not the file this lock was taken on — it was deleted while held`);
          } catch (err) {
            lost = err as Error;
          }
          return false;
        },
        async leave() {
          leaving = true;
          clearTimeout(timer);
          held?.release();
          lower();
        },
      };
    },
  };
}
