# 0042 — The restart is a command, the checks come before the drain, and a start is an event

**Status** accepted · 2026-09-13 · completes
[0030](0030-shutting-down-safely.md), which decided the stop and left the start

## Context

0030 made stopping safe. `lingtai shutdown "why"` appends, returns, and the
daemon finishes the pass in flight — the agent, the gates, the merge lane and
the `end` point — before it exits. It says what it is waiting for and Ctrl+C
does the same thing with the same sentences.

**Starting again was still something you typed from memory, at a moment nothing
told you had arrived.** `CLAUDE.md` said so in as many words:

> Neither restarts it — that is still yours, and **whether it should be is
> open**.

That looked like the easy half. It is the half where a process's code identity
is decided, for the whole of its life, with nothing checking it.

### One evening, 2026-09-09

A daemon was restarted at 23:06 and **nobody can say by whom**, because stopping
is an event and starting was not:

```ts
// packages/domain/src/events.ts — before this decision
export const ConductorResumed = z.object({ by: z.string() });
export const ConductorShutdownRequested = z.object({ by, reason, timeoutMs });
```

There was no `ConductorStarted`. A start left a beacon, and a beacon is *state*:
one mutable row that says a daemon is running now, overwritten by the next one.
It cannot say that one *started*, from what code, or at whose hand.

That daemon started from `582a0f8` — **a local commit that had not been
pushed**. A `git pull --rebase` twenty minutes later rewrote it to `2926f2d`,
and `lingtai doctor` then reported:

```
note  daemon: currency
      running 582a0f8 — 5 commit(s) behind origin/main
```

`582a0f8` is not reachable from `origin/main`; it is not reachable from
anything. The beacon named a commit that does not exist on the remote, and the
process held that code for as long as it ran.

That is [0010](0010-source-runs-unbuilt.md) biting from a direction nobody had
written down. *The source runs unbuilt* is read as "a merge takes effect
immediately". What it also means is that a process keeps whatever was on disk
**at import** — including code that was never pushed, and has since been
rewritten out of existence. `#98` measured the cost of the ordinary version of
this: `#88` landed thirty-nine minutes after a daemon started, never once ran,
and cost 52 prompts.

`doctor` was built to be the check and had no caller. The comment at its call
site has said so since it was written:

```ts
// apps/cli/src/lingtai.ts
// Non-zero on any failure, so this can gate a restart.
```

## Decision

### 1. `lingtai restart [why]` is one command: drain, wait, start

It asks the same drain `lingtai shutdown` does — the same append, not a second
mechanism — waits for the pass, checks the code again, withdraws the request,
and starts a daemon in this process. The wait says what it is finishing and repeats itself, so it never
reads as hung.

### 2. The checks run before anything stops

This is the ordering, and it is the design. A refusal that arrives *after* the
drain is a system that is down and a person reading about why it may not come
back up. Everything that can refuse — the commit, the worktree, `doctor` — is
asked while the old daemon is still conducting, so a refusal costs nothing but
the typing.

### 3. It refuses a commit the tracking remote does not have

`HEAD` must be reachable from the upstream ref — `origin/main` where a branch
has no upstream. Not *equal to*: a checkout that is a few commits behind is
running code anybody can fetch and read, which is all this asks. Being behind is
`daemon: currency`'s question and is not a reason to refuse a start.

A dirty worktree is named in the same refusal, because it is the same defect:
code that no commit names.

**One flag per refusal.** `--dirty` overrides the worktree and
`--despite-doctor` overrides §4. **Nothing overrides an unpushed commit**, or one
that could not be checked against the remote: that is the defect this decision
exists to close. An earlier draft had one `--anyway` covering all three, and the
review that refused it put the cost plainly — an unrelated, unrepairable doctor
failure trains the operator into the flag that also disables the unpushed-commit
check. What a flag waves through is still printed: it means *I have read this*,
not *do not tell me*.

**And again after the wait.** A drain can take an hour, and the commit and the
worktree are what the start freezes. They are read again once the lock is free,
and the daemon compares what it actually reads at startup against what that
check examined, starting nothing on a difference — so the commit on
`ConductorStarted` is one a refusal looked at.

**It never fetches.** Same rule as `lingtai doctor`: `origin/main` means the ref
as your last fetch left it. A refusal a `git fetch` answers is better than a
command that can hang.

