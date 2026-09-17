# 0048 — A signal is aimed at one daemon, so the restart hands nothing to the next

**Status** accepted · 2026-09-16 · **supersedes [0030](0030-shutting-down-safely.md)
§2's *a daemon that is down finds the command waiting*** and
**[0042](0042-the-restart-is-a-command.md) §8's handoff** · the rest of both stands

## Context

`#159` scoped every control signal to the daemon that was running when it was
appended. A conductor keeps a watermark — where `ctl-conductor` stood before it
took the lock — and folds only what lies after it (`readControl(store, since)`,
`controlWatermark`, read in `startDaemon` before the lock since #174). So a
`lingtai shutdown` stops the daemon it was aimed at and not the next one, and
`lingtai start` needs nothing lifted first. `37013f4` built it; five tests pin
that `pause` and `resume` cannot affect a start.

Two sentences written before that are no longer true.

**0030 §2**: *"a daemon that is down finds the command waiting rather than
making it a race somebody has to handle."* A daemon that is down, and then
started, reads nothing asked before it started. That was the point of #159.

**0042 §8**: a restart under launchd or systemd withdrew its drain with a
**handoff** — who, why, and the commit its checks examined — and the daemon the
supervisor started read the handoff off the fold and took the restart's name
when it ran that commit. That daemon's watermark is after the withdrawal, so it
never read one. Every supervised start recorded itself as `daemon` with
`handoff: null`, and the restart waiting 90 seconds for a start that answered
its handoff exited 1 on a start that had happened.

`#159` asked which parts of the handoff machinery were still earning their
place. Two agents answered it; two reviewers refused both, with six findings
and four `major`, and **every finding was the same shape**: the supervised path
built without a check the terminal path already made (#167). Both builds were
green. The terminal path is the one a person can run and watch refuse; the
supervised path runs only when a supervisor starts a process, which is not
while anybody is watching.

## Decision

### 1. What of 0030 stands

All of it but one clause of §2.

| | stands? |
|---|---|
| §1 the boundary is the pass | **yes** — `service shutdown` and `restart` wait for the pass, as `shutdown` does |
| §2 the trigger is a command | **yes**, and *a daemon that is down finds it waiting* is **superseded**: a request is read only by a daemon running when it was appended |
| §3 the agent's own process group | **yes** |
| §4 Ctrl+C says what is happening | **yes** |
| §5 an orphan is killed, host and argv guarded | **yes** |
| §6 no default timeout | **yes** — and `--force` (#159) is the other way out of the drain, on `shutdown` and `restart` both |

The drain is still the default. What changed is only that the request no longer
outlives the daemon.

### 2. The handoff is deleted

Machinery that is deleted cannot be asymmetric. Each piece, and what became of it:

| piece | | why |
|---|---|---|
| `ControlState.handoff`, `Handoff`, `HANDOFF_LAPSES_MS` | **deleted** | folded for a daemon that, since #159, never folds the withdrawal carrying it |
| `attributeStart`'s handoff branch | **deleted** | a supervisor's start is `daemon`, as launchd's own respawns always were; the restart names itself on its own drain and withdrawal |
| `startSupervised` | **deleted** | it waited for a start answering a handoff, which could not arrive |
| `withdrawShutdown`'s `handoff` argument | **deleted** | nothing reads it; the event's field is written `null` |
| `ConductorShutdownWithdrawn.handoff`, `ConductorStarted.handoff` | **kept in the schema, never written** | the log is append-only; events carrying them must still parse, and the fold reads them as nothing |
| `withdrawShutdown`, `ConductorShutdownWithdrawn` | **still called** | by `lingtai restart` and `lingtai service shutdown`, for their own request by version. Not so the next daemon can start — it never reads the request — but because the request otherwise stands in the fold for ever, and the board, `lingtai status` and every *has somebody asked this to stop* refusal would go on saying yes about a stop that is over. `resume` would lift it too, and a person's pause with it |
| `startAfter` (the ticket's `firstStartAfter`) | **still called**, differently | it is how a supervisor's start is confirmed (§4), and how a restart knows a daemon started during its wait (§5) |

### 3. The supervised restart is the terminal restart's checks around `service`'s drain and start

```
checkBeforeTheDrain   — the terminal path's function
service shutdown      — #174's drain: queue for the lock, ask, hold it through the unload
checkAfterTheWait     — the terminal path's function, with nothing supervised running
service start         — which waits for ConductorStarted (§4)
startRefusals         — on that record: the commit checked, and no drain stepped over
```

Holding the lock through the unload is what 0042 §8's handoff could not give:
the copy KeepAlive starts when the drained daemon exits cannot take work on code
nobody checked, because it cannot take the lock. A refusal after the wait leaves
the service unloaded and says so — nothing supervised runs, and nothing starts
on a commit that refused.

A drain **this person** already asked for is taken over on both paths by
withdrawing it and asking again, rather than waited on as it stands. A request
older than the daemon now holding the lock is one that daemon never obeys, and a
restart waiting on it would wait for ever.

### 4. A start is what the daemon records, not what the supervisor answers

`launchctl bootstrap` and `systemctl start` exit 0 when the job was asked for.
The daemon may then lose the lock or read a drain, record nothing, and exit 0
for the supervisor to start again every thirty seconds. So `service start`,
`service restart` and `service install` take the control watermark before the
supervisor call, wait up to 120 seconds for a `ConductorStarted` after it, say
which start it was, and **exit 1 without one** — never a line that could be read
as work being taken. A daemon the supervisor is already running is said to be
running and not waited for.

### 5. Every refusal is on both paths, and the table is the test

`RESTART_GUARDS` in `apps/cli/src/restart.ts` lists every refusal with the place
each path makes it. `apps/cli/pure/restart.test.ts` holds one scene per row and
plays it through both commands — `prepareRestart` and `restartSupervised`, the
second over the real `serviceCommand` — and fails on a row with a missing side
or a missing scene.

One row is honestly different in kind. The terminal path asks `startRefusals`
inside the daemon, before it takes anything, and starts nothing. The supervised
path can only ask it of the record the supervisor's daemon leaves, so there the
commit that moved in the second between the checks and the spawn is **said, with
exit 1, while that daemon runs**. The process is the supervisor's; the only way
to refuse inside it is to carry the checked commit to it, which was the handoff.

The five asymmetries #167 named, and which answer each got:

| finding | answer | test |
|---|---|---|
| major — a start adopting a standing drain carried no handoff, so no identity check ran | **impossible by construction**: there is no handoff, and the checks after the wait are the terminal path's function | *a start that takes over a drain already standing still has its code checked after the wait* |
| major — a failed record's watermark fell after another person's drain, which the daemon then ignored | **guarded**: `service start` refuses while a drain stands, and `startRefusals` on the record says one that landed during the start | *a drain that lands while the supervisor starts the daemon is not stepped over in silence*; row `drain-at-start` |
| major — `service start` said the new daemon takes work while every copy recorded nothing and exited 0 | **guarded**, and the overruled-handoff state that produced it is gone | `service.test.ts` › *a start the daemon never recorded*; row `nothing-started` |
| minor — no re-check that the commit is still on the remote | **guarded**: `checkAfterTheWait` | *a force-push during the drain is refused as the terminal path refuses it*; row `after-unpushed` |
| minor — a refusal after the wait advised `lingtai resume` over a daemon started since | **guarded**: `startedSince` is read, refused on, and removes that advice | *a refusal after the wait never advises lifting a drain aimed at a daemon that started since*; row `after-foreign-drain` |

## Consequences

- `lingtai service shutdown` then `lingtai service start` is one command to stop
  and one to start, with nothing lifted between — the complaint #159 was opened
  for, pinned by *one command to stop, one to start*.
- 0042's three refusals — an unpushed `HEAD`, a dirty worktree, a failed doctor —
  refuse on both paths, before the drain and, for the first two, after it.
- A restart under a supervisor is recorded as the restart's drain and withdrawal
  by `human:<you>`, then a `ConductorStarted` by `daemon`. The log no longer
  claims the supervisor's process was started by a person; it never truthfully
  could.
- `service start` can now take two minutes to return, and says so as it starts.

## What this does not decide

**The lock's mechanism.** [0046](0046-lingtai-is-personal.md) §1 moves it from
`pg_try_advisory_lock` to `flock(2)`. `service shutdown`'s *queue for the lock
and hold it through the unload* is written against Postgres's queue of waiting
sessions; `flock` has a blocking acquire with the same property, and whichever
lands second carries that across. Nothing in this ADR depends on the lock being
in Postgres.

**Whether a daemon should restart itself when `main` moves.** Still no, and
still 0042's to leave open.
