# 0124 — A stream's fold is cached as a snapshot: written by a long-lived process at a commit point, read as snapshot plus tail, void when its fold or its log changes

**Status** accepted · 2026-10-31

The state of a stream — the conductor's control state, a ticket, a run, a
project, an integration — is a fold over that stream's events, and the fold
exists once, in `@lingtai/domain` ([0101](0101-typescript-packages-effect-unbuilt.md) §4).
A **snapshot** is that fold's result saved at a version of the stream. The
current state is the latest snapshot folded forward with the events after it.
Snapshots are written asynchronously by the long-lived processes — the daemon
and the board — when a stream reaches a **commit point** (today, every fifth
event). A snapshot is never the truth: it is a cache of the log, any one of them
may be missing or void, and the cost of that is reading more events, never a
different answer.

## Context

0100 §1 makes the log the only source of truth, and §2 makes everything else a
loop, a projection, a subscriber or — since this ADR — a snapshot. Projections
answer questions across streams (`task_view`, `spend`) and are folded by a
projector that must be running. The state of **one** stream is folded on demand
by whoever reads it, with `reduceControl` (`packages/domain/src/control.ts:136`),
`reduceTicket` (`ticket.ts:465`), `reduceRun` (`run.ts:417`), `reduceProject`
(`project.ts:109`) and `reduceIntegration` (`integration.ts:124`), each taking
the stream's whole history — and, on the board, by folds of its own
(`foldRun`, `foldChat`, `foldProgress`) that duplicate them.

That stopped being cheap. On 2026-10-31 the control stream `ctl-conductor` held
297 events and 1.1 MB, 1063 KB of it 48 `Reconciled` events that
`reduceControl` does not read; the board read all of it on every render, 135 ms
warm, 538 ms cold and up to 3.3 s on a busy machine.

## Decision

