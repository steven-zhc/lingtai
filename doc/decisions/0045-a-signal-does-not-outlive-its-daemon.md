# 0045 — A signal does not outlive its daemon, so a restart is `shutdown` and then `start`

**Status** accepted · 2026-09-15 · supersedes [0030](0030-shutting-down-safely.md)
§2's *a daemon that is down finds the command waiting*, and
[0042](0042-the-restart-is-a-command.md) §7 and the withdrawal and lapse in §8;
closes #159

## Context

Stopping the daemon left a latch that stopped the next one. `lingtai shutdown`
appended `ConductorShutdownRequested`, the request stood until something lifted
it, and the next daemon to start read it and stopped too. The log carries it: a
request at v59, a `ConductorResumed` at v61 and a `ConductorStarted` at v62, one
morning, one minute apart — `lingtai resume`, a command about *taking work*, as
the way to make a process stay up.

`37013f4` removed the latch at the reader. A conductor reads `ctl-conductor`
from where the stream was when it started (`readControl(store, since)`), so a
signal made before it began is **invisible** to it rather than **withdrawn**.

That deleted a premise the restart was built on. 0042 §7 is explicit about it:

> The request stands in the stream for ever, so the daemon about to start would
> read it and stop again.

and `control.ts` said the same in its header until this change: *the request
outlives the daemon it was aimed at, so without something to withdraw it the
next daemon to start would read it and stop again.* So `restart` was still
0042's dance after `37013f4` —

```
refuse → drain → wait → withdrawShutdown(by version, with handoff) → service start → wait for the start to be recorded
```

— with the fourth step answering a problem that no longer existed. The
question #159 left was not how to rewrite `restart` as `shutdown` + `start`,
but which of the machinery around the withdrawal was now dead weight.

Reading it with the code in front of us found three things the ticket had not
listed, and they decided most of the rest:

1. **The handoff was already broken.** A supervised daemon attributed its start
   off the loop's control read, which `37013f4` scoped to `since` — taken after
   the lock, so after the withdrawal that carried the handoff. The handoff was
   before the watermark, so the fold the daemon read never had one. Every
   supervised restart since `37013f4` would have been recorded as `daemon`, and
   the restart waiting on it would have reported *not the one this handed off*.
2. **The supervisor's respawn no longer waits.** Before `37013f4` a launchd
   `KeepAlive` respawn read the restart's standing request and exited, every
   thirty seconds, until the withdrawal — which is what let the restart check
   the commit again after the drain, *and then* let the supervisor start. Now
   the respawn takes work the moment the drained daemon exits. It can take the
   lock between two of the restart's polls, and a wait for the lock to be free
   then never ends.