### 4. `doctor` gates it

The exit code at `lingtai.ts`'s call site now has the caller it was written
for. The failed checks are printed — not the whole report, which is thirty green
lines between the command and the drain and is how the two red ones get scrolled
past.

**A failure whose remedy is the restart does not gate it.** `conductor: refusals
on the log` fails while a daemon is up and a project's last pass refused, and
when the refusing process is at an older commit than this checkout its detail
ends *that process is too old for it — restart it* (#148). Refusing that restart
unless `--despite-doctor` is typed would make the flag the ordinary way to take a
fix, which is the habit this section exists to avoid. The check marks such a
failure `restartAnswers`; it is printed and not counted. A refusal by the code
this checkout holds would refuse again after the restart, and still gates it.

### 5. A start appends `ConductorStarted`

Carrying who, why, the commit, whether the worktree was dirty, and `host:pid`
spelled the way `WorkItemClaimed.worker` spells it. Appended by the daemon
itself, after it has won the lock — so it records a start that *happened* rather
than one that was intended, and `lingtai daemon` typed by hand is in the log
beside `lingtai restart`.

**`by` names a person only where a person's hand is on it.** `lingtai restart`
records `human:$USER`, as `lingtai shutdown` does. A bare `lingtai daemon`
records `human:$USER` when its stdin is a terminal and `daemon` when it is not —
launchd's `KeepAlive` starts it with stdin on `/dev/null`, and a log that names a
person for a start launchd made by itself is 23:06 again, only confidently
wrong.

It does **not** withdraw a standing shutdown request. Starting and being told to
stop stay independent facts, and a daemon started while a request stands reads
it and stops again, which is the behaviour 0030 gave it. **That start is not
recorded**: it takes nothing, and under a supervisor it is repeated every thirty
seconds until the request is lifted — an hour's drain would put a hundred
`ConductorStarted` in the log, none of them a conductor.

### 6. The lock decides "exactly one", not any sequencing here

`lingtai run` and `lingtai daemon` already stand down on one advisory lock
(`#93`) and so does a second `lingtai restart`. That is what makes *never two
daemons* true, rather than the order of operations in this command: if anything
won the race for the lock while the drain was finishing, the restart says so,
starts nothing, and **exits non-zero**.

Losing that race is not the restart succeeding by another route, because what
won is not known to stay. A `lingtai run` in a terminal takes the same lock and
exits when its one pass ends; a copy something else started before the
withdrawal reads the request still standing and drains straight back out. Either way no daemon is
left. So the line says only that the lock was taken and nothing started,
`lingtai doctor` says whether a daemon is up, and if none is, `lingtai restart`
again waits for the lock and starts one.

The lock is only ever read through a query that can fail, and **a failed query
is not an empty lock**. Before the drain a failure is a refusal, since nothing
has stopped yet; during the wait it is one more poll with no answer, and the wait
goes on. Reading a network blip as *nobody is conducting* would withdraw the
drain while the old daemon is still in its pass, and it would carry on from the
stale commit with nothing asking it to stop.

The beacon is held to the same rule. One that could not be read refuses before
the drain, and one that is merely stale while the lock is held is **not** taken
to mean no daemon: a daemon whose beacon writes are failing keeps its lock and
never exits by itself. So the lock held with no fresh beacon is drained as well
as waited on — a `lingtai run` ignores the request and finishes its pass, and the
restart withdraws its own request before it starts.

### 7. The restart withdraws its own request, and nothing else

The request stands in the stream for ever, so the daemon about to start would
read it and stop again. `ConductorResumed` would withdraw it, and would also
lift a *pause*, which is somebody else's decision, and *any* request, including
one a second person made during the wait.

So there is a withdrawal that is only a withdrawal: **`ConductorShutdownWithdrawn`
names the request it lifts by its version on `ctl-conductor`**, and the fold
lifts the standing request only when it is that one. It is one append, at the
version of the read that decided it; if the stream moved in between, the store
refuses the append and the question is asked again. A pause is never touched.

An earlier draft resumed and then re-appended the pause, as two appends. The
review that refused it named both defects: anything that landed between the two
made the re-pause lose its race and a person's pause was gone, and the resume
lifted whichever request was standing when the wait ended.

A drain somebody else asked for is a **refusal no flag covers**, before the
drain and again after it: restarting over it would be this command deciding for
them. `lingtai resume` lifts it. A drain **you** asked for — a `lingtai
shutdown`, or a `restart` whose wait you Ctrl+C'd — is picked up: the next
`restart` waits on that request rather than refusing it or asking twice, which
is what makes the recovery the interrupt message prints actually work.

### 8. Under a supervisor, the start is the supervisor's

`lingtai service` (#50) landed beside this decision: launchd's `KeepAlive` or a
systemd unit's `Restart=always` keeps the daemon up. A restart that started the
daemon in its own terminal there would leave a conductor that dies with the
terminal, beside a supervised copy retrying the lock every thirty seconds and
taking over unchecked when it does. So `lingtai restart` asks, **before anything
stops**, whether a supervisor keeps the daemon — the job loaded under launchd,
the unit active under systemd; a file left after `service stop` keeps nothing.
It refuses a supervisor it could not ask, and a unit written from another
checkout, which would start code other than the code it checked.

Where one does, everything up to the withdrawal is §1–§7, with two differences.
The drain is asked even when nothing is conducting, because the withdrawal is
what carries the start to the supervisor and there is no withdrawal without a
request. And the withdrawal carries a **handoff** — the commit and worktree the
checks examined, beside the `by` and `reason` it already had. Then `service
start`.

The daemon the supervisor starts cannot know who typed the restart; the fold
tells it. `reduceControl` keeps the handoff until the next start — or five
minutes after the withdrawal, whichever is first — and that start
takes the restart's `by` and `reason` **only if it is running the commit that
was checked**, recording the handoff's version on `ConductorStarted.handoff`.
On any other commit it is recorded as `daemon`, saying which commit was checked
and which is running. A start typed at a terminal ends the handoff and is the
typist's; so does any start, so a handoff the supervisor never acted on cannot
be claimed days later by a daemon it has nothing to do with, and a newer drain
supersedes it. The lapse is what makes that true when nothing starts at all: a
supervisor that refused `service start` leaves the handoff standing, and without
it somebody else's `service start` the next day, on the same commit, would be
recorded as the restart's person and reason.

The restart then waits — up to 90 seconds, past two of the supervisor's
throttles — for the start to be recorded, and exits 0 only for one that
answered its handoff, as its person, on its commit. The record and not the
beacon, because the beacon says a daemon is beating and not whose start that
was. `--no-conduct` and `--no-merge` are refused there: the unit decides how the
supervisor starts the daemon.

The by-hand recipe `lingtai service` documented — `shutdown`, wait, `resume` —
is still correct and no longer necessary, and `resume` lifting a pause was its
sharpest edge. The restart withdraws only its own request, so a pause survives
it.

## Consequences

- `ConductorStarted` and `ConductorShutdownWithdrawn` join the control events.
  `reduceControl` folds the first only to end a handoff — it changes nothing
  about what the conductor has been told to do — and the second as above.
  `ShutdownRequest` carries its `version`, read from the envelope, so no stored
  payload changes shape.
- `lingtai doctor` gains a caller. Its exit code stops being a promise.
- **A `--no-conduct` daemon hears a shutdown now**, on the beacon's own timer.
  The work loop is what read the control stream, so a daemon told to take no
  work was deaf to `lingtai shutdown` entirely — the request landed, nothing
  read it, and the process stayed up. That was invisible while stopping was the
  whole of the command; a restart *waits* for the drain it asked for, and a
  drain nothing will ever perform is a wait that never ends.
- `daemon: currency` gains something that acts on it, which `#98` explicitly
  left for later.
- A restart is attributable. "Who restarted it at 23:06" is a question the log
  answers, and the commit it names is one that can still be fetched.
- `CLAUDE.md`'s "whether it should be is open" is answered for the *command*.

## What this does not decide

**Whether a daemon should restart itself when `main` moves.** It still does not.
`daemon: currency` reports, the board draws a chip, and a person decides — what
changed is that the deciding is now one command that cannot leave the system
holding a commit nobody can name. A reflex is a different decision with real
arguments on both sides, and it wants its own file.

**Whether `service restart` should become this.** It is still the supervisor's
signal, which waits seconds rather than a pass, and it still has uses — a unit
that must be reloaded now. `lingtai restart` is the checked start; the two are
documented side by side, and folding one into the other is a later decision.
