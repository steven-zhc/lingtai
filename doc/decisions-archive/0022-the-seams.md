# 0022 — Where the seams go: eleven packages, and four deletions

**Status** accepted · 2026-09-04 · refines [0016](0016-the-settled-model.md),
supersedes nothing

## Context

Ten packages today. Three concepts have their *engine*, their *definitions* and
their *assembly* in three different places, and in every case one of the three is
an application:

| concept | engine | definitions | assembly |
|---|---|---|---|
| the projection | `store/projection.ts` | `conductor/task-view.ts` | **`apps/cli/projections.ts`** |
| outbox delivery | `conductor/outbox.ts` | `daemon/deliver.ts` | **`apps/cli/conduct.ts`** |
| the daemon | `packages/daemon` | — | **`apps/cli/lingtai.ts`** |

That is not an aesthetic complaint. It has cost:

- **The board runs git.** `apps/board/src/app/actions.ts` imports `git` and
  `stateDir` from `@lingtai/conductor/worktree`, because that is the only place a
  git helper lives.
- **Which projections exist is decided in the CLI.** The daemon is handed them.
  A projection written and never added to `PROJECTIONS` has no table, no
  checkpoint and no failing check — it is indistinguishable from one that does
  not exist.
- **`LINGTAI_LABEL_PREFIX` is a domain rule in an application.** So is the
  read-modify-write that keeps foreign labels alive, which exists because the
  first outbox drain stripped `enhancement` off three admin issues and made them
  unrunnable.

## The decision

**One boundary: decisions above it, everything that touches the world below.**
`conductor` declares the interfaces it needs; the adapter packages implement
them; a host wires the two together. Nothing in the pure column names a package
in the other one.

**Pure** — no Postgres, no git, no network:
`conductor` (claim · actions · integrate),
`domain` (the event catalogue, reducers, upcast, the five point names),
`recipe` (load · validate · resolve),
`actions` (the four action kinds, running them, proving they ran).

**Touches the world:**
`event-store` (append · read · subscribe from any seq — and **no `checkpoints`
table**), `projector` (the `checkpoints` table and the fold into `task_view`),
`github`, `repo` (mirror · worktree · branch · push · the merge lane),
`agent` (start claude-code; catch what it reports on the hook socket), `env`.

**Hosts:** `daemon`, `cli`, `board`.

Renames: `core` → `domain`, `config` → `recipe`, `gates` → `actions`
(`end` gates nothing). `@lingtai/runtime` folds into `agent`.
`@lingtai/hook` is unchanged — a compiled binary planted in the worktree, not a
library, with `agent` as the end that talks to it.

**`checkpoints` belongs to `projector`, not to `event-store`.** The checkpoint
advances *inside the same transaction* as the fold's writes; splitting them
across a package boundary would mean handing a transaction through it. An event
store offers resumption — `subscribe` from any seq — and does not remember its
readers.

## What is deleted

1. **`outbox`** — the table, the projection, the delivery worker, the backoff,
   the dead-letter, spread over three packages. All of it for three calls:
   comment, set labels, close. `conductor` calls `github` and appends the
   outcome; what did not land, `reconcile` converges.
2. **The queue cache** — `syncQueued`, the `queued` rows, `refreshQueue`. The
   conductor already asks GitHub at the top of every pass and reads it straight
   back; the cache is a holding place inside one pass. Because it is *stored*,
   two entry points came to disagree about refreshing it first (#57), and a
   queue change reaches no one (#56). Both go with the cache.
3. **The projection list** — one projection is left; a list of one is not a list.
4. **The catch-up-on-exit special case** — `advanceBoard`,
   `catchUpProjections`. Every host that appends holds a `projector` while it
   runs. Two projectors on one log is then the normal case and is safe by
   construction: `apply` is idempotent and the checkpoint advances in the same
   transaction as its writes. This closes #64 by deleting the second mechanism
   rather than by adding one.

## Two things the outbox deletion must land

**`labelsFor` moves to `conductor`.** Twenty lines turning a work item's state
into the labels its issue should carry. It is the whole definition of what
GitHub ought to look like — exactly what `reconcile` converges against — and it
is pure. The impure half stays in `github`: the union with whatever labels
somebody else put on the issue needs GitHub's current state.

**Two events replace `OutboxDelivered` and `OutboxFailed`:**

```
IssueUpdated      { project, issue, change: "comment" | "labels" | "closed", detail }
IssueUpdateFailed { project, issue, change, error }
```

The noun is the issue, not the queue: the queue is about to stop existing and an
event name must not carry an implementation detail. **The failure event survives
the deletion of every retry** — the old loop called `gh` inline and a failed call
left nothing, so afterwards nobody could tell *we never commented* from *we
commented and it did not help*. Keep the record; drop the machine.

## The retired types stay readable

`OutboxDelivered` and `OutboxFailed` are **retired, not removed**: they stay in
the catalogue, nothing appends them, and `toEnvelope` keeps reading them.

This is not a preference. [0019](0019-a-second-reset.md) is the record of
deleting three event types the log still held: every run stream became
unreadable from its first row, `projection rebuild` could not run at all, and the
way out was a second reset. That file names the alternative — *retire the types
instead, readable for ever, refuse to append* — and calls it the right answer
**for a system with history worth keeping**. It also records the precondition
that would make another reset legitimate:

> A reset is legitimate only while the log contains no run that anybody outside
> this repository depends on.

The log now contains the run that merged `nextloom-ai-admin` #154 into its
`develop`. **That precondition is false, and 0019 says it stays false.** So the
retirement path is the only one left, which is what 0019 was written to
guarantee.

## Not decided

**Splitting `env`.** It holds two things with opposite rules — the machine's own
credentials, which the agent must never see, and the agent's
`allow`/`deny`/`required`. The boundary is wrong and this file says so; the split
and its name are deferred rather than chosen.

## Consequences

`task_view` becomes a fold and nothing else, so `projection rebuild` means
rebuild. Eight stores become seven and every derived one is fully rebuildable.
`admit` is still a point nothing runs — the same shape as #58, undetonated only
because no recipe has declared an action there; `gate-audit` is already aimed
at it.

**One test decides whether this happened:** can `conductor` run a whole pass
against a fake `repo`, a fake `agent` and a fake `event-store`, with no
database, producing the events it wants appended and the calls it wants made?
Today it cannot — the suite refuses to start without `TEST_DATABASE_URL` because
every test appends real events, and there are 23 appends across six files in
that one package. If the answer is still no when the move is finished, the move
did not happen, whatever the directory listing says.

Drawn, with the diagnosis and the before/after, in
[architecture.html](../architecture.html) (中文：[architecture.zh.html](../architecture.zh.html)).
