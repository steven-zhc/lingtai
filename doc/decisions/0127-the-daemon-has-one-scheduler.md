# 0127 — The daemon has one scheduler, and a scheduled job only looks outside the log and appends

**Status** proposed · 2026-11-10 · agreed in outline, being designed

The daemon does things at times as well as on events. One scheduler inside the
daemon holds every such job, recurring or one-shot, and a job only looks at what
is outside the log (the clock, the configuration, GitHub) and appends events.

## Context

The daemon keeps several timers of its own, each written where it was needed: the
work loop's five-minute sweep (`SWEEP_MS`, `packages/daemon/src/work-loop.ts`),
the hourly rate refresh and the shutdown heartbeat (`apps/cli/src/daemon.ts`).
[0126](0126-a-stop-is-a-lock-and-an-unlock.md) adds jobs that run at a time rather
than on an event: the day's ceiling at local midnight, an account limit at its
`until`. Nothing says, in one place, what the daemon does when.

## Decision (agreed so far)

1. **A scheduler is a module inside the daemon, not a process of its own.** Its
   jobs append events, and only the conductor-lock holder appends what they
   append ([0100](0100-one-append-only-log.md) §13); a second process would be a
   second writer with its own lock, beacon and supervision. It runs in whichever
   process holds the conductor lock: the daemon, or a `lingtai run`.

2. **Two kinds of job.**
   - *Recurring*, by a cron-like rule: every five minutes, every day at 00:00
     local.
   - *One-shot*, at an instant, registered by whoever learned the instant: the
     account watcher registers `until` when `AccountLimitReached` is appended.

3. **A one-shot job is not stored; it is derived.** On start, each job's owner
   reads its state from the log and registers again what it implies (an
   `acct-{runtime}` locked until 23:00 registers 23:00). The log stays the only
   record, and a restart loses nothing.

4. **A job looks at what is outside the log and appends events.** The clock, the
   configuration file, GitHub. It never edits a state and never cleans up: state
   is replayed, and a job that needs to clean is a sign the model is wrong.

5. **A job triggered by an event runs before the work loop looks at that event**
   (0126 §4), so a lock is never one look late.

6. **The rules are code, not configuration.** No user crontab, until somebody
   needs one.

7. **The existing timers move into it** — the sweep, the rate refresh, the
   heartbeat — so one table says what the daemon does when.

## To design

- The interface: how a job is declared, how a one-shot is registered and
  cancelled, how a job's failure is said, and whether a failed job retries.
- Missed runs: the daemon was down at 00:00. 0126 needs each owner to re-check on
  start.
- Sleep and clock changes on a laptop.
- Whether `lingtai status` and `doctor` print the table of jobs and their next run.
- A test seam: a clock the tests drive.
- Which existing timers move, each one read first.
