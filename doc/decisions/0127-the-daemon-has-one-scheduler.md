# 0127 — The daemon has one scheduler, and a scheduled job only looks outside the log and appends

**Status** proposed · 2026-11-11 · agreed except the interface, being designed

The daemon does things at times and on events as well as in passes. One
scheduler inside the daemon holds every such job — by a cron rule, at an instant,
or on an event — and a job only looks at what is outside the log (the clock, the
configuration, GitHub) and appends events, or writes the beacon.

## Context

The daemon kept its timers where each was needed: the work loop's five-minute
sweep (`packages/daemon/src/work-loop.ts`), the hourly rate refresh and the
listener for a shutdown on a daemon that conducts nothing (`apps/cli/src/daemon.ts`),
and the beacon's heartbeat (`packages/daemon/src/control.ts`).
[0126](0126-a-stop-is-a-lock-and-an-unlock.md) adds jobs that run at a time or on
an event rather than in a pass: the day's ceiling after each `RunSpent` and at
local midnight, an account limit at its `until`. Nothing said, in one place, what
the daemon does when.

## Decision

1. **A scheduler is a module inside the daemon, not a process of its own.** Its
   jobs append events, and only the conductor-lock holder appends what they
   append ([0100](0100-one-append-only-log.md) §13); a second process would be a
   second writer with its own lock, beacon and supervision. It runs in whichever
   process holds the conductor lock: the daemon, or a `lingtai run`. It is built
   on Effect's `Cron` and `Schedule`, and tested with `TestClock`; it parses no
   rule of its own.

2. **One registry, three triggers.**
   - *A cron rule*: every five minutes, every day at 00:00 local.
   - *An instant*, registered by whoever learned it: the account watcher
     registers `until` when `AccountLimitReached` is appended.
   - *An event type*: the ceiling watcher runs on each `RunSpent`.

3. **A job triggered by an event runs before the work loop looks at that
   event.** The subscription hands each event to the jobs that trigger on its
   type, waits for them to append, and only then wakes the work loop (0126 §4),
   so a lock is never one look late.

4. **Due is decided by the wall clock, and a missed run runs once.** Each job
   holds the instant it is next due. The scheduler compares the wall clock with
   it on a short tick rather than trusting one long timer, which a laptop's
   sleep stretches; a job past due runs once, however many runs it missed. A
   start checks every job at once, so a midnight or an `until` passed while no
   conductor was up is acted on at start. A changed system clock or time zone is
   the same case.

5. **A one-shot job is not stored; it is derived.** On start, each job's owner
   reads its state from the log and registers again what it implies (an
   `acct-{runtime}` locked until 23:00 registers 23:00). The log stays the only
   record, and a restart loses nothing.

6. **A job looks at what is outside the log and appends events, or writes the
   beacon.** The clock, the configuration file, GitHub. It never edits a state
   and never cleans up: state is replayed, and a job that needs to clean is a sign
   the model is wrong. The beacon, the one mutable row of operational state
   ([0102](0102-one-conductor-holds-the-lock.md) §2), is the exception, and only
   its heartbeat writes it.

7. **Every recurring timer of the daemon moves into it**: the sweep, the rate
   refresh, the beacon's heartbeat, and the shutdown listener of a daemon that
   conducts nothing. A timeout that belongs to one operation stays where it is
   (a drain's `--timeout`, a subscriber's limit, a retry's backoff): it is not
   something the daemon does at a time.

8. **A job's failure is operational state, not an event.** Each job's next due
   instant, last result and last error are held in memory and written with the
   beacon; `lingtai doctor` prints the table and fails on a job that keeps
   failing. A failed job runs again when it is next due. Nothing is appended for a
   failure: a job failing every tick would otherwise fill the log.

9. **The rules are code, not configuration.** No user crontab, until somebody
   needs one.

## To design

- The interface: how a job is declared, how a one-shot is registered and
  cancelled, the tick's length, and what "keeps failing" means for `doctor`.
- Whether `lingtai status` prints the table too.
