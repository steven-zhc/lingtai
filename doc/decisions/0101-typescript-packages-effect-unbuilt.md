# 0101 — Architecture: TypeScript in one workspace, run unbuilt, with every effectful backend path in Effect

**Status** accepted · 2026-10-31

Lingtai is TypeScript throughout, in one pnpm workspace of `packages/*` and
`apps/*`. Node runs the source directly, with no build step, so every file obeys
Node's strip-only rules. The packages are layered: `domain` at the bottom, the
packages that touch the world in the middle, `conductor` above them, and the hosts
(`daemon`, the CLI, the board) on top. The conductor reaches git and the agent
through two ports that a host provides. **Every backend function that does IO is
an Effect**: the store, the projector, GitHub, git, the agent, the actions, the
attempt, the daemon's loop and the CLI's commands. That is one model for acquiring
and releasing resources, one for typed failure, and one for tracing — an Effect
span is an OpenTelemetry span, so an attempt is a trace without a second set of
instrumentation. Pure logic — the event catalogue and its reduces, the recipe's
parsing and validation — stays plain functions that Effect code calls. The board
stays `async` and runs Effect at its edge. The only file that is not ordinary
TypeScript on Node is the hook, a compiled single-file binary.

## Context

One system has to share its event definitions between a scheduler, a board and a
CLI. A change to an event therefore has to break all three at compile time, not at
runtime. The code is loaded by Node, and by Next for the board. A long-lived
process acquires things that must be let go: a worktree, a hook socket, an agent
process, a lock, a projector's connection. A process that leaks one of them can
finish its work and never exit. Most of this code is written by agents under a
turn limit, so every idiom it adopts is paid for again on every run.

## Decision

