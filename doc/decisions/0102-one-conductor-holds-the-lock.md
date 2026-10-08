# 0102 — The conductor and the daemon: one process holds the work, a file lock makes it the only one, and stopping drains the pass

**Status** accepted · 2026-10-01

One long-lived daemon holds the work in flight on a machine: the conductor, the
projection follower and the agents it starts. The board and the CLI hold no work.
They control the daemon by appending events and they watch its beacon. Exactly one
process conducts at a time. A SQLite lock on a file under `~/.lingtai/locks/`
enforces that, and `lingtai run` takes the same lock, so holding the lock proves
that every claim recorded by another worker is dead. Stopping is a command that
drains the pass in flight. A control signal applies only to the daemon that was
running when it was appended. `lingtai restart` drains, waits and starts, and it
refuses before it drains, never after. Every start that takes work is recorded as
`ConductorStarted`.

## Context

A dead UI costs a screen. A dead conductor costs an agent run that has already
been paid for, a worktree, and a claim. So whatever holds work in flight has to be
a process that nothing else restarts casually, and two conductors racing for one
ticket is the failure that defeats claiming in the first place. A running Node
process keeps the code it imported when it started, so new code reaches the
conductor only through a restart. That makes the restart a routine act, and a safe
restart needs two things: a drain that waits for the pass, and a start that can
say what code it is running and who started it.

## Decision

1. **The daemon holds the work; the UI controls it and holds nothing.** `lingtai
   start` (`lingtai daemon` is the old name and still works) runs one process
   holding the projection follower and the conductor (`packages/daemon`).
   `--no-conduct` runs projections only, and still obeys a shutdown. The board is
   a separate server that never spawns the daemon. Keeping the daemon up is the
   job of a supervisor (`lingtai service`: launchd `KeepAlive`, or a systemd unit
   with `Restart=always`), or of a terminal.

2. **Control goes through the log; liveness does not.** `pause`, `resume`,
   `shutdown`, `now <project> --issue <n>` and a restart's withdrawal are events
   on the `ctl-conductor` stream (`ConductorPaused`, `ConductorResumed`,
   `ConductorShutdownRequested`, `ConductorShutdownWithdrawn`, `RunRequested`).
   `reduceControl` in `packages/domain/src/control.ts` folds them. Liveness is the
   **beacon**: one overwritten row in `daemon_status`, written every
   `HEARTBEAT_MS` (5 s) and treated as stale after three missed beats. It carries
   `pid`, `host`, `startedAt`, `lastSeenAt`, `state` (`up`, `draining`,
   `stopping`), `currentRunId`, and the commit and dirtiness the process started
   from. It is the system's only mutable operational state, and it is not history.

3. **A control signal applies to the daemon running when it was appended.** Before
   it takes the lock, a daemon reads `controlWatermark`, the length of
   `ctl-conductor`, and from then on folds only events above that point
   (`readControl(store, since)`). It reads the watermark first and takes the lock
   second, so a request appended after the lock is held is always above the
   watermark. As a result, a `shutdown` or a `pause` stops the daemon it was aimed
   at and never the next one, and `lingtai start` needs nothing lifted first.
   `lingtai run` is the exception: it takes no ticket while a pause stands. The
   board, `doctor` and `status` fold the whole stream, because they report what is
   standing now.

