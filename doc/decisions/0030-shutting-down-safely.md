# 0030 — Shutting down safely: the boundary is the pass, and the trigger is a command

**Status** accepted · 2026-09-08 · extends
[0027](0027-the-lease-is-deleted.md) §3 with what recovery does about a process

## Context

There are two ways to stop the daemon and neither is safe.

`lingtai.ts:319` is the whole of it:

```ts
const stop = () => {
  clearInterval(heartbeat);
  void beat("stopping").catch(() => {});
  void loop?.stop();
  started.daemon.stop();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
```

Four things, and it waits for none of them.

**Ctrl+C** delivers SIGINT to the whole foreground process group. The agent is
a child of the daemon — `spawn(binary, args, …)` at `claude-code.ts:226`, with
no `detached` — so it is in that group. **The signal that begins the shutdown
kills the agent at the same instant.** Waiting for the run to finish is
meaningless: it is already dead. No message about "finishing the current
ticket" can be true while this holds.

**`kill <pid>`** reaches only the daemon. `stop()` does not kill its children,
so the agent is reparented and keeps running — spending money, writing to a
worktree — while the code that would have appended its outcome has just exited.
What is left is `#87`: `RunPrompted` and then nothing, a claim `task_view` folds
as `running`, and `selectRunnable` offering nothing that is not `queued`.

Most of the machinery is already here. `work-loop.ts` tracks `running`, `again`
and `stopped`; `pump`'s loop already has `if (stopped) break`; `paused` is
already asked before every pass, with the comment that says why:

> Asked before every pass, not cached: a pause issued mid-run has to take effect
> at the next opportunity, and the next opportunity is here.

**What is missing is that nothing retains the in-flight pass, so nothing can
wait for it.** The `running` flag exists and no code awaits it.

This became urgent rather than tidy. The daemon has run since 17:22:53 while
thirteen commits landed on `main`, and nothing can put them into effect but a
restart — which there is no safe way to perform. `#88` is the proof: 74
`RunPrompted` events exist, **all of them v1**, and 52 were written after the
fix that adds the prompt landed. A change can be merged, marked landed, and
never once execute.

## Decision

### 1. The boundary is the pass, not the agent

A ticket is not finished when its agent exits. The gates run, the merge lane
runs, the `end` point runs — and one `pass` spans all of it.

> **Drain: the current pass completes, and no next one starts.**

`again` — the "go round again" set by events arriving mid-pass — lapses on its
own, because `if (stopped) break` is already at the top of the loop. The change
is that `pump` retains its promise and `stop()` awaits it.

### 2. The trigger is a command, not a signal

`lingtai shutdown [why]` appends `ConductorShutdownRequested` to
`ctl-conductor` and returns. The daemon reads it where it already reads
`paused`.

Same shape as `pause`, for the same reasons ADR 0013 gives: it takes effect at
the next opportunity without anybody restarting anything, and a daemon that is
down finds the command waiting rather than making it a race somebody has to
handle.

**A signal cannot carry this**, and that is not an implementation detail — see
§3. The command exists because the signal is unfixable.

### 3. The agent gets its own process group

`spawn(…, { detached: true })`.

Without it, Ctrl+C kills the agent at the instant shutdown begins, and every
message about finishing the current ticket is a lie the code tells. Detaching is
what makes §4 true rather than reassuring.

### 4. Ctrl+C says what is happening, and does not lie

The first one prints what is draining and what a second one would cost:

```
draining — finishing lingtai#94, then stopping.
press ctrl-c again to stop now, leaving its agent orphaned.
```

The second stops immediately. Both are honest because §3 made the first one
survivable.

### 5. An orphan is killed, not waited out — extending 0027

[0027](0027-the-lease-is-deleted.md) §3 established: *a conductor holding the
lock knows no other conductor exists, therefore every claim recorded by another
worker is dead.* Detaching adds the other half.

`WorkItemClaimed` records `worker` as host and pid, and `claim.ts:26` says why:
*"Who holds it — host and pid, so a stuck lease can be traced to a process."*
Nothing has ever traced it. Now it must: **a detached agent outlives the
conductor that started it**, so recovery kills the process before releasing the
claim.

Two guards, because killing by a recorded pid is how you kill the wrong thing:

- **The host must match.** A pid from another machine names a local stranger.
- **The process must be the runtime we started**, checked against its argv — not
  a bare pid match. Pids are reused, and the cost of getting this wrong is
  killing something that was never ours.

Failing either guard, the claim is released and the process is reported, not
killed. A released claim with a live stranger is a mess; a killed stranger is a
different and worse one.

### 6. No default timeout

Safety is the only reason this command exists. A default that gives up after
some minutes reintroduces exactly the failure it prevents, silently, at the
moment it matters most — and the person who wanted the guarantee would not know
they had lost it.

`--timeout` exists for somebody who has decided to accept that, and it says
what it does when it trips: stop taking work, leave the agent running, exit —
which is to say **deliberately create the orphan §5 now knows how to clean up.**

A drain can therefore take as long as `runtime.limits.wall`: `1h` in this
repository, `2h` by the schema's default. The command says so when it starts,
rather than looking hung.

## Consequences

- `lingtai shutdown` joins `pause`, `resume` and `now` as a control command, and
  `ControlState` gains what it folds.
- `work-loop` retains the in-flight promise; `stop()` awaits it. `running` stops
  being a flag nothing reads.
- `daemon_status.state` gains `draining`, so the board and `lingtai doctor` can
  say *stopping, finishing lingtai#94* rather than `up` — being current, being
  paused and being on the way out are three independent facts, and `#77` is the
  precedent for not folding two of them into one word.
- Restarting to pick up code that has landed stops being a hazard. That is what
  made this urgent, but it is not what this decides — see below.

## What this does not decide

**Whether the daemon should notice its own code is stale.** This makes a
restart safe; it does not make one happen, and nothing today compares the
running process against `main`. `daemon_status` records `pid, host, started_at,
last_seen_at, state, current_run_id` and no version, so `lingtai doctor`'s
liveness check reports `up, last beat 2s ago` — true, and no answer at all to
the question that mattered today.

That needs its own decision, and the reason to keep it separate is that the
answers differ: a safe shutdown is unambiguously right, whereas a daemon that
restarts itself when `main` moves is a choice with a real argument on both
sides.
