# 0045 — A shutdown request ends at the next start, so a restart is `shutdown` and then `start`

**Status** accepted · 2026-09-15 · supersedes
[0030](0030-shutting-down-safely.md) §2's *a daemon that is down finds the
command waiting*, and [0042](0042-the-restart-is-a-command.md) §7 and the
withdrawal, the lapse and the post-wait refusal under a supervisor in §8;
closes #159

## Context

Stopping the daemon left a latch that stopped the next one. `lingtai shutdown`
appended `ConductorShutdownRequested`, the request stood until something lifted
it, and the next daemon to start read it and stopped too — `lingtai resume`, a
command about *taking work*, as the way to make a process stay up.

`37013f4` removed the latch at the reader: a conductor reads `ctl-conductor`
from where the stream was when it started (`readControl(store, since)`), so a
signal made before it is **invisible** to it rather than **withdrawn**.

That deleted the premise 0042 §7 was written on — *the request stands in the
stream for ever, so the daemon about to start would read it and stop again* —
and left `restart` as 0042's dance:

```
refuse → drain → wait → withdrawShutdown(by version, with handoff) → service start → wait for the start to be recorded
```

#159 asked which of that is now dead weight. Reading it with the code in front
of us found that the question was not only about dead weight. Three things were
already wrong after `37013f4`:

1. **The supervised handoff could not be read.** It rode on the withdrawal,
   appended before the supervisor's start; the daemon attributed its start off
   its scoped read, whose watermark was taken after the lock. The handoff was
   before the watermark, so every supervised restart would have been recorded as
   `daemon`, and the restart waiting on it would have exited 1 saying *not the
   one this handed off*.
2. **The supervisor's respawn no longer waits for anything.** A launchd
   `KeepAlive` respawn used to read the restart's standing request and exit,
   every thirty seconds, until the withdrawal; that is what let the restart
   check the commit again after the drain *before* the supervisor started. Now
   the respawn takes the lock the moment the drained daemon exits, and can do so
   between two of the restart's polls — a wait for the lock to be free then
   never ends, and the restart's check after the wait never runs before a start
   it was meant to gate.
3. **The whole-stream readers kept the latch.** The board, `lingtai doctor`,
   `lingtai service start` and `restart`'s own *somebody else's drain* rule fold
   the whole stream. With nothing withdrawing a request, they would report every
   request ever made as standing: `service start` refused for ever, and the next
   `restart` refused over a drain from last week. A `--no-conduct` daemon still
   folded the whole stream too, so it obeyed a request aimed at the daemon
   before it.

The first attempt at this ticket found the same three and was refused three
times in review, and the refusals are worth reading because they all came from
two additions rather than from the core. It added a **latch** — a supervised
start that takes no work over somebody else's drain standing on top of a
restart's handoff — and a **late record** for a start whose `ConductorStarted`
could not be appended. Each closed one ordering and opened another: a late
record whose watermark already hid the drain it should have held for, and
`service start` saying a daemon takes work while the latch made every copy exit.
This decision keeps what was sound and takes neither addition, and says below
what not taking them costs.

## Decision

### 1. A start ends every request made before it

`reduceControl` sets `shutdown` to null at `ConductorStarted`. It is what the
daemon already does by reading from its own start, said once more for every
reader that folds the whole stream, so the board and the daemon cannot disagree
about whether a drain stands. **Nothing is appended to take a request back**:
the start is the fact that ends it.

**A pause ends there too.** The daemon reads from its own start, so a pause
made before it was already not its to obey; a fold that kept it said *paused*
over a daemon taking work — on the board, in `lingtai doctor` and `lingtai
status` — and the quota stand-down (0031 §3), folding the whole stream, saw
`paused` and appended no pause of its own, so the daemon went on claiming
against an exhausted account. A `lingtai run` with no daemon between it and the
pause is still held by it.

`ConductorResumed` still lifts a request. Nothing needs it to.

### 2. The record is the watermark, and it is fatal to miss

