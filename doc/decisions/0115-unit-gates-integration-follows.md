# 0115 — Tests: unit tests gate the diff, integration tests run apart, and the test side gets a store of its own

**Status** accepted · 2026-10-01

A test is **integration** when it exercises a dependency outside the system;
everything else is **unit**. The `build` step runs the unit half only, because a
red there buys a fix round and must therefore be a claim about the diff.
Integration runs separately and never inside a ticket. With no Postgres test URL
set, the integration half runs on a SQLite file made for that run alone; the few
files that assert Postgres itself are named on a checked list and skip, visibly,
rather than pass against SQLite.

## Context

A gate's verdict is paid for with an agent: a refusal at `build` buys a fix
round, a round off the ceiling, and a reviewer's attention. A test that can go
red for a reason the diff cannot cause — a loaded machine, the operator's own
`config.yml`, a dropped pooled connection — spends that round looking for a
defect that is not there. Separately, a suite that writes real events must
never write them into the operator's own log, and a suite that exists to assert
Postgres behaviour must never be answered by SQLite.

## Decision

1. **The line is the system's external dependencies.** Outside the system:
   Postgres, the GitHub API, the `git` binary, any OS process, the filesystem,
   the network, the real `$HOME`, the wall clock. A test that touches any of them
   is integration. A temporary directory is still the filesystem and a spawned
   `node` is still a process, however carefully the test cleans up. Reading this
   repository's own files is the system reading itself and stays unit. Slowness
   and "needs Postgres" are not the line.

2. **One root config, two projects, split by directory.** `vitest.config.ts`
   defines project `unit` (`{apps,packages}/*/unit/**/*.test.ts?(x)`, 20 s test
   and hook timeouts) and project `integration`
   (`{apps,packages}/*/integration/**/*.test.ts?(x)`, 180 s tests, 600 s hooks,
   one file at a time). Each package holds `unit/`, `integration/` or both, plus
   `test/` for shared contract suites and fixtures that are not tests themselves.
   There is no per-package vitest config. The split is by directory rather than
   by tag because vitest still imports a file to filter its tags, so a file that
   opens a pool at import fails a unit run regardless.

3. **The commands.** `pnpm test` is `vitest run --project unit`;
   `pnpm test:integration` (alias `pnpm test:db`) runs the other project;
   `pnpm test:all` runs both in one vitest run, which reports every project
   rather than stopping at the first failing package.

4. **`build` runs `pnpm test`, so a red there is a claim about the diff.** What
   `build` runs is the recipe's, in `~/.lingtai/<project>/recipe.yml`, outside
   every worktree. `HOME=/nonexistent pnpm test` is green, and that is part of
   the claim.

5. **Nobody runs the integration half while doing a ticket.** It runs longer than
   an agent's background task is allowed to live. A ticket's `Done when` asks for
   `pnpm test` and `pnpm typecheck`, and the agent commits as the work stands.
   Integration failures reach the queue as issues with a `kind` label.

6. **Unit tests record into the memory store.** A test that only records events
   uses `createMemoryEventStore()` from `@lingtai/event-store/memory`.
   `packages/event-store/test/contract.ts` runs against the memory store and
   both real stores, which is what makes the memory store safe to rely on. The
   contract runs are integration; the tests that rely on them are unit.

7. **The test side never touches the operator's store.** Under test (`VITEST` or
   `LINGTAI_TEST` set), every connection name moves to its `LINGTAI_TEST_` twin
   (`dbVar` in `packages/env/src/index.ts`), and `~/.lingtai/config.yml` is never
   read. A caller that needs Postgres and finds no test URL is refused by name;
   it never falls back to `LINGTAI_DATABASE_URL`, which an agent is never given.

8. **With no Postgres test URL, the integration half runs on a file of its own.**
   `packages/event-store/test-support/teardown.ts` is the integration project's
   `globalSetup`: its `setup()` makes a fresh directory with `mkdtemp` and exports
   `LINGTAI_TEST_SQLITE_PATH` inside it, only when `LINGTAI_TEST_DATABASE_URL` is
   unset; `storeChoice()` then answers SQLite at that path. Never
   `~/.lingtai/lingtai.db` (the operator's log on a SQLite machine) and never a
   fixed `tmpdir()` path (two worktrees would share it). `teardown()` removes the
   directory. With a Postgres test URL, `teardown()` instead deletes the run's
   throwaway `esctest…` projects and `test-<hex>` streams, refusing if the log
   holds anything else. `LINGTAI_KEEP_TEST_DATA=1` skips cleanup.

9. **Files that assert Postgres itself are listed, checked, and skip.**
   `ON_POSTGRES` in `packages/event-store/test/postgres.ts` names each such file
   and the Postgres-only thing it asserts: two clients racing an append or a
   claim, `LISTEN`/`NOTIFY`, the Postgres queries, projection, daemon-store and
   beacon implementations. Each wraps its tests in
   `describe.skipIf(!postgresUnderTest())`. `packages/event-store/unit/on-postgres.test.ts`
   reads every integration file's source and fails when one calls `pg`,
   `createDb(` or `createPostgres…(` without being listed, or a listed one no
   longer does.

10. **No connection string under test goes through a pooler.**
    `LINGTAI_TEST_DATABASE_URL` points at the direct host
    (`db.<project-ref>.supabase.co:5432` on Supabase), not a transaction pooler,
    whose dropped connections make a red mean nothing.

## Consequences

- A red `build` is worth reading: it is about the change.
- Some real claims lose their gate. The one that matters most is the Next build
  in `apps/release/integration/build.test.ts`, the only check that sees a
  server-only import reaching a `"use client"` graph; it is caught after merge.
- `main` is not proven green by whatever merged into it. An integration
  regression can land and is caught later.
- On a machine with no Postgres test URL, the `ON_POSTGRES` files assert
  nothing. That shows as skips in vitest's own count, not as a silent pass.
- Adding a Postgres-reaching integration file means adding it to
  `ON_POSTGRES`, or the unit half fails.

## Not built yet

- **The separate system that runs the integration half after every merge into
  `main` and files a failure as a `kind`-labelled issue.** Today CI runs only two
  integration files (`apps/release/integration/build.test.ts` in
  `.github/workflows/release.yml`, `packages/daemon/integration/file-lock.test.ts`
  in `lock.yml`); the rest is run by a person.
- **A check that enforces the boundary.** Nothing refuses `node:child_process`,
  network or live clients inside `unit/`; directory placement is kept by review.

---
*Replaces archived 0060, 0074 in [decisions-archive](../decisions-archive/).*