1. **TypeScript throughout, on Node `>=26`, in one pnpm workspace.** The
   version is written once, in `.node-version`: `engines`, every workflow and
   the machine building binaries read it from there, because a floor below the
   Node the repository is actually run on is a floor nothing tests (#430). The
   workspace is `packages/*` and `apps/*` (`pnpm-workspace.yaml`), with one
   `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`,
   `verbatimModuleSyntax`, `isolatedModules`, `noEmit`. Events are zod schemas in
   `@lingtai/domain`, and every reader and writer imports them from there, so
   one definition of state exists and the compiler holds everything to it.

2. **The source runs unbuilt.** Every `exports` entry points at a `.ts` file. The
   CLI is `node apps/cli/src/entry.ts`, and the daemon, the tests and the scripts
   load the same source. Node strips the types and changes nothing else, so:
   - **relative imports carry `.ts`**, including in `index.ts` barrels. Never
     `.js`, never extensionless;
   - **no syntax that emits code:** no `enum`, no `namespace`, no constructor
     parameter properties, no decorators. Type-only syntax is fine. Use zod
     enums or `as const` objects instead of `enum`.

   `tsc --noEmit` and the board's Next build do not prove that a package loads,
   because both map `.js` back to `.ts` on their own. The check that does prove it
   is `node -e "import('@lingtai/<pkg>')"`. The release bundle in `apps/release`
   is a distribution artifact (see the distribution ADR). It is not a build the
   source depends on.

3. **Removing the build does not remove the restart.** Node caches a module when
   it is imported, so a long-lived process keeps running the code `HEAD` held when
   it started, through every merge after that. The CLI starts fresh on every
   invocation and the board hot-reloads. The daemon is the one process that holds
   its code. It records the commit it started from, and putting new code into
   effect means restarting it ([0102](0102-one-conductor-holds-the-lock.md)).

4. **The packages, by layer.** A package depends only on packages below it.
   - **Vocabulary:** `domain` (the event catalogue, reducers, upcasting, the
     control reduce). It imports only `zod`. **A stream's reducer exists once, here.**
     Every other package that needs a stream's state — the conductor, the
     daemon, the CLI, the projector's per-stream part, and the board — calls the
     domain reduce and never reduces the same events itself; the board *presents* a
     domain state (`present(state, …)`) and joins in what is not on the stream,
     such as the recipe's plan. A branch on an event type outside `domain` is a
     reaction (a subscriber, a notification) or a lookup, never a second reduce.
     The snapshot of a reducer ([0124](0124-a-stream-fold-is-cached-as-a-snapshot.md))
     is only correct because there is one.
   - **Plain logic and its loaders:** `recipe` (load, validate, resolve), `actions` (running a
     declared action and proving it ran — IO, so Effect under rule 6), `agent-env` (what an agent may see),
     `env` (Lingtai's own settings, colour, and the file lock in
     `@lingtai/env/lock`), and `extension`. `extension` depends on nothing at all,
     and `packages/extension/unit/imports.test.ts` enforces that, so a third
     party's subscriber can import it.
   - **Touches the world:** `event-store` (append, read, subscribe from any seq;
     Postgres and SQLite implementations plus `@lingtai/event-store/memory`),
     `projector` (the checkpoints and the reducers into projection tables), `github`,
     `repo` (mirror, worktree, branch, push, integrate), `agent` (starting a
     runtime and the hook socket), and `telegram`, an example subscriber.
   - **Decisions:** `conductor` (claim, the attempt, routing, close).
   - **Hosts:** `daemon` (lock, beacon, control stream, reconcile, the work loop),
     `apps/cli`, `apps/board` (Next), `apps/site`, and `apps/release` (packaging).
   - **The hook:** `@lingtai/hook`, a compiled binary that is placed in the
     worktree. It is not a library, and `agent` is the side that talks to it.

5. **The conductor reaches git and the agent through ports a host provides.**
   `packages/conductor/src/ports.ts` declares `Repo` and `AgentHost` as
   `Context.Service`s over plain interfaces (`RepoPort`, `AgentHostPort`).
   `packages/conductor/src/live.ts` is the one file that names the real
   implementations (`livePorts()`), and `conduct.ts` imports only types from
   `repo` and `agent`. The event store and the GitHub client are passed in as
   values. A whole attempt can therefore run against fakes with no database, no git
   and no socket. `packages/conductor/unit/conduct-a-whole-attempt.test.ts` is the
   test that says the seam holds.

6. **Effect wherever there is IO.** `Context.Service` names a
   port or a service, `Layer` provides one, and `Scope` ties each acquired resource to a
   lifetime, so a resource is released because of how the code is structured
   rather than because someone remembered to release it.
   - **What is an Effect**: every function in `apps/cli`, `event-store`,
     `projector`, `github`, `repo`, `agent`, `actions`, `conductor`, `daemon`,
     `setup`, `recipe` and `sandbox` that reads or writes outside the process — the store, a
     table, the network, git, a child process, the filesystem, the clock it waits
     on. These are the packages `PACKAGES` names in
     `packages/domain/unit/effect-ratchet.test.ts`, and
     `packages/domain/unit/effect-ratchet.baseline.json` holds each at 0 `async`
     functions and 0 `Effect.run*` calls. Each returns an `Effect` with a tagged
     error per package, never a promise and never a thrown error for a failure
     the caller is meant to decide on.
   - **`Effect.run*` only at a host's edge**: the CLI's one run
     (`apps/cli/src/entry.ts`, which covers every command, `daemon` included), a
     board read, server action or route handler (`apps/board/src/app/actions.ts`,
     `apps/board/src/lib/board.ts`), and a test. The site (`apps/site`) runs
     no Effect of its own: its scripts (`apps/site/scripts/books.ts`,
     `apps/site/scripts/snapshot.ts`) call the promise faces of §7, so their
     `Effect.runPromise` runs inside a registered face and they are a host the
     faces file names. `runPromise` and not `runMain`
     at the CLI, because `runMain` interrupts the main fiber on SIGINT and the
     daemon's first Ctrl+C is a drain. Never inside backend code — a
     `runPromise` nested in an Effect starts a fiber with no parent, which loses
     the caller's scope, its interruption and its span. A fiber that backend code
     must start itself, such as a pass the scheduler starts detached, runs with
     `Effect.runPromiseWith(yield* Effect.context())`, which carries the
     caller's services and its tracer into the new root fiber
     (`packages/conductor/src/schedule.ts`; `packages/conductor/src/run-attempt.ts`
     says why: a bare `runPromise` would drop the pass's span). The ratchet counts
     a `*With` run over `Context.empty()` or `Context.make(…)` as the root run it
     is, and does not count one over the caller's own context.
   - **Tracing is Effect's**: a named operation is `Effect.withSpan` (or
     `Effect.fn`), and a host that has `telemetry.otlp_endpoint` provides
     `tracingLayer` (`packages/conductor/src/telemetry.ts`, which is
     `Layer.succeed(Tracer.Tracer, bridgedTracer)`), exporting over OTLP/HTTP. A span carries
     no URL, no token, no title and no body; the one identifying attribute it may
     carry is `lingtai.ticket`, the issue number. The board's own read spans
     (`apps/board/src/lib/telemetry.ts`) follow the same rules.
   - `runOnce` (`conduct.ts`) and `runQueue` (`schedule.ts`) are `Effect`s that
     need `Repo | AgentHost`. The hosts provide the layer and the CLI's one run
     executes them (`apps/cli/src/conduct.ts`, `apps/cli/src/run.ts`).
   - Port methods return `Effect`s with one tagged error per package, and the
     operation is a field on it: `RepoFailed` (`@lingtai/repo`),
     `AgentHostFailed` (`@lingtai/agent`).
   - Every acquisition is an `Effect.acquireRelease` or a finalizer in the run's
     scope: the run log, the worktree, the hook socket, the agent process (released
     through an `AbortController`), the merge lane's worktree, the conductor lock
     and the projector. Finalizers run in reverse order of acquisition. That
     ordering is a rule, not just a detail: the worktree is gone before
     integration, and the run log closes last.
   - Refusals come before acquisitions. The recipe, the environment, a runtime that
     cannot fail closed and the claim all refuse before the first resource is acquired.
   - The event store's failures stay **defects** rather than tagged errors: a run
     cannot decide anything on behalf of a store that will not append.

7. **What stays plain, deliberately.** `domain`, `recipe`'s parsing and
   validation, `agent-env` and `extension` are pure functions that Effect code
   calls; they do no IO and have no resources to manage. `extension` depends on
   nothing at all, so a third party's subscriber can import it.
   **`env` reads configuration through Effect's `Config`**
   ([0117](0117-configuration-is-config-yml-and-the-environment.md)): one
   `ConfigProvider` per source, so the file's keys and the environment's names
   map onto each other mechanically and one `Config` describes both. It is run
   with `Effect.runSync` inside `env`'s own functions, so a caller gets a plain
   value or a plain error.
   **A third-party promise library is called through `Effect.tryPromise`** at the
   call site: `@clack/prompts`, wrapped by `apps/cli/src/prompt.ts` and reached
   through `apps/cli/src/question.ts`. `ora` is driven as a synchronous spinner
   object by `apps/cli/src/steps.ts`, inside the Effect that owns the step.
   **`packages/telegram` and `apps/cli/src/notify.ts` import no `effect`**: a
   notifier a third party could write imports nothing but `node:` and
   `extension` (`packages/telegram/src/cli.ts`), so both stay plain and are not
   counted.
   **The board** (`apps/board`) stays `async`: its Server Components and server
   actions call backend Effects with `Effect.runPromise` at their edge, and its
   own read spans are `@opentelemetry/api` (#775). A package that a host calls
   may keep a promise face beside its Effect one. A face is an exported function
   whose whole body is `return Effect.runPromise(<call>)` or
   `return Effect.runPromise(<call>, { signal })` — the call being a concrete
   Effect (`wakeSessionFace`, `followFace` in
   `packages/event-store/src/store-face.ts`, which take the caller's
   `AbortSignal`) or the face's own Effect parameter
   (`packages/github/src/app.ts`, `packages/conductor/src/port-face.ts`) — one
   implementation, never two — and each is listed in `packages/domain/unit/effect-ratchet.faces.json`
   with `until: "0101 §7"` and a `why` naming the host or the host's test that
   reads it. A face that inspects an `Exit` or runs synchronously is a run, and
   is counted.

8. **The hook is the one exception to "TypeScript on Node".** `lingtai-hook` is a
   dependency-free thin client, compiled with
   `bun build --compile` (`packages/hook`). It reads stdin, asks the conductor over
   a unix socket, and exits. It fails closed: exit 2 on any fault. It follows the
   same strip-only rules as everything else, even though Bun would accept more.

## Consequences

- Changing an event definition breaks the conductor, the CLI and the board at
  compile time, which is the point of having one language.
- `enum` and parameter properties are unavailable. That costs little, because zod
  enums are both values and types.
- A green `tsc` is not proof that a package loads under Node. Import it.
- Readers have to know `Effect.gen`; backend code has one style rather than two,
  and the line between them is IO, not which package a function happens to be in.
- Agents write this code, so every ticket on the backend is an Effect ticket. That
  is a cost paid on every run, and it is accepted.
- An attempt is a trace: every Effect operation with a span is a child of the step
  that ran it, and nothing is instrumented twice.
- If a build step ever becomes necessary, rule 2 is the decision to revisit, and the
  `.ts` specifiers are what has to change.

---
*Replaces archived 0002, 0010, 0022, 0023, 0026 in [decisions-archive](../decisions-archive/).*