1. **A fold is declared once, in step form, with a version and a codec.** A fold
   that may be snapshotted is `{ name, version, initial, apply(state, envelope),
   encode, decode }` in `@lingtai/domain`, and the whole-history reducer is
   `events.reduce(apply, initial)` — one definition, so the snapshot path, the
   full path, the board and the projector cannot drift. `encode`/`decode` carry
   what JSON does not: `bigint` (`lastSeq`, a refusal's `seq`), `Date`, and the
   difference between an absent key and `null`. A unit test per fold asserts
   `decode(encode(s))` is strictly equal to `s` over its fixture history.
   **The registry, the codec and the version table land with the snapshot
   store, after the folds have their final shape.** A version exists to
   invalidate a stored snapshot, and until one is stored there is nothing for
   it to invalidate: a fold reaches its final shape directly
   ([design/one-fold-per-stream.md](../design/one-fold-per-stream.md) §5), and
   is registered at version 1 with that shape.

2. **What depends on the clock is not folded.** A fold's state is a function of
   the events alone. Whatever depends on *now* — the control state's pause that
   lifts by itself at `until` (0031 §5) — is stored as the instant and evaluated
   by the reader against its own clock after the fold. `reduceControl(events,
   now)` splits into the fold and that evaluation, which keeps `now` as a
   parameter for its callers (`packages/conductor/src/day-ceiling.ts`).

3. **A fold's version is raised by hand, and an append-only table holds it.**
   `version` is an integer the fold's author raises whenever the fold's result
   for some history would change. Each fold keeps a fixture history that contains
   every event type its `apply` handles, and a committed table of
   `version → hash of the encoded result`, to which rows are only ever added. A
   result whose hash differs from the row for the current version fails the
   test, naming the fold: changing the expected value without raising the version
   is the one edit the test refuses. A snapshot whose `(name, version)` is not
   the fold's current one is never read.
   **A field of the state is not a field of an event.** A new optional field on
   an *event* (§4) is absent on the events written before it, and stays absent —
   the event is the fact. A new field of a fold's *state* derived from events
   already in the log (the last time the conductor was paused, from every
   `ConductorPaused`) is a change to what the fold computes, and raises its
   version, so that the state is always what the current fold makes of the whole
   stream and never depends on when a cache happened to be written.

4. **Events do not change; a different event is a new type.** An event's payload
   may only gain optional fields, which every reader treats as `null` when absent;
   that needs no `SCHEMA_VER` and no upcaster. A rename, a removal or a change of
   meaning is a new event type, and the old one goes to `RETIRED`
   ([0100](0100-one-append-only-log.md) §4). The upcasters that exist are frozen
   and no new one is added, so what a stored event folds to can only change when
   a fold's version does.

5. **A snapshot is written behind, by a long-lived process, at a commit point.**
   The daemon and the board — and nothing that exits when its command does —
   write snapshots. When one of them appends to a stream, or reads a stream whose
   tail since the latest snapshot has reached a commit point, it starts the fold
   and the snapshot write **without awaiting it**, on a promise that catches its
   own error and logs it once to stderr. A failed write changes nothing but how
   many events the next reader folds. The commit point is a policy per fold —
   **every 5 events** today, crossed when `floor(old version / 5) ≠ floor(new
   version / 5)`, so a batch append that jumps past a multiple still counts; a
   time interval or both are the same seam. The CLI's short commands read
   snapshots and never write them.

6. **A read is the snapshot plus the tail, and the result is the same either
   way.** A reader takes the latest usable snapshot for `(stream, fold name, fold
   version)`, reads the stream from that snapshot's version
   (`read(streamId, fromVersion)`, `packages/event-store/src/event-store.ts:349`),
   and folds what follows on top. With no usable snapshot it folds from version 1,
   which is the read every caller makes today.

7. **The write cannot go backwards.** A snapshot row is keyed by
   `(stream, fold name, fold version)` and replaced only by one at a higher stream
   version, in one conditional statement. Two passes (0122), the daemon and the
   board writing at once leave the newest; a slow writer that finishes late
   changes nothing.

8. **A snapshot belongs to one log, named by its epoch.** When a log is created it
   writes a random **epoch id**, once, beside `events`; every snapshot stores the
   epoch it was folded from, and a snapshot from another epoch is void. A reset
   ([0100](0100-one-append-only-log.md) §5) is a new epoch, and its procedure in
   `doc/operating.md` also empties the snapshot table — the epoch is what keeps a
   forgotten step from returning a pre-reset state (a pause, a standing shutdown),
   not the step itself.

9. **Snapshots live beside the log, in every store, and are disposable.** One
   table in the same database as `events`, in the Postgres store (a Prisma-planned
   migration), the SQLite store and the in-memory store, all held to the event
   store's contract suite (0100 §6). The fold registry lives in `@lingtai/domain`
   and the storage in `@lingtai/event-store`, which already depends on it.
   Deleting every row is always safe. `lingtai doctor` reports how many
   snapshots are void against their fold's version or the log's epoch; nothing
   repairs a snapshot by hand.

10. **Who reads through a snapshot, in order.** First the board and the CLI's
    read-only commands, for the control stream. The daemon's own reads are a
    separate step, because they are not a fold from version 1: `readControl(store,
    since)` folds only what follows its watermark (`packages/daemon/src/control.ts:116-122`),
    and every control appender reads the whole stream for its expected version
    (`daemon/control.ts:131`, `:136`, `:215`, `:343`; `conductor/src/conduct.ts:967`;
    `discuss.ts:446`). Those move to a version-only head read and a watermark
    held in the state, in their own ticket. Then tickets and runs. A stream with no
    registered fold is appended and read exactly as today.

## Consequences

- Reading a stream's state costs one snapshot row and at most a commit interval
  of events for every reader that reads through it — the board first, the daemon
  once its reads move (§10).
- A fold is one definition with `apply`, a codec and, where time matters, an
  evaluation; changing its behaviour means raising its version, and the hash table
  makes forgetting that a failing test.
- Event payloads stop being versioned. A field that would once have been an
  upcaster is optional from the start, or it is a new event.
- On SQLite the write is not free: the store is synchronous (`node:sqlite`'s
  `DatabaseSync`, `packages/event-store/src/sqlite.ts:123-124`), so a snapshot
  upsert runs on the writer's thread and takes the write lock. Keeping writers to
  the long-lived processes and the interval at five keeps that rare.
- The control state's lists (`requested`, `continuing`, `discussions`,
  `control.ts:84-98`) only grow, so its snapshot does too; pruning them is a fold
  change with a version bump, decided on its own.
- Projections are unchanged in role: they answer questions across streams; where
  a projection folds one stream's part of a row, it calls the same domain `apply`
  ([0101](0101-typescript-packages-effect-unbuilt.md) §4).

---
*New topic; amends [0100](0100-one-append-only-log.md) §2 and §4.*