The fold in §1 is only honest if nothing can be said between the stream a daemon
reads past and the start that ends what came before. So `recordStart` reads the
stream, hands its fold to the attribution, appends `ConductorStarted` **at the
version of that read**, and returns the version it landed at, which is the
daemon's `since`. A lost version race reads, decides and appends again. A drain
asked a moment after the start lands after it — in the log, in the daemon's
read and in every fold.

It moved from the loop's first control read to straight after the lock and the
commit, before the beacon. It had been deferred (`startRecorder`) because a
restart's withdrawal could land between a startup read and the loop's; there is
no withdrawal.

**A start whose record cannot be appended takes nothing and exits 1.** It used to
be reported and survived, for a version race — which is retried now. What is
left is a store this process cannot append to, and a conductor that cannot append
one event to `ctl-conductor` cannot append a run either; it also has no
watermark, and every way of inventing one reopens the window §2 closes. Under a
supervisor the next attempt is thirty seconds away. This is the choice that
removes the first attempt's late record, and with it the refusal that record
earned.

### 3. The handoff rides on the restart's own request

A supervised restart's start still has to know whose restart it is — 0042's
evening is a start nobody can name. So `ConductorShutdownRequested` gains
`handoff: { sha, dirty } | null`, set only by a restart the supervisor is to
start. The daemon reads it off the request its start ends — the fold `recordStart`
hands the attribution — and the rules are 0042 §8's, unchanged: the restart's
`by` and `reason` only on the commit it checked; `daemon`, saying why, on any
other; the typist's at a terminal. `ConductorStarted.handoff` names the request.

**`HANDOFF_LAPSES_MS` is deleted.** It measured five minutes from the withdrawal,
which came after the drain. The request comes before the drain, which can take
an hour, so a lapse from there would expire during the very wait it is for. The
handoff ends at the next start, whoever makes it, or at a newer drain. What that
gives up, named: a supervisor that never starts anything after the drain leaves
the handoff on a standing request, and a start much later with no terminal, **on
the same checked commit**, is recorded as the restart's.

### 4. Under a supervisor, a shutdown is a restart — and the restart reports

This is the consequence the first attempt tried to legislate away, and it is
accepted here rather than latched:

**Under launchd's `KeepAlive` or systemd's `Restart=always`, any `lingtai
shutdown` is a restart.** The drained daemon exits, the supervisor starts the
next, and the next reads nothing said before it. That has been true since
`37013f4`; it was hidden only by the readers in Context 3. Holding the successor
back over a request is precisely the latch #159 was opened to remove, and a
narrower latch — only over a drain standing on a restart's handoff — is a rule
with two shapes that the first attempt could not make consistent across a failed
record, `service start` and the restart's own report. What keeps a supervised
daemon down is the supervisor's verb, and the commands now say so:
`lingtai shutdown` prints it when a supervisor keeps the daemon, and
`service stop` offers `pause` rather than `shutdown` as the way to wait for a
pass.

So a supervised `restart`:

- asks its drain with the handoff, even when nothing is conducting;
- waits until the lock is free **or** a start is recorded after its request;
- does not check the commit and worktree again *in this process* as a refusal
  — the respawn does not wait for this command, and reads the disk for itself —
  so **the respawn runs that check on itself**: a start that ends a request
  carrying a handoff, on a commit other than the one checked, takes nothing
  when the restart's checks would refuse it — not on the remote, not
  establishable, or dirty where the restart's was not. Every copy the supervisor
  brings back declines the same until the checkout is fixed or `service stop`,
  which is the refusal 0042 promised, kept where it can still refuse. A checkout
  that moved on to pushed, clean code — a merge during the drain — starts as
  `daemon`. The restart says the same when it sees it after the wait, rather
  than timing out;
- runs `service start` only if no start is recorded yet;
- waits up to 90 seconds for the record and exits 0 only for a start that names
  its request, as its person, on the commit it examined. **That comparison is
  what the second check became.** Anything else — a different commit, a start
  typed at a terminal, a drain somebody asked for during the wait that hid the
  handoff — it names, and exits 1.

