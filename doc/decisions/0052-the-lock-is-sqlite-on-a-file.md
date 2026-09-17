# 0052 — The lock is SQLite's, on a file, and the queue is made rather than given

**Status** accepted · 2026-09-17 · **supersedes [0046 §1](0046-lingtai-is-personal.md)'s
`flock(2)`** — not its intent: the lock is still a file, for both stores, held by
the process and released by the kernel

## Context

0046 §1 moved the lock to the filesystem and named `flock(2)` for its liveness:
held by a descriptor, dropped when the holder dies. The property is right. The
syscall is not reachable: Node has no `flock` binding at any version —
`fs.flock` is undefined, `fs.constants` has no `LOCK_EX`.

#178's attempt 1 reached it anyway, through SQLite's `unix-flock` VFS. That VFS
is compiled in only where `SQLITE_ENABLE_LOCKING_STYLE` is set, which by default
is Apple's builds. The tests passed on the Mac they were written on; on Linux the
locker threw. 1.0 ships both.

Three locks were `pg_try_advisory_lock`, so a SQLite install had none:

| | where | key | stops |
|---|---|---|---|
| conductor | `daemon/lock.ts` | `lingtai:daemon` | two conductors claiming one ticket (#93) |
| merge lane | `repo/integrate.ts` | `merge:<project>:<base>` | two merges racing on one base |
| decide | `conductor/approve.ts` | `decide:<workItemId>` | a requeue inside an approval's merge (#84) |

## Decision

**1. One locker, `@lingtai/env/lock`, and all three locks take it.** No lock is
in Postgres. Since 0046 §2 all three answer *not twice on this machine*, which
is a file lock's scope exactly; nothing is kept in Postgres "for the team",
because there is no team-wide lock to keep. Lingtai has one locking mechanism.

**2. The lock is `BEGIN IMMEDIATE` on `~/.lingtai/locks/<key>.lock`, on SQLite's
default `unix` VFS.** `SQLITE_BUSY` is the refusal. SQLite holds it as a POSIX
advisory (`fcntl`) lock, so the kernel releases it with the process. The `unix`
VFS is in every build, and `node:sqlite` is inside Node, so #185's binary carries
no native file. SQLite also handles the two traps of raw `fcntl` locks: two
connections in one process exclude each other, and closing one descriptor does
not drop another's lock.

Refused, with the reason in the code beside the choice:

- `flock(2)` — not callable from Node.
- the `unix-flock` VFS — Apple-only by default; #178 attempt 1.
- `O_EXCL` plus a pid — a killed holder leaves the file, and the next process
  has to judge a pid's liveness. 0046 §1 refused it by name.
- a native addon — a SEA cannot carry a `.node` file (#185).

**3. Who holds it is a second lock, used as a flag.** SQLite can only answer
*can I have it*, and asking that on the lock would turn away a conductor starting
in the same instant as `lingtai doctor`. The holder keeps a read transaction open
on `<key>.held`; `conductorLockHolder` asks for `EXCLUSIVE` there, which any
reader refuses. The name, pid and host are in `<key>.who`, trusted only while the
flag is up, so a dead holder's name is never reported.

**4. The queue is made, because no file lock gives one.** `pg_advisory_lock`
handed a released lock to a blocked waiter before any `try` could see it free,
and #174's `service shutdown` depended on that: under KeepAlive, a copy started
the moment the drained daemon exits must not win. `flock`, `fcntl` and SQLite's
busy handler order nothing. So a waiter holds a read transaction on
`<key>.queue`, and polls for the lock; **a `tryLock` that wins the lock checks
the queue and gives it back if anybody is in it.** Between the release and the
waiter's next poll every try finds the lock free, takes it, sees the queue, and
is refused. `pure/lock.test.ts` races a copy trying every millisecond from
another process against a place queued before the holder was killed; with the
queue check removed, that test fails.

Two waiters are not ordered against each other. Nothing queues twice for a key.

## Consequences

- **A lock file is never deleted.** The lock is on an inode: a process opening a
  path whose file was removed locks a new one, and there are two holders.
  `LockPlace.confirm` checks the inode it locked is still the one at the path.
- A Postgres install carries a directory of few-byte files it never reads from
  the database. `lingtai doctor` no longer checks that an advisory lock survives
  a second statement — nothing takes one — and still checks `LISTEN/NOTIFY`.
- [0027](0027-the-lease-is-deleted.md)'s proof — *holding this lock, no other
  conductor exists* — is exactly as strong as before on one machine, and 0046 §2
  already said it is not a cross-machine claim.
- `.github/workflows/lock.yml` runs the lock's tests on Linux and macOS, because
  the defect this replaces was invisible on the machine it was written on.
