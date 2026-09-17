/**
 * Exactly one conductor on this machine, decided by a lock file rather than by
 * a pid file.
 *
 * A second conductor is not a hypothetical, and it does not have to be a second
 * daemon. launchd keeps one daemon alive, the obvious way to debug it is to run
 * `lingtai daemon` in a terminal while that one is still up — and `CLAUDE.md`
 * teaches people to run `lingtai run` by hand, which conducts exactly the same
 * work through the same `conductorPass`. **A conductor is anything that claims,
 * not a process with a particular name** (#93). Two of them racing for the same
 * ticket is the failure that makes the whole claim mechanism pointless — and it
 * would present as an expensive mystery rather than an error.
 *
 * That is also why the lock is the liveness proof
 * [0027](../../../doc/decisions/0027-the-lease-is-deleted.md) rests on: a
 * process holding this lock knows no other conductor on this machine exists, so
 * every claim this machine made and finds is dead. The proof is only as true as
 * the set of processes that take it, which is why `lingtai run` takes it too.
 * Across machines the claim is GitHub's assignee (0046 §2), not a lock.
 *
 * **The lock is `@lingtai/env/lock`'s file lock, for every store** (#193): held
 * by this process, released by the kernel when it dies, with nothing to clean up
 * and no stale file to explain. That file says what it is built on and what was
 * refused — `flock(2)`, which Node cannot call, among them. It is the same lock
 * the merge lane and a decision take; Lingtai has one locking mechanism.
 * `test/lock-contract.ts` is what any locker is held to: one holder, and
 * released when the holder dies — the two facts #93 and 0027 stand on.
 *
 * Losing is not an error. The second process exits 0 saying who holds it —
 * `lingtai daemon` while launchd's copy is running is a reasonable thing to do,
 * and greeting it with a stack trace would teach people to ignore stack traces.
 */
import {
  createFileLocker,
  type FileLockerOptions,
  type HeldLock,
  type LockPlace,
  type Locker,
  type LockResult,
} from "@lingtai/env/lock";

export { createFileLocker, type FileLockerOptions, type LockPlace, type Locker, type LockResult };

/** One lock for the whole conductor, per machine. */
export const DAEMON_LOCK_KEY = "lingtai:daemon";

export type DaemonLock = HeldLock;

export interface AcquireDaemonLockOptions {
  /** What holds it. `createFileLocker()` for this machine's own lock. */
  locker: Locker;
  key?: string;
  /** Recorded so the next caller — and `lingtai doctor` — gets a name rather than a bare pid. */
  name?: string;
}

export interface AcquireOptions extends FileLockerOptions {
  key?: string;
  /**
   * What the holder calls itself, recorded beside the lock with its pid and
   * host so the next caller — and `lingtai doctor` — gets a name rather than a
   * bare pid. There are two kinds of conductor, and "who has it" is the whole
   * question.
   */
  name?: string;
}

export function acquireDaemonLock(options: AcquireDaemonLockOptions): Promise<LockResult> {
  return options.locker.tryLock(options.key ?? DAEMON_LOCK_KEY, options.name ?? "lingtai");
}

/**
 * Who is conducting, without becoming a conductor to find out.
 *
 * `acquireDaemonLock` answers the same question, but only by trying to take the
 * lock — which is exactly what a diagnostic must not do. `lingtai doctor` never
 * writes and must never take a lock the thing it is diagnosing needs, so this
 * asks the holder's flag and never the lock.
 *
 * **A read that fails throws.** Null means the lock was asked about and nobody
 * holds it; a failure read as that would tell `lingtai restart` the drain was
 * over while the old daemon was still in its pass (0042 §6).
 */
export function conductorLockHolder(options: AcquireOptions = {}): Promise<string | null> {
  return createFileLocker(options).holder(options.key ?? DAEMON_LOCK_KEY);
}

/**
 * Wait in line for the lock rather than race for it (#174).
 *
 * `acquireDaemonLock` tries once, and that is right for a conductor. It is
 * wrong for `lingtai service shutdown`, which has to be the *next* holder: under
 * launchd's KeepAlive a daemon that drains and exits is started again at once,
 * and since #159 the copy reads only what is appended after it starts — so it
 * does not see the drain, and if it wins the lock it takes work that the unload
 * then kills. A try that finds the lock free while this place stands gives it
 * back (`FileLocker.queue` says how). Queued before the drain is asked for, the
 * place is ahead of every copy the supervisor can start.
 */
export function queueForDaemonLock(options: AcquireOptions = {}): Promise<LockPlace> {
  return createFileLocker(options).queue(options.key ?? DAEMON_LOCK_KEY, options.name ?? "lingtai");
}
