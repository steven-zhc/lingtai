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

2. **Everything is the loop, a projection, a subscriber, or a snapshot.** The loop appends
   events and takes one item at a time. A projection reads the log, writes a
   derived table and holds no truth. A subscriber reads the log and acts outside
   the system without blocking it. A snapshot is one stream's reducer saved at a
   version, a cache that any reader may ignore or discard
   ([0124](0124-a-stream-fold-is-cached-as-a-snapshot.md)). A component that fits none of the four is
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
   catalogue is refused on append and on read (`UnknownEventTypeError`).
   **An event's payload only ever gains optional fields**, which a reader takes
   as `null` when absent, with no `SCHEMA_VER` bump and no upcaster; a rename, a
   removal or a change of meaning is a new event type. The upcasters in
   `packages/domain/src/upcast.ts` are frozen for the events already written under
   them, and none is added
   ([0124](0124-a-stream-fold-is-cached-as-a-snapshot.md) §4). A type
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

10. **SQLite: one file, polled.** `node:sqlite` (on the Node 0101 names), in WAL
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

13. **Projections are reduces, rebuilt by replay.** Each projection has its own
    tables and a `checkpoints` row: `task_view` (the board) and
    `finding_backlog` (minor findings). A projection reads only the log — every
    timestamp it stores comes from `event.at` — so dropping it and replaying
    yields the same table. A wrong or reshaped projection is fixed by
    `lingtai projection rebuild <name>`, never by hand. **Each projection has one
    writer**: the process holding the conductor lock reduces it from the log, in
    `seq` order, with the checkpoint in the same transaction. Every other process
    appends and reads; one that must show its own write waits for the checkpoint
    to reach that event. With no conductor up the projections stand still, and the
    lag says so.

14. **An event records a result, never the process that reached it.** An
    agent's output cannot be produced twice, so a transcript is nothing a second
    reader could check; what is appended is what a step was given and what it
    produced. A run's inputs are on `RunStarted` (`model`, `promptVersion`,
    `configHash`, `baseSha`, `invocation`) and its product on `RunProducedDiff`
    (`headSha`). Each action's result is on `StepEnded`, with the `onSha` it
    judged and its `evidence` (a command's is its tail, which says when it was
    clipped). A person's decision is on `WaitResolved`, with `by`. Every paid
    call is a `RunSpent` ([0110](0110-tokens-on-the-event-money-at-display.md)),
    and a landing is a `TicketLanded`. So a mechanical result can be checked
    again by running it at its `onSha`, and an agent's judgement is answerable
    (who said it, about which commit) without being repeatable. The run log is
    a trace and not a record ([0111](0111-the-board-is-a-local-app.md)): a fact
    a later reader must be able to check is a field on an event, never a line in
    a log.

    **What an agent was given is on `RunPrompted`, and each input is on the log
    once.** Every paid call appends one `RunPrompted` before it is dispatched,
    beside its `RunSpent` and with the same `for`; the conductor is its one
    writer, for the implementer as for every other call. Its text is the prompt
    as handed except where a part is already on the log or in git: there it
    carries a reference in place of the copy. The ticket body is the claim's
    (0109 §1); findings and a command's evidence are the `StepEnded` that
    carried them; triage's advice is the `WaitTriaged`; a person's answers are
    the `WaitResolved`; a diff is its two shas and its size. Everything else
    (the template's own words, the round, the rules) is written out, so
    expanding a `RunPrompted` back into the text is substitution by one pure
    function: a value inserted verbatim (the body, a command's evidence, a
    diff) comes back exactly; a part the template rendered from stored data (a
    list of findings) is rendered again by today's code and may differ in
    layout, never in content. A prompt costs a few kilobytes, not the size of
    its diff, and a reference that no longer resolves (a diff whose branch was
    deleted) says so rather than inventing the text.

    **`RunPrompted` is what Lingtai composed, not the agent's whole context.**
    The runtime adds its own system prompt and tool definitions, which Lingtai
    cannot read, and the machine adds its own configuration (the user's
    `~/.claude` instructions, settings, plugins and servers). Of these, only the
    runtime's version is recorded, on `RunStarted`, as the runtime reported it,
    so a change of behaviour across an upgrade can be told from one within a
    version. The repository's own instructions need no record: they are in git
    at `baseSha`.

## Consequences

- *Agents do the work. Lingtai keeps the books.* is a claim §1 and §14 make
  true: every result is on the log with what it was given and the evidence for
  it, and it holds only while a new event keeps that shape.
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
