# 0100 — The event log and its store: one append-only log is the truth, held in SQLite or Postgres as the machine wrote down

**Status** accepted · 2026-10-01

Lingtai is one loop driven by one append-only event log. Every readable table is
a projection of that log, and everything that acts outside the system is a
subscriber to it. The log lives in one of two interchangeable stores — a SQLite
file under `~/.lingtai/` or a Postgres database — and which one is a value
written in `~/.lingtai/config.yml` by `lingtai init`, never inferred. Both stores
pass the same contract; switching between them starts an empty log.

## Context

A scheduler that keeps state in labels, history in comments and telemetry in a
side file cannot answer *what state is this ticket in* or *why did this not
merge*. Lingtai answers both by reading one stream. That only holds while
nothing else keeps authoritative state, while the log's rows stay readable by
the build that reads them, and while every process on a machine agrees which log
it is appending to. A process cannot establish that a variable is *unset* — the
same URL can be visible from a checkout and invisible to a daemon started from
`~` — so the choice of store has to be a recorded fact rather than a guess.

## Decision

1. **The log is the only source of truth.** State, history and telemetry are one
   stream in the `events` table. If a fact cannot be recovered by replaying the
   log, it is not a fact this system has. A correction is a new event; there is
   no legitimate UPDATE or DELETE.

2. **Everything is the loop, a projection, or a subscriber.** The loop appends
   events and takes one item at a time. A projection reads the log, writes a
   derived table and holds no truth. A subscriber reads the log and acts outside
   the system without blocking it. A component that fits none of the three is
   questioned before it is built. Lingtai's own `lingtai:*` status labels on
   GitHub are output written from the log, never read back as state.

3. **`UNIQUE (stream_id, version)` is the whole of the concurrency control.**
   `append(streamId, expectedVersion, events)` writes a batch in one transaction
   at `expectedVersion + 1 …`; a writer that lost the race gets
   `ConcurrencyError`, re-reads and retries. There is no lock table for the log.
   Streams are named by prefix: `wi-` (work item), `run-` (run), `prj-` (project), `int-`
   (integration), `chat-`, `ctl-` (control). The interface is `EventStore` in
   `packages/event-store/src/event-store.ts`.

4. **Every row carries `schemaVer`, and the catalogue governs reads and writes.**
   An event is past tense and self-contained. A type not in `@lingtai/domain`'s
   catalogue is refused on append and on read (`UnknownEventTypeError`); a
   payload change bumps `SCHEMA_VER` for that type and adds an upcaster. A type
   that leaves the vocabulary goes in `RETIRED`: readable for ever, refused on
   append. `lingtai doctor` fails when the log holds a type this build cannot
   read.

5. **A reset spends history, and only before 1.0.** Until 1.0 a change of
   vocabulary may empty the log instead of carrying an upcaster, provided every
   run in it is archived under `doc/experiments/` first. From 1.0 a stored
   payload is upcast, never reset away. Because a log may be reset, a `seq` is
   evidence on the spot and never a durable citation; a GitHub issue number is.

6. **There are two implementations of every store, held to one contract.**
   The log (`EventStore`, `LogQueries`, `Waker`), the projections
   (`ProjectionStore`, `packages/projector`) and the daemon's beacon
   (`packages/daemon/src/store.ts`) each have a Postgres and a SQLite
   implementation side by side. `packages/event-store/test/contract.ts`,
   `queries-contract.ts` and `wake-contract.ts` run against both, and a divergence
   is a failing test. A direct `pg.Client` outside a Postgres implementation is
   a defect: it is a place the machine's choice does not reach.

7. **The store is a written choice, read in one place.** `lingtai init` writes it
   to `~/.lingtai/config.yml` (mode `0600`):

   ```yaml
   database:
     store: postgres      # or: sqlite
     url: postgres://…    # only with store: postgres
   ```

   `storeChoice()` / `chosenStore()` in `packages/env/src/index.ts` is the only
   reader, and `packages/env/unit/one-choice.test.ts` fails on a second one. Five
   answers, three of them refusals by name: no `database.store` → refused, run
   `lingtai init`; `sqlite` → `~/.lingtai/lingtai.db`; `postgres` with a URL →
   Postgres; `postgres` with no URL → refused, naming where a URL is looked for;
   `sqlite` beside a `url` → refused, quoting both. **Nothing defaults.** An
   exported `LINGTAI_DATABASE_URL` selects Postgres and supplies the URL over the
   file, which is how CI, launchd and containers work with no file; there is no
   env file to decide it ([0117](0117-configuration-is-config-yml-and-the-environment.md)). `$LINGTAI_HOME` relocates `~/.lingtai`.

