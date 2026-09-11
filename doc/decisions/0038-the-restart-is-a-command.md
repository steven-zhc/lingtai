# 0038 — The restart is a command, the checks come before the drain, and a start is an event

**Status** accepted · 2026-09-10 · completes
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
mechanism — waits for the pass, withdraws the request, and starts a daemon in
this process. The wait says what it is finishing and repeats itself, so it never
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
code that no commit names. `--anyway` starts in spite of both, and both are
still printed when it does — the flag means *I have read these*, not *do not
tell me*.

**It never fetches.** Same rule as `lingtai doctor`: `origin/main` means the ref
as your last fetch left it. A refusal a `git fetch` answers is better than a
command that can hang.

### 4. `doctor` gates it

The exit code at `lingtai.ts`'s call site now has the caller it was written
for. The failed checks are printed — not the whole report, which is thirty green
lines between the command and the drain and is how the two red ones get scrolled
past.

### 5. A start appends `ConductorStarted`

Carrying who, why, the commit, whether the worktree was dirty, and `host:pid`
spelled the way `WorkItemClaimed.worker` spells it. Appended by the daemon
itself, after it has won the lock — so it records a start that *happened* rather
than one that was intended, and `lingtai daemon` typed by hand is in the log
beside `lingtai restart`.

It does **not** withdraw a standing shutdown request. Starting and being told to
stop stay independent facts, and a daemon started while a request stands reads
it and stops again, which is the behaviour 0030 gave it.

### 6. The lock decides "exactly one", not any sequencing here

`lingtai run` and `lingtai daemon` already stand down on one advisory lock
(`#93`) and so does a second `lingtai restart`. That is what makes *exactly one
daemon* true, rather than the order of operations in this command: if launchd's
`KeepAlive` won the race for the lock while the drain was finishing, the restart
says so and starts nothing. Exactly one is conducting, which is what was asked
for.

### 7. The restart withdraws its own request, and puts back a pause

The request stands in the stream for ever, so the daemon about to start would
read it and stop again. `ConductorResumed` is the only withdrawal — and it lifts
a *pause* too, which is somebody else's decision and nothing to do with this
restart. So the pause is re-appended with the words that were on it, and the
command says it did. A pause that has already expired is not revived.

A drain somebody else asked for is a **refusal**, and one `--anyway` does not
cover: restarting over it would be this command deciding for them.
`lingtai resume` lifts it.

## Consequences

- `ConductorStarted` joins the control events; `reduceControl` ignores it, and
  that is deliberate — it changes nothing about what the conductor has been told
  to do.
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

**Whether launchd should be told.** `scripts/launchd.sh` installs a `KeepAlive`
job, and `lingtai restart` neither loads nor unloads it; it drains, and lets
whoever wins the lock conduct. Making the restart a launchd operation would put
one installation's process manager in the CLI.