3. **The unscoped fold still had the latch.** The board's chip, `lingtai
   doctor`, `service start`'s refusal and `restart`'s own *somebody else's drain*
   rule all fold the whole stream. With nothing withdrawing a restart's request,
   those readers would report it standing for ever — and the next `lingtai
   shutdown` through `requestShutdownUnlessStanding` would find it and ask
   nothing. And a `--no-conduct` daemon still read the whole stream, so it
   obeyed a request made to the daemon before it.

## Decision

### 1. A start ends what was said before it

`reduceControl` ends a standing `ConductorShutdownRequested` at
`ConductorStarted`. It is what the daemon already does by reading from its
start, said once more for every reader that folds the whole stream, so the
board and the daemon cannot disagree about whether a drain stands.

**Nothing is appended to take a request back.** The start is a fact in its own
right, and this is what it means. `ConductorResumed` still lifts a request in
the fold as it always did; it is no longer something anyone needs.

A pause is not touched by a start, in the fold. `pause` and `resume` are about
the daemon that is running, and the daemon already reads its own from `since`;
whether the whole-stream readers should say the same is a question about the
pause axis and is not decided here.

### 2. The start is recorded at its watermark

That fold is only true if nothing can land between the stream a daemon reads
past and the start that ends it — otherwise a request aimed at the new daemon
could arrive before its `ConductorStarted`, be invisible to it (before the
watermark) and ended in the fold (before the start). So `recordStart` appends
at the version of the read that decided who the start is, retries on a lost
race by reading and deciding again, and **returns the version it landed at,
which is the daemon's `since`**. The watermark and the record are one append.

It moved from the loop's first read to straight after the lock and the commit.
It had been deferred to that read (`startRecorder`) because a restart's
withdrawal could land between a startup read and the loop's; nothing is
withdrawn now. A start whose record fails is reported and conducts anyway, as
before, and takes the stream's length — read after the lock, before the record
was attempted — as its watermark instead: it reads past what was said before it
exactly as a recorded start does, so a restart whose record fails does not
drain straight back out on its own request. The fold has no start to end that
request at, so the daemon tries the record again on each read it acts on
(`recordStartLate`), and only while nothing said to it since its watermark
stands — a late start over a request it is obeying would show that request
ended.

There is no longer a start that is not recorded. *A start into a standing drain
is not recorded* existed because such a start read the request and exited, and
under a supervisor did so every thirty seconds. A start reads nothing said
before it now.

### 3. The handoff rides on the restart's own request

The supervised start still has to know whose restart it is — 0042's evening is
a start nobody can name, and the failure to avoid on the way is one the log
names wrongly. So `ConductorShutdownRequested` gains `handoff: { sha, dirty } |
null`, set only by a restart the supervisor is to start, and `recordStart`
hands `attributeStart` the fold of the stream **before** the start, which is
where that request is. The rules for who a start is are 0042 §8's, unchanged:
the restart's name only on the commit it checked, `daemon` with the reason on
any other, the typist's at a terminal.

**`HANDOFF_LAPSES_MS` is deleted.** It measured five minutes from the
withdrawal, which was appended after the drain. The request is appended
*before* the drain, which can take an hour; a lapse from there would expire
during the very drain it waits on, and there is no event at the drain's end to
measure from without appending one. The handoff now ends at the next start,
whoever makes it, or at a newer drain. What that gives up is named rather than
hidden: a supervisor that never starts anything after the drain — refused, or
unloaded — leaves the handoff standing, and a non-terminal start much later **on
the same checked commit** is recorded as the restart's. On any other commit it
is `daemon`, as before.

### 4. Under a supervisor, the second check is a report

The check after the wait could refuse only while the standing request held the
supervisor's respawns back (Context, 2). Nothing holds a start back now, and
putting it back would be the latch this closes. So a supervised restart:

- waits until the lock is free **or** a start is recorded after its request,
  whichever comes first;
- does not check the commit and worktree again — the daemon reads the disk when
  it starts, whatever the restart says — but does refuse on a drain somebody
  else asked for during the wait, which the supervisor's start refuses too (§5);
- runs `service start`, which no longer refuses on a standing request at all
  (§6);
- waits for the start to be recorded and exits non-zero on one that is not its
  handoff, as itself, on the commit it examined. That comparison is what the
  second check has become.

In a terminal nothing changes: the restart starts the daemon itself, so the
check after the wait still refuses.

### 6. `lingtai service` starts over a standing request

`service start`, `restart` and `install` refused while a request stood, saying a
daemon started then would read it and exit until `lingtai resume`. That stopped
being true at `37013f4`, and after §1 and §2 the start is exactly what the
operator asked for — so they start, and say whose request stands and that the
start ends it. `service restart`'s advice for waiting on the pass is `lingtai
restart` or `lingtai shutdown`, with nothing to lift afterwards.

### 5. What stands

**0030 stands** except one sentence. The boundary is the pass (§1), the trigger
is a command (§2), the agent has its own process group (§3), Ctrl+C says what it
costs (§4), an orphan is killed and not waited out (§5), and there is no default
timeout (§6). The drain is still the default, and `--force` (#159) is the way
out of it. What §2 said that no longer holds is *a daemon that is down finds the
command waiting*: a shutdown is aimed at the daemon running when it is made,
and a daemon that is down is not one.

**0042 stands** in its checks and its order. A `HEAD` the tracking remote does
not have refuses and nothing overrides it; a dirty worktree refuses and
`--dirty` waives it; a failed doctor refuses and `--despite-doctor` waives it;
all of them before anything stops (`restart.test.ts`, *what a restart refuses*).
A drain somebody else asked for still refuses, and is now ended by a start as
well as by `resume`. §7 — the withdrawal — and the lapse in §8 are superseded.

Under a supervisor that refusal cannot be the restart's alone, because the
respawn comes before the restart can look (§4). So it is the start's too: a
start with no terminal and no restart in its process, reading a request **with
no handoff, by somebody other than the restart's person**, standing over a
restart's handoff, takes no work and records nothing (`overruledHandoff`,
`StartHeld`). The request goes on standing in every fold, the supervisor's
copies each read it and exit, and the restart refuses after its wait with the
same sentence a terminal one prints; `lingtai resume` lifts it. That is a
latch, and deliberately a narrow one — a plain `lingtai shutdown` under a
supervisor with no restart in flight is still the restart, with nothing to
lift.

## The machinery, piece by piece

| | | why |
|---|---|---|
| `withdrawShutdown` | **deleted** | It withdrew a request so the next daemon would not read it. The next daemon reads nothing before its start. |
| `ConductorShutdownWithdrawn` | **appended by nothing; schema and fold kept** | The log keeps every one written before, and replay must read them as it did. The fold still lifts the request one names; it no longer makes a handoff. |
| `Withdrawal` type | **deleted** | Went with `withdrawShutdown`. |
| `ControlState.handoff` / `Handoff` | **kept, set from the request** | The supervised start still needs to know whose restart it is (§3). |
| `HANDOFF_LAPSES_MS` | **deleted** | A clock from the request would expire during the drain (§3). |
| `attributeStart` | **kept; the handoff branch kept; `record: false` deleted** | The branch is 0042 §8's rule and still true. A start into a standing drain cannot happen (§2). |
| `startRecorder` | **deleted** | It deferred the record to the loop's read because a withdrawal could land between two reads. `recordStart` decides and appends at one read. |
| `recordStart` | **kept; takes the attribution, appends at its read, returns the watermark** | §2. |
| `controlWatermark` | **kept, as the fallback** | For a start whose record failed: the stream's length after the lock, and `recordStartLate` records the start once it can (§2). |
| `startAfter` — waiting for the start to be recorded | **kept, and used earlier** | The respawn waits for nothing, so the record is the only way a supervised restart can *say* whether it started anything — and it now also ends the drain's wait (§4). |
| `requestShutdownUnlessStanding` | **kept; carries the handoff** | Appending over somebody else's drain would still hide it. |
| the check after the wait | **kept in a terminal; a report under a supervisor** | §4. |

## Consequences

- `lingtai shutdown` then `lingtai start` is two commands and two events, and
  `shutdown.test.ts`'s *one command to stop and one to start* asserts the
  events are exactly `ConductorStarted`, `ConductorShutdownRequested`,
  `ConductorStarted` — and that the whole-stream fold agrees with the daemon.
- A supervised restart's log is its request and the supervisor's start, with
  the start naming the request.
- A `--no-conduct` daemon hears only shutdowns made after its start, as a
  conducting one does.
- `ConductorShutdownRequested.handoff` and the new meaning of
  `ConductorStarted.handoff` (the request's version; a withdrawal's on starts
  written before this) are additive and defaulted, so no stored payload changes
  shape.

## What this does not decide

- **Whether the whole-stream readers scope a pause** as the daemon does (§1).
- **Whether a daemon should notice its own code is stale**, which 0030 and 0042
  both left open, and this does too.
