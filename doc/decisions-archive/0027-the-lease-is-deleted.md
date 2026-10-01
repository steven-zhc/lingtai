# 0027 — The lease is deleted: the constraint excludes, the lock proves liveness

**Status** accepted · 2026-09-08 · supersedes the claim-recovery paragraph of
[0013](0013-daemon-hosts-the-work.md); revises the `.runtime/loop.lock.d` row of
[0003](0003-postgres-event-store.md)

## Context

A **lease** is a field in `WorkItemClaimed`: `leaseUntilMs`, a timestamp thirty
minutes after the claim. It is written in exactly one place —

```ts
const leaseUntilMs = now() + (options.leaseMs ?? DEFAULT_LEASE_MS);  // claim.ts:80
```

— and never again. Nothing renews it. `ClaimOptions.leaseMs` is declared, read
once at that line, and passed by nobody, so the lease is always thirty minutes.

**It was never decided.** It entered in [0003](0003-postgres-event-store.md),
whose subject is *PostgreSQL as the event store*, inside a three-row table
arguing against the old loop's lock directory:

> | `.runtime/loop.lock.d` | leaks after `kill -9`; needs a manual `rm -rf` | `UNIQUE (stream_id, version)` optimistic concurrency plus lease events. A dead process's lease expires on its own — the absence of a heartbeat *is* the expiry, so there is nothing to unwind. |

That is the whole of its justification, and it is ammunition in an argument
about storage rather than a decision about scheduling. The consequences are
visible now: `reference.md`, which opens *"every term, and everything currently
in it"*, has no entry for it; the number thirty appears in no document; and the
one property every document does assert about it — *the absence of a heartbeat
is the expiry* — describes a mechanism that was never built. **There is no
heartbeat.** It is a fixed timeout.

## The lease is not the mutual exclusion

`claim.ts` says so itself, at the point where a race is lost:

```ts
// The other claimant appended first. The constraint is the whole of the
// mutual exclusion; this is what losing it looks like.
if (err instanceof ConcurrencyError) return { ok: false, refusal: { reason: "lost-race" } };
```

`claimWorkItem` has four steps, and only two of them decide anything:

1. `read(workItemId)` → fold → `state`, carrying `state.version`.
2. If `status === "claimed"` **and** `leaseUntilMs > now()`, refuse `"held"`.
3. `append(workItemId, state.version, [WorkItemClaimed])` — at the expected version.
4. `UNIQUE (stream_id, version)` rejects the loser → `ConcurrencyError` → `"lost-race"`.

Step 2 writes nothing and excludes nobody: two conductors pass it together.
**Steps 3 and 4 are the guarantee**, and they are a database constraint, not a
timestamp. The constraint prevents two claims *at the same instant*.

What the lease supplies is the opposite service. The constraint stops a ticket
being over-shared; the lease stops it being under-shared — held by a process
that will never hand it back. It is not exclusion. **It is the expiry of
exclusion.**

## In the shape we actually run, that expiry arrives too early

| | |
|---|---|
| lease | **30 minutes**, fixed, never renewed (`claim.ts:22`) |
| this repository's `runtime.limits.wall` | **1h** |
| the recipe schema's default `wall` | **2h** (`recipe.ts:279`) |

A run is permitted to live two to four times as long as its claim is valid for.
Every run past the half hour is, by the log's own account, alive and holding an
expired lease. What follows is not a race, so the constraint does not catch it:

```
T+0    A reads version 5, appends WorkItemClaimed, stream at version 6,
       lease until T+30. A starts an agent the recipe allows to run an hour.
T+31   B reads version 6, sees status "claimed",
       tests leaseUntilMs > now() → false, falls through step 2,
       appends at expected version 6 → nobody contended for it → succeeds.
```

Two agents, one ticket, two invoices — and nothing tells A its claim is gone,
so it finishes and merges anyway. **For any long run the lease does not
reinforce exclusion; it schedules its removal.**

Nothing has hit this because there has only ever been one conductor, and one
conductor cannot race itself. Exclusion today is supplied by the daemon's
advisory lock. The lease has never been tested.

## The evidence: `#87`

`wi-lingtai-87` was claimed three times.

| seq | claim | lease until | outcome |
|---|---|---|---|
| 713 | `local:32006` / run-312ee659 | 19:39:17Z | 743 released — *"the lease expired and the run never came back"* |
| 890 | `local:71410` / run-1978cb64 | 21:52:39Z | ran, blocked, then 953 `RepairRequested reason=conflict`, 954 released for repair |
| 993 | `local:23673` / run-723e0cc2 | **22:39:51Z** | run stream ends at `RunPrompted`. No `RunFinished`, no `RunFailed`, no `RunTouchedFile` |

The third run's conductor was restarted; the agent, a child in its process
group, died with it. Then:

```
22:23:35Z   the daemon restarts — reconcile runs, its only run
22:23:35Z   #87: lease is until 22:39:51Z, still in the future → skipped
22:39:51Z   the lease expires
            (nothing runs reconcile again)
```

**The restart is simultaneously the act that orphans the claim and the only
check for orphaned claims**, and the interval between them is the lease. So the
miss is not bad luck, it is structural: a startup reconcile can never see an
orphan that its own restart just created. It catches only orphans left by an
earlier crash that nobody attended to for thirty minutes — which is what seq
743 was.

