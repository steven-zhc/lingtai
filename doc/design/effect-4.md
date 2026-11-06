# Effect 4 — the spike

**Status** spike · 2026-11-06 · what raising every package to `effect@4.1.2` breaks
on `main` at `6a73318a`, and the order the upgrade is done in. #942's first row.
The branch `effect-4` holds the raised dependencies; it is not merged as it stands.

## What was done

- Every `"effect": "^3.22.1"` (agent, conductor, env, daemon, github, event-store,
  repo, board, cli) became `^4.1.2`, and `@effect/platform-node` became `^4.1.2`.
- `apps/cli` dropped `@effect/cli`, `@effect/platform`, `@effect/printer` and
  `@effect/printer-ansi`: `@effect/cli@0.77` still peers on `effect@^3.22`, and the
  other three are folded into `effect` (no source file imported them).
- `pnpm -r --no-bail --if-present typecheck`.

## What it found

851 errors as `tsc` prints them, **276 once each `file:line` is counted once** — a
package that imports `env` reprints `env`'s errors. They are in 30 files:

| file | errors | cause |
|---|---|---|
| `packages/conductor/src/conduct.ts` | 111 | `Either` is gone, and every value that came out of it is now `unknown` (`TS18046`, `TS7006` follow from it) |
| `apps/cli/src/cli.ts` | 45 | `@effect/cli` → `effect/cli`: `Args` is `Argument`, `Options` is `Flag` |
| `packages/env/src/index.ts` | 17 | `Config` is schema-based (`Config.String`, `Config.Number`, `Config.Port`); `ConfigProvider.fromMap`/`fromJson` are `fromEnvRecord`/`fromUnknown`; `Effect.withConfigProvider` is gone (a provider is a `Context.Reference`, given with `ConfigProvider.layer`) |
| `apps/cli/src/run.ts` | 13 | `Either`, the CLI |
| `packages/conductor/src/telemetry.ts` | 12 | `Tracer.make` takes `{ span(options), context(primitive, fiber) }`: `span` gets one options object instead of six positional arguments, and `context` wraps an effect primitive |
| `packages/repo/src/integrate.ts` | 8 | `Either`, `Effect.either` |
| 24 more files | 1–6 each | `Either`/`Effect.either`, `Context.Tag`, the board's `ManagedRuntime` + `Context.Tag` (`apps/board/src/lib/snapshot-writer.ts`), tests that build an `Either` |

## The renames that cover most of it

| v3 | v4 |
|---|---|
| `Either`, `Either.isLeft` / `isRight`, `.left` / `.right` | `Result`, `Result.isFailure` / `isSuccess`, `.failure` / `.success` |
| `Effect.either` | `Effect.result` |
| `Either.match({ onLeft, onRight })` | `Result.match({ onFailure, onSuccess })` |
| `Context.Tag('id')<Self, Shape>()` | `Context.Service` |
| `Effect.catchAll` | `Effect.catch` (`catchTag`, `catchTags` keep their names) |
| `Effect.runtime<R>()` + `Runtime.runPromise(rt)` | `Effect.context<R>()` + `Effect.runPromiseWith(services)` |
| `Config.string` / `number` / `port` | `Config.String` / `Number` / `Port` |
| `ConfigProvider.fromMap` / `fromJson` | `ConfigProvider.fromEnvRecord` / `fromUnknown` |
| `@effect/cli` `Args` / `Options` / `Command` | `effect/cli` `Argument` / `Flag` / `Command` |

No codemod was used; the renames are mechanical except in `env` (the provider is a
service now), `telemetry.ts` (the tracer's shape) and `cli.ts` (the CLI library).

## The order

The version is shared, so nothing lands until all of it typechecks. Inside the one
branch, in commits that each leave the packages before them green:

1. `env` — `Config` and `ConfigProvider`. Everything imports it.
2. `Either` → `Result` and `Effect.either` → `Effect.result` across `repo`,
   `daemon`, `event-store`, `conductor`, `cli` and the tests.
3. `Context.Tag` → `Context.Service`; `catchAll` → `catch`; `schedule.ts`'s and
   the board's runtime → `Effect.context` + `runPromiseWith`.
4. `telemetry.ts`'s tracer, then one live pass checked as one connected trace.
5. `apps/cli` on `effect/cli`. Last, because its help text is generated into
   `doc/cli.md` (`pnpm docs:cli`) and tests pin it: any change in what the CLI
   prints is reviewed, not accepted.

Then `pnpm typecheck`, `HOME=/nonexistent pnpm test`, `pnpm lint`, `pnpm docs:cli`,
main merged in, and the branch lands.

## Risks

- **The CLI's output.** `effect/cli` renders help and errors its own way. A help text
  that changes is a `doc/cli.md` diff a person reads before it lands.
- **The trace.** A tracer that typechecks can still parent spans wrongly. The check is
  a live pass, not the suite.
- **Config errors.** `env` turns a bad value into a sentence a person reads
  (0117). v4's `Config` errors are Schema issues, so the sentences are re-checked
  against `packages/env/unit/`.