8. **Each store opens at first use, once per process.** `processLog()` in
   `packages/event-store/src/choose.ts` opens the chosen log lazily and memoises
   it; `projectionStore()` in `packages/projector/src/choose.ts` does the same
   for projections. The refusal arrives at the first append or read, never at
   import. The SQLite halves are loaded by dynamic import, so a Postgres
   machine never loads `node:sqlite`.

9. **Switching stores is a new, empty log.** There is no export, import,
   dual-write or migration between them. The contract has to agree from now on,
   not about every byte ever written.

10. **SQLite: one file, polled.** `node:sqlite` (Node 22.13 or later), in WAL
    mode, with a 5 s busy timeout for appends. The projections and `checkpoints`
    live in the same file as `events`, so projection lag is one read. A waker
    polls `max(seq)` every 100 ms (`POLL_MS`). Nothing in the file itself forbids
    UPDATE or DELETE; the store exposes neither.

11. **Postgres: its own database, two connection strings, enforced append-only.**
    Lingtai's log is never in a managed project's database.
    `LINGTAI_DATABASE_URL` serves reads and writes; `LINGTAI_DIRECT_DATABASE_URL`
    is a session-mode connection to the same database for `LISTEN`/`NOTIFY` and
    migrations, and may be identical on a plain Postgres. A transaction pooler
    silently drops `LISTEN` registrations, so `lingtai doctor` proves session mode
    with a second connection's `NOTIFY`. The trigger `lingtai_events_notify`
    sends only the `seq` on channel `lingtai`; rules `lingtai_events_no_update`
    and `lingtai_events_no_delete` make UPDATE and DELETE do nothing. Tables come
    from Prisma-planned migrations under `packages/event-store/migrations/app`,
    applied without the Prisma CLI by `createSchema` in `schema.ts`. The client
    is `@prisma/orm-postgres` at exact prerelease pins, with `pg` beside it for
    `LISTEN` and raw SQL.

12. **A store hands out its own waker.** `Log.waker()` is `LISTEN`/`NOTIFY` on
    Postgres and the poll on SQLite, so the pair cannot be mismatched. A nudge
    carries nothing and may be late, duplicated or spurious; a subscriber drains
    everything after its checkpoint, and the conductor's sweep runs regardless.

13. **Projections are folds, rebuilt by replay.** Each projection has its own
    tables and a `checkpoints` row: `task_view` (the board) and
    `finding_backlog` (minor findings). A projection reads only the log — every
    timestamp it stores comes from `event.at` — so dropping it and replaying
    yields the same table. A wrong or reshaped projection is fixed by
    `lingtai projection rebuild <name>`, never by hand. Every process that
    appends holds a projector while it runs.

## Consequences

- The board, the CLI and `doctor` cannot disagree: none of them holds state.
- Changing a projection's shape costs a rebuild, which is one round trip per
  event on Postgres; worth knowing before putting a rebuild under a deadline.
- A machine upgrading from no written choice is refused once and told to run
  `lingtai init`; that is louder than inferring an answer, on purpose.
- A machine that switches stores loses its board history.
- A deployment that can offer only a transaction pooler cannot run Lingtai on
  Postgres.
- On Postgres, `seq` is claimed at INSERT and visible at COMMIT, so concurrent
  writers can expose seq 6 before seq 5. The subscriber does not hold back for
  open transactions today; this is safe while appends are rare and short, and
  must not be "fixed" by assuming `seq` is gapless.
- SQLite needs nothing installed and is enough for one person on one machine;
  Postgres is the choice for a lot of data or a reason to want a server. No
  second machine can read a SQLite log.

---
*Replaces archived 0001, 0003, 0004, 0009, 0014, 0019, 0055, 0056 in [decisions-archive](../decisions-archive/).*