In a terminal nothing about the checks changes: the restart starts the daemon
itself, so the check after the wait still refuses, including over a drain
somebody else asked for during it. And the one window that check cannot see —
between reading the stream and winning the lock — is closed by the attribution:
**a restart in this process records nothing, and takes nothing, over a request
that is not its own.** It is the only start that ever declines, because it is
the only one whose checks promised not to start over somebody else's drain.

### 5. `lingtai service` starts over a standing request

`service start`, `restart` and `install` refused while a request stood, on the
grounds that a daemon started then would read it and exit until `lingtai
resume`. That stopped being true at `37013f4`; after §1 the start also ends the
request everywhere else. So they start, and the `shutdown` and `pause` readers
they were handed for the refusal are gone.

## What stands

**0030 stands**, one sentence aside. The boundary is the pass (§1); the trigger is
a command (§2); the agent has its own process group (§3); Ctrl+C says what it
costs (§4); an orphan is killed and not waited out (§5); there is no default
timeout (§6). The drain is still the default, and `--force` is the way out of
it. What §2 said that no longer holds is *a daemon that is down finds the
command waiting*: a shutdown is aimed at the daemon running when it is made, and
a daemon that is down is not one.

**0042 stands in its checks and its order.** A `HEAD` the tracking remote does not
have refuses and nothing overrides it; a dirty worktree refuses and `--dirty`
waives it; a failed doctor refuses and `--despite-doctor` waives it — all before
anything stops, and asserted in `restart.test.ts`'s *what a restart refuses*.
The re-check after the wait stands in a terminal. `ConductorStarted` stands, and
now always happens. §6, the lock, stands. §7 is superseded, and in §8 the
withdrawal, the lapse and the refusal after the wait under a supervisor are.

## The machinery, piece by piece

| | | why |
|---|---|---|
| `withdrawShutdown`, `Withdrawal` | **deleted** | They withdrew a request so the next daemon would not read it. The next daemon reads nothing before its start, and the fold ends it there (§1). |
| `ConductorShutdownWithdrawn` | **appended by nothing; schema and fold kept** | The log has them, and replay must read them as it did. It no longer makes a handoff. |
| `ControlState.handoff`, `Handoff` | **deleted** | The handoff is a field of the request it rides on (§3). |
| `HANDOFF_LAPSES_MS` | **deleted** | A clock from the request would expire during the drain (§3). |
| `attributeStart` | **kept, handoff branch kept**; *start into a standing drain is not recorded* **deleted**; declines only for a terminal restart over another request, or a supervisor's start off a handoff on a commit the restart's checks refuse | §2, §4. |
| `startRecorder` | **deleted** | It deferred the record to the loop's read because a withdrawal could land between two reads. `recordStart` decides and appends at one. |
| `controlWatermark` | **deleted** | The record is the watermark (§2). |
| `recordStart` | **kept; decides at its read, returns the version, and is fatal to miss** | §2. |
| `startAfter` / waiting for the start to be recorded | **kept, and used earlier** | The respawn waits for nothing, so the record is the only way a supervised restart can *say* whether it started anything — and it ends the drain's wait as well (§4). |
| `requestShutdownUnlessStanding` | **kept; carries the handoff** | Appending over somebody else's drain would hide it, and the start would then end it unread. |
| the check after the wait | **kept in a terminal; a comparison under a supervisor** | §4. |

## Consequences

- `lingtai shutdown` then `lingtai start` is one command each and two events;
  `shutdown.test.ts`'s *stopping and starting* asserts the stream is exactly
  `ConductorStarted`, `ConductorShutdownRequested`, `ConductorStarted`, that the
  new daemon hears nothing, and that the whole-stream fold agrees.
- `lingtai restart` appends the same two. There is no event between them that
  another event has to undo.
- A `--no-conduct` daemon hears only shutdowns made after its start.
- `ConductorShutdownRequested.handoff` is additive and defaulted; starts written
  before this name a withdrawal on `ConductorStarted.handoff`, and are read as
  they were.

## What this does not decide

- **Whether a supervised daemon should be stoppable through the control stream
  at all**, rather than through the supervisor. Today it is not (§4), and the
  commands say so.
- **Whether a daemon should notice its own code is stale**, which 0030 and 0042
  both left open, and this does too.