Restarting is the first thing a person does when a daemon misbehaves, so the
hole is precisely aligned with the reflex that triggers it.

The item was recovered by calling `reconcile()` out of band. `task_view` folded
it as `running`, and `selectRunnable` offers nothing that is not `queued`, so it
was out of circulation permanently — exactly as `reconcile.ts:230` warns, and
exactly as [0013](0013-daemon-hosts-the-work.md) denies:

> A killed daemon leaves a claim, and the claim's lease expires without anyone
> releasing it (`claim.ts`), so **the work item returns on its own**.

It does not. The expiry makes it *claimable*; nothing makes it *offered*. That
sentence is superseded here.

## Decision

**Delete the lease.** Exclusion and liveness are separate concerns and the
system already has a better mechanism for each.

1. **Exclusion is `UNIQUE (stream_id, version)`** — already true, now the whole
   of it. `claim.ts` drops the `leaseUntilMs > now()` branch: a claim held is a
   claim held, with no expiry to fall through.

2. **Liveness is the daemon's advisory lock.** `lock.ts` already holds
   `pg_try_advisory_lock('lingtai:daemon')` at **session** level, and its own
   docstring states the property that matters:

   > held by the *connection*: a killed daemon releases it when its socket
   > closes, with nothing to clean up and no stale file to explain.

   That is the heartbeat 0003 described and did not build, maintained by the
   kernel rather than by a timer. It expires when the process dies — not thirty
   minutes later, and never while the process is alive.

3. **Recovery is a proof, not a timer.** A daemon that has just acquired the
   lock knows no other conductor exists. Therefore every claim recorded by
   another worker is dead, whatever any timestamp says. `findExpiredClaims`
   becomes `releaseForeignClaims`, releasing them all at startup and citing the
   lock as its reason.

4. **`lingtai run` takes the same lock.** This is a prerequisite, not a
   follow-up: see below.

`WorkItemClaimed` keeps `worker` — host and pid remain worth recording as *who
ran this* — and keeps accepting `leaseUntilMs` on read, because the log is
append-only and history holds thousands of them. `upcast.ts` ignores the field;
no event is rewritten.

## Why "only at startup" is not a limitation

A claim can be orphaned only by a conductor dying. Work resumes only when a
conductor starts. **The moment that repairs the orphan and the moment that
would have used the repair are the same moment** — while no daemon is running,
nothing was going to take the ticket anyway.

So a ticket can never be stuck longer than "until you start a conductor again",
and the periodic sweep tracked as `#91` is not needed. The defect `#91`
describes is not that reconcile runs once; it is that when it runs it consults
a timestamp instead of the lock it is holding.

## The prerequisite, stated as a hazard

`run.ts`, `conduct.ts` and `schedule.ts` take no advisory lock — it belongs to
`packages/daemon` alone. A hand-run `lingtai run` is therefore a second
conductor today, and `lock.ts` names that exact failure:

> Two conductors racing for the same ticket is the failure that makes the whole
> claim mechanism pointless — and it would present as an expensive mystery
> rather than an error.

Deleting the lease before closing that gap makes it worse than it is now. A
`lingtai run` in flight holds a claim that no lock records; a daemon starting
beside it would acquire the lock, conclude correctly-from-false-premises that it
is alone, and release a live claim. The lease currently blocks this for thirty
minutes.

**So the order is fixed: `lingtai run` acquires `lingtai:daemon` first, and the
lease is deleted second.** After that, *I hold the lock, therefore no other
conductor exists, therefore every foreign claim is dead* has no gap in it.

## What this gives up

The lease is the only mechanism that would let **two conductors coexist**.
Deleting it commits the system to exactly one.

That costs nothing today. Concurrency is obtained *inside* one conductor — a
single daemon runs work for several projects at once — and the lock lives in
Postgres, so the commitment holds across machines rather than only on one.

The day two conductors are genuinely wanted, *I hold the lock so everyone else
is dead* stops being true, and what is needed then is **connection-level
liveness per run** — a session advisory lock taken for the duration of each run,
released by the socket closing exactly as the daemon's is. It is not a
thirty-minute constant, and this paragraph exists so that nobody reintroduces
one by reasoning from the symptom.

## Consequences

- `DEFAULT_LEASE_MS`, `leaseUntilMs` and `ClaimOptions.leaseMs` leave the code.
  `leaseMs` was a dead parameter: declared, read at `claim.ts:80`, passed by
  nobody.
- `claim.ts`'s `ClaimRefusal` loses `expiresInMs`. "Held" no longer comes with a
  countdown, because there is nothing to count down to.
- `#91` closes. The problem it describes does not exist in this model.
- The recovery is still an **append** — `WorkItemReleased`, with the lock as its
  stated reason — and never a recomputation. A projection is a fold and cannot
  read a clock; if `running` versus `queued` depended on the current time, the
  same log would produce different tables at different moments and
  `lingtai projection rebuild task_view` would disagree with the incremental
  fold. That constraint is what forced the lease's expiry to be inert in the
  first place, and it is unchanged: expiry was implicit, the return to the queue
  must stay explicit.
- `reference.md` gains **claim** as a term — what it is, what excludes, what
  recovers it — which is what the lease never got.
- [0003](0003-postgres-event-store.md)'s row keeps its verdict on
  `.runtime/loop.lock.d` and loses its mechanism: what replaces the lock
  directory is the constraint plus a session lock, not "lease events".