4. **One conductor, enforced by a file lock.** The lock is SQLite's `BEGIN
   IMMEDIATE` on `~/.lingtai/locks/<key>.lock` (`$LINGTAI_HOME/locks` where that
   is set). The key is URI-encoded, and SQLite's default `unix` VFS takes it as a
   POSIX `fcntl` lock, so the kernel releases it when the process dies.
   `SQLITE_BUSY` is the refusal. The implementation is `@lingtai/env/lock`
   (`createFileLocker`), and Lingtai has no other locking mechanism.
   - The conductor's key is `lingtai:daemon` (`DAEMON_LOCK_KEY`). The daemon, every
     `lingtai run` (`apps/cli/src/conductor-lock.ts`) and a restart's start all
     take it. Losing it is not an error: the process says who holds it and exits 0.
   - `<key>.held` and `<key>.who` answer *who holds it* without taking it, so
     `lingtai doctor` never turns away a starting conductor. The name is trusted
     only while the holder's flag is up.
   - `<key>.queue` provides the order that file locks do not have. A waiter holds a
     place in it, and a `tryLock` that wins while somebody is queued gives the lock
     back.
   - **A lock file is never deleted.** The lock lives on an inode, and the holder
     confirms that the inode at the path is still the one it locked.
   - The other keys are `decide:<workItemId>` (an approval's merge) and the board's
     own. The merge lane takes no lock, because git rejecting a second push to a
     ref is the guarantee.

5. **Holding the lock is the proof that every foreign claim is dead.** A claim has
   no expiry. A daemon that has just taken the lock knows no other conductor
   exists, so at startup `reconcile` (`packages/daemon/src/reconcile.ts`) kills
   the process each claim by another worker names (`killWorker`, with SIGKILL) and
   then appends `WorkItemReleased` with the lock as the reason. Recovery is an
   append, never a time-based computation, so a rebuilt projection matches the
   incremental one. Recovery happens only at startup, and that is enough: an
   orphaned claim can only come from a conductor dying, and work resumes only when
   a conductor starts. How the claim itself excludes other claimants is covered
   in 0109.

6. **Killing by a recorded pid is guarded twice.** The host must be this machine,
   and the process's command line must be one of ours (`node` and `lingtai`). If
   either check fails, the process is named in the finding and not killed.

7. **The agent runs in its own process group.** Runtimes are spawned with
   `detached: true`, so a Ctrl+C aimed at the daemon does not kill the agent it is
   about to wait for.

8. **Stopping is a command, and the boundary is the pass.** `lingtai shutdown
   [why]` appends `ConductorShutdownRequested` and returns. The daemon finishes
   the pass in flight (the agent, every step, the merge lane) and takes nothing
   new. An idle daemon wakes on the request itself rather than waiting for the
   five-minute sweep.
   - **No default timeout.** A drain can last as long as the pass ceiling the
     recipe's `runtime.limits` allow, and the command prints that limit up front.
   - `--timeout <duration>` gives up after that long. `--force` does not wait at
     all. Either one leaves the agent running on purpose, as an orphan for the next
     conductor to kill. The two flags cannot be combined.
   - **Signals behave the same way.** The first SIGINT or SIGTERM drains and says
     what is in flight and what a second signal would cost. The second stops now.

9. **`lingtai restart [why]` drains, waits and starts, and its checks come before
   the drain.** Every check that can refuse runs while the old daemon is still
   conducting, so a refusal costs only the typing:
   - `HEAD` must be reachable from the tracking remote (`origin/main` where the
     branch has no upstream). **No flag overrides this**, and none overrides a
     commit that could not be checked. The command never fetches.
   - A dirty worktree is refused unless `--dirty` is given.
   - `lingtai doctor` must pass unless `--despite-doctor` is given. A failure
     whose own remedy is the restart (`restartAnswers`) is printed but does not
     count.
   - A drain somebody else asked for is refused, and no flag overrides that. A
     drain this person asked for is withdrawn and asked for again.
   - A lock or a beacon that could not be read is a refusal before the drain and
     an unanswered poll during the wait. It is never read as "nobody is
     conducting".

   After the wait, the commit, the worktree, any foreign drain and any start
   somebody else made in the meantime are checked again. The restart withdraws
   only its own request, with `ConductorShutdownWithdrawn` naming that request's
   version, and never lifts a pause. If something else wins the lock, the restart
   starts nothing and exits 1. A Ctrl+C during the wait leaves the drain
   standing, and the next restart by the same person picks it up. `lingtai
   resume` lifts it otherwise.

10. **Under a supervisor, the restart is the same checks wrapped around
    `service`'s drain and start.** `lingtai service shutdown` queues for the lock
    and holds it while the job is unloaded, so the copy the supervisor respawns
    cannot take work on unchecked code. `service start`, `restart` and `install`
    take the watermark first, then wait up to two minutes for a
    `ConductorStarted`, and exit 1 if none arrives. A daemon the supervisor was
    already running is reported and not waited for, and that exit 0 confirms
    nothing about the lock. `--no-conduct` and `--no-merge` are refused there.
    `RESTART_GUARDS` in `apps/cli/src/restart.ts` lists every refusal with where
    each path makes it, and `apps/cli/integration/restart.test.ts` fails on a row
    that has only one side.

11. **A start that takes work appends `ConductorStarted`.** The daemon itself
    appends it after it has won the lock, run reconcile and read the control
    stream. It carries `by`, `reason`, `sha`, `dirty` and `worker` (`host:pid`,
    spelled as `WorkItemClaimed.worker` spells it). `by` is `human:$USER` for
    `lingtai restart` or for a start typed at a terminal, and `daemon` when stdin
    is not a terminal, as with a supervisor. The decision to record the start and
    the decision to take work come from one read of the control stream. On the
    terminal path the daemon compares the commit it is running with the commit
    the restart checked (`startRefusals`) and stops before taking anything if they
    differ.

12. **A daemon does not restart itself when `main` moves.** `lingtai doctor`'s
    `daemon: currency` check and the board's health dot report how far the
    beacon's commit is behind `origin/main`. A person decides, and the decision is
    one command.

13. **Work is found by asking GitHub on each pass, not by storing a queue.** A pass
    starts at startup, after every completion, on a control event or a
    `QueueChanged`, and on a five-minute sweep (`SWEEP_MS`). Nothing records what
    the queue looked like.

## Consequences

- At most one conductor per machine, which is all a file lock can promise. The day
  two conductors are wanted, *I hold the lock, so everyone else is dead* stops
  being true, and each run would need liveness of its own, such as a lock held per
  run. A claim timeout is not the answer.
- A drain can take an hour or more, and every command that waits says so rather
  than appearing hung.
- An orphan from a second Ctrl+C, `--force` or `--timeout` is cleaned up by the
  next conductor, not by the one that left it.
- Who started the conductor, when, and from which commit is a question the log
  answers. A commit named there is one that can still be fetched.
- `ConductorStarted.handoff` and `ConductorShutdownWithdrawn.handoff` stay in the
  schema so that older events still parse. Nothing writes them, and the fold reads
  them as nothing.
- The lock depends on `node:sqlite`, on the Node 0101 names. The
  lock's tests run on Linux and macOS both.

---
*Replaces archived 0012, 0013, 0027, 0030, 0042, 0048, 0052 in [decisions-archive](../decisions-archive/).*
