# 0055 — Every store has two implementations, and init chooses one

**Status** accepted · 2026-09-20 · **supersedes [0003](0003-postgres-event-store.md)'s
premise that Postgres is the store**; completes
[0046](0046-lingtai-is-personal.md)'s consequence about SQLite with the shape it
did not state

SQLite runs the whole of Lingtai. Postgres is a second implementation, chosen
when there is a lot of data or a reason to want the server. **The choice is made
once, at `init`, and the system runs on one of them.** Switching is a new
database, not a migration.

## Context

[0046 §Consequences](0046-lingtai-is-personal.md) said this much:

> **SQLite becomes the obvious default.** Each log belongs to one person on one
> machine, so it never needs to be reached from another — which is the whole of
> the argument for a server. Postgres remains for whoever wants it, selected by
> the presence of `LINGTAI_DATABASE_URL` and nothing else.

That is the right conclusion and it names only the *log*. Lingtai keeps more
than a log:

```
events · checkpoints              the log and where each fold has read to
task_view · task_view_run         the board
finding_backlog · …_run           the minors gates raised (#137)
daemon_status                     the beacon — is it up, on which commit
```

[#178](https://github.com/steven-zhc/lingtai/issues/178) built a SQLite
`EventStore` and it passes `packages/event-store/test/contract.ts` **unchanged**.
The other three groups have no interface at all: **twenty-four places construct
a `pg.Client` or `pg.Pool` directly**, including both projections, the beacon,
the work loop, `reconcile` and `converge`.

So a machine with no Postgres has a working log and no board, no beacon and no
conductor — and [#179](https://github.com/steven-zhc/lingtai/issues/179), the
one-line ticket that chooses the store, has failed **eight passes and about
$200** discovering that one place at a time. Each round its reviewer named a
different direct connection; each round an agent fixed that one. **Nothing
enumerated the set**, because the set is defined by the absence of an
abstraction rather than by a list.

## Decision

### 1. A store is an interface with two implementations, and a contract decides

`EventStore` is the model and it already works:

```
packages/event-store/src/event-store.ts     one interface
                          ├── postgres
                          └── sqlite
packages/event-store/test/contract.ts       198 lines, both implementations pass
```

The remaining groups get the same treatment — projections, the beacon,
checkpoints. **One interface each, two implementations each, one contract each
that both pass.**

This is not a port. Nothing is rewritten from one database to the other: a
second implementation is written beside the first, and a test that neither
implementation owns decides whether they agree.

**A direct `pg.Client` outside a Postgres implementation is the defect this ADR
names.** Twenty-four of them exist today, and each is a place where the choice
in §2 does not reach.

### 2. `init` chooses, and the whole system runs on that choice

Not per-table, not per-command, not per-call. One selection, made when a machine
is set up, and every store resolves through it.

`LINGTAI_DATABASE_URL` remains the way Postgres is named
([0046](0046-lingtai-is-personal.md)), and its absence means SQLite — **for the
system, not only for the log.** A machine that names no Postgres runs the board,
the beacon and the conductor on files under `~/.lingtai/`.

**`LINGTAI_TEST_DATABASE_URL` is untouched and remains the exception.** 0046's
sentence stands word for word: a fallback there would let a suite that exists to
assert Postgres pass against SQLite.

### 3. Switching is a new database, and history does not follow

Choosing the other implementation starts an empty store. No export, no import,
no dual-write, no compatibility window.

**This is what makes §1 affordable.** A migration would demand that both
implementations agree about every byte ever written; a fresh start demands only
that they agree about the contract from now on. The cost is real and is
accepted: a machine that switches loses its board history, and the log it
leaves behind is still a file or a database somebody can read.

The case this was decided for is Lingtai's own repository: it runs on Postgres
today, and if it moves to SQLite it starts over.

### 4. Performance is the reason to choose Postgres, and it is a real one

SQLite is the default because it needs no installation, not because it is
better. A lot of data, or a wish for a server's characteristics, is a good
reason to run Postgres — and under §3 that choice is made at the start rather
than arrived at by growth.

Nothing here claims SQLite scales. It claims it is enough for one person on one
machine, which is what [0046](0046-lingtai-is-personal.md) established Lingtai
is.

## What this does not decide

- **Whether the two implementations may diverge in behaviour.** The contract is
  the answer for what it covers; what it does not cover is undecided, and each
  interface's ticket has to say what its contract asserts.
- **Reaching one machine's store from another.** 0046 removed the need; nothing
  here adds it back.
- **What `doctor` says on each.** [#214](https://github.com/steven-zhc/lingtai/issues/214).

## Consequences

**Three interfaces do not exist yet and are now the work.** Projections, the
beacon, checkpoints — each a ticket, each with a contract both implementations
pass, each countable in a way the last eight passes were not.

**[#179](https://github.com/steven-zhc/lingtai/issues/179) is the last line, not
the work.** It chooses; it cannot choose usefully until there is something to
choose between. It is blocked on the three rather than cut smaller a fourth
time.

**[0003](0003-postgres-event-store.md)'s premise goes.** Its title is *PostgreSQL
as the event store* and its reasoning — `UNIQUE (stream_id, version)`, one
transaction per append — is about properties a store must have, not about
Postgres. Those properties are what `contract.ts` asserts, which is why the
SQLite store passed it unchanged.

**A `pg` import outside a Postgres implementation becomes a thing to notice.**
Whether that is a lint rule, a test, or a `doctor` check is not decided here;
that it should be visible is.
