# 0074 — The test side defaults to a file of its own; the reason a fallback was refused stays the reason

**Status** accepted · **Date** 2026-09-29 · **Supersedes** the mechanism, not the
argument, of [0046](0046-lingtai-is-personal.md) §3, [0055](0055-two-implementations-chosen-at-init.md)
§2 and [0056](0056-the-store-is-a-written-choice.md) §4 · **Spends** the SQLite
side [0055](0055-two-implementations-chosen-at-init.md) already built (#178)

## 1. Three ADRs say the same sentence, and this is the fallback they refused

- **0046**: *"That rule must not reach the test variables … a fallback there
  would let a suite that exists to assert Postgres pass against SQLite."*
- **0055 §2**: *"`LINGTAI_TEST_DATABASE_URL` is untouched and remains the
  exception."*
- **0056 §4**: the same sentence, word for word.

Each was written against a real failure: a suite that writes real events must
never be answered by the operator's own log, so `testUrl` throws rather than
falling back, by name, when `LINGTAI_TEST_DATABASE_URL` is unset. A SQLite
default for that name is exactly the fallback those three refuse.

**The reason still holds. What changes is what the refusal is a refusal
*about*.** In 2026, "the suite" meant every integration file, because every one
of them opened a `pg.Client` somewhere — `createDb()` at the top, or a raw
`delete from events` in its own `afterAll`. Refusing the whole run for one
missing name was the only lever available, so the three ADRs above pulled it.

**#178 built a second implementation the same month**, and nothing since has
asked which files actually need the one the refusal was guarding. Most of
them do not: `createDb()` plus a cleanup block, and nothing in the test itself
that a fake or a file could not equally well produce. #275 is that audit, and
it changes what "the suite" means: **a small, named set of files still assert
Postgres itself — `LISTEN`/`NOTIFY`, two clients racing, the Postgres store's
own SQL — and the rest run on whichever store this process opened.**

## 2. The decision

**A test run with no `LINGTAI_TEST_DATABASE_URL` defaults to SQLite, at a file
made for that run alone, and the files that still need Postgres skip instead of
failing.**

- `storeChoice` ([packages/env/src/index.ts](../../packages/env/src/index.ts))
  answers `{ store: "sqlite", path: <LINGTAI_TEST_SQLITE_PATH> }` where a test
  run names no Postgres URL and does name that variable — never
  `join(stateDir(), SQLITE_LOG)`, which on a machine that chose SQLite for
  itself is the operator's own log, and never a fixed path under `tmpdir()`,
  which two worktrees running the suite at once would share.
- `packages/event-store/test-support/teardown.ts`'s `setup()` — already
  `vitest.config.ts`'s integration `globalSetup` — `mkdtemp`s that directory and
  exports the variable, only where no Postgres URL is already set. `teardown()`
  removes the whole directory, which is the entire SQLite cleanup: no per-file
  `afterAll`, no residue sweep, nothing to disable a rule on.
- `@lingtai/event-store/test/postgres`'s `ON_POSTGRES` names every file that
  still calls `pg`, `createDb(` or a `createPostgres…` factory, with the reason
  — and `packages/event-store/unit/on-postgres.test.ts` reads every integration
  file's own source and fails if one reaches Postgres without being listed, or
  a listed one no longer does. Each such file wraps itself in
  `describe.skipIf(!postgresUnderTest())`.
- `testUrl` still throws exactly as before where neither variable is set, and
  the wording changes: not *"go and set up a second database"*, but *this
  caller needs Postgres, and only the files on that list do.*

**A suite that exists to assert Postgres still never passes against SQLite.**
The property 0046 §3, 0055 §2 and 0056 §4 protect is unchanged: nothing that
asserts a Postgres-only behaviour is answered by a file. What moved is the
mechanism that kept that true — a blanket refusal of the whole run, replaced by
a per-file skip that a type (`on-postgres.test.ts`) holds to the code rather
than to memory, which is [0055 §1](0055-two-implementations-chosen-at-init.md)'s
own argument turned on this ticket's own list.

## 3. What this means on a machine with no Postgres at all

**The skip means *not asserted*, plainly.** Nobody has to set
`LINGTAI_TEST_DATABASE_URL` any more for `pnpm test:integration` to pass, which
means the eight files on `ON_POSTGRES` — two clients racing an append, a claim,
`LISTEN`/`NOTIFY`, the Postgres queries and projection contracts, the Postgres
daemon store and beacon — run nowhere until somebody points that variable at a
real database. That is the same shape as the recipe's `build` comment naming
the 28 files `pnpm test:db`'s suspension stopped checking: named, rather than
silently green. `ON_POSTGRES` is that naming, kept beside the code instead of
in a comment, so a file added to the list without a real Postgres run behind it
is still visible as a skip in vitest's own count and not a pass that proves
nothing (0016 §4).

## 4. What this does not change

**Postgres is still what a machine can choose to run** (0055 §1). This is only
about the *test* side's default; `storeChoice` for a real machine — no
`inTest` — is untouched, and a machine that wrote `store: postgres` still opens
exactly that.

**`#157`'s finding about the pooler stays true**, for the URL that is left: the
dashboard offers the pooler first, and that is now a fact about this system's
own log's connection string rather than about a second, throwaway one.

**0060 / T11 stand.** The integration half still runs after the merge and a
ticket still must not wait for it; what changed is only which files inside that
half need a second database to mean anything.

## Consequences

- `env: { required: [...] }` in both machine recipes — `~/.lingtai/lingtai/recipe.yml`
  and this repository's inert copy, `.lingtai/config.yaml` — drops
  `LINGTAI_TEST_DATABASE_URL`; `lingtai doctor` asks for nothing that recipe no
  longer names.
- `.env.example`'s test-database lines become optional and commented, with a
  pointer to `ON_POSTGRES` rather than to "the suite refuses without this."
- A file that starts calling `pg`, `createDb(` or `createPostgres…` and is not
  on `ON_POSTGRES` fails `packages/event-store/unit/on-postgres.test.ts` — the
  check this ADR relies on to keep the list honest.
- `packages/daemon/integration/lock.test.ts`'s `expect(directPostgresUrl()).toBeTruthy()`
  is deleted: it asserted a rule that left with 0052 — every lock is a file —
  and had nothing to do with which store the suite runs on.

## Related

- [0046](0046-lingtai-is-personal.md) §3 — the sentence this refines: SQLite is
  the default *for a machine*, and the test side was the named exception. The
  exception is narrower now, not gone.
- [0055](0055-two-implementations-chosen-at-init.md) §1 — a set held by memory
  drifts; the argument this ADR's own `ON_POSTGRES` list is built to satisfy,
  applied a second time.
- [0056](0056-the-store-is-a-written-choice.md) §4 — `.env.local` cannot decide
  which store a *machine* runs; unaffected, since `LINGTAI_TEST_SQLITE_PATH` is
  exported by `globalSetup` and never read from a checkout's file.
- [0009](0009-two-connections.md) — the pooler-versus-direct distinction
  `#157`'s finding is about, kept for the one connection string left.
- `doc/design/275.md` — the design note this ADR and its implementation follow.
- `#178` — the SQLite log, waker and lock. What makes this default cheap to
  reach for.
