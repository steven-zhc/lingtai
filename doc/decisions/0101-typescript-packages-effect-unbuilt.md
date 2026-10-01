# 0101 — Architecture: TypeScript in one workspace, run unbuilt, with Effect only where something is acquired

**Status** accepted · 2026-10-01

Lingtai is TypeScript throughout, in one pnpm workspace of `packages/*` and
`apps/*`. Node runs the source directly, with no build step, so every file obeys
Node's strip-only rules. The packages are layered: `domain` at the bottom, the
packages that touch the world in the middle, `conductor` above them, and the hosts
(`daemon`, the CLI, the board) on top. The conductor reaches git and the agent
through two ports that a host provides. Effect is used for those ports, for the
adapters behind them and for the conductor's run, because a run acquires resources
and has to release every one on every path. Everything that acquires nothing stays
plain functions. The only file that is not ordinary TypeScript on Node is the
hook, a compiled single-file binary.

## Context

One system has to share its event definitions between a scheduler, a board and a
CLI. A change to an event therefore has to break all three at compile time, not at
runtime. The code is loaded by Node, and by Next for the board. A long-lived
process acquires things that must be let go: a worktree, a hook socket, an agent
process, a lock, a projector's connection. A process that leaks one of them can
finish its work and never exit. Most of this code is written by agents under a
turn limit, so every idiom it adopts is paid for again on every run.

## Decision

1. **TypeScript throughout, on Node `>=22.13`, in one pnpm workspace.** The
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
     control fold). It imports only `zod`.
   - **Plain logic:** `recipe` (load, validate, resolve), `actions` (running a
     declared action and proving it ran), `agent-env` (what an agent may see),
     `env` (Lingtai's own settings, colour, and the file lock in
     `@lingtai/env/lock`), and `extension`. `extension` depends on nothing at all,
     and `packages/extension/unit/imports.test.ts` enforces that, so a third
     party's subscriber can import it.
   - **Touches the world:** `event-store` (append, read, subscribe from any seq;
     Postgres and SQLite implementations plus `@lingtai/event-store/memory`),
     `projector` (the checkpoints and the folds into projection tables), `github`,
     `repo` (mirror, worktree, branch, push, integrate), `agent` (starting a
     runtime and the hook socket), and `telegram`, an example subscriber.
   - **Decisions:** `conductor` (claim, the pass, routing, close).
   - **Hosts:** `daemon` (lock, beacon, control stream, reconcile, the work loop),
     `apps/cli`, `apps/board` (Next), `apps/site`, and `apps/release` (packaging).
   - **The hook:** `@lingtai/hook`, a compiled binary that is placed in the
     worktree. It is not a library, and `agent` is the side that talks to it.

5. **The conductor reaches git and the agent through ports a host provides.**
   `packages/conductor/src/ports.ts` declares `Repo` and `AgentHost` as
   `Context.Tag`s over plain interfaces (`RepoPort`, `AgentHostPort`).
   `packages/conductor/src/live.ts` is the one file that names the real
   implementations (`livePorts()`), and `conduct.ts` imports only types from
   `repo` and `agent`. The event store and the GitHub client are passed in as
   values. A whole pass can therefore run against fakes with no database, no git
   and no socket. `packages/conductor/unit/conduct-a-whole-pass.test.ts` is the
   test that says the seam holds.

6. **Effect at the ports and past them, and nowhere else.** `Context.Tag` names a
   port, `Layer` provides one, and `Scope` ties each acquired resource to a
   lifetime, so a resource is released because of how the code is structured
   rather than because someone remembered to release it.
   - `runOnce` (`conduct.ts`) and `runQueue` (`schedule.ts`) are `Effect`s that
     need `Repo | AgentHost`. The hosts provide the layer and call
     `Effect.runPromise` once, at their edge (`apps/cli/src/conduct.ts`,
     `apps/cli/src/run.ts`).
   - Port methods return `Effect`s with one tagged error per package, and the
     operation is a field on it: `RepoFailed` (`@lingtai/repo`),
     `AgentHostFailed` (`@lingtai/agent`).
   - Every acquisition is an `Effect.acquireRelease` or a finalizer in the run's
     scope: the run log, the worktree, the hook socket, the agent process (released
     through an `AbortController`), the merge lane's worktree, the conductor lock
     and the projector. Finalizers run in reverse order of acquisition. That
     ordering is a rule, not just a detail: the worktree is gone before
     integration, and the run log closes last.
   - Refusals come before acquisitions. The recipe, the environment, the tier and
     the claim all refuse before the first resource is acquired.
   - Effect is a dependency of `conductor`, `repo`, `agent`, `github` and
     `apps/cli` only.

7. **What stays plain, deliberately.** `domain`, `recipe`, `actions`, `agent-env`,
   `env` and `extension` are plain functions that Effect code calls. They have no
   resources to manage. Some interfaces keep promise faces:
   - the event store, whose failures are defects rather than refusals, because a
     run cannot decide anything on behalf of a store that will not append;
   - the `GitHubClient` methods and the runtime interface `actions` consumes;
   - `git`, `provisionWorktree`, `removeWorktree` and `integrate`, which also keep
     a promise face beside their Effect one for ordinary `async` callers such as
     the board's server actions. Each has one implementation, and its promise face
     is just a `runPromise` over the Effect.

   The pass loop itself (`pass.ts`) is a plain promise. The run's Effect scope
   around it in `conduct.ts` holds what the pass cannot hold.

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
- Readers have to know `Effect.gen` as well as `async`/`await`. Keeping Effect to
  the ports, the adapters and the conductor's run keeps that cost where resources
  actually are.
- The cost that is specific to Lingtai is that agents write this code. Effect is
  kept on one condition. If an agent fails twice on otherwise in-scope work
  because it could not write correct Effect, which shows in the log as a run
  failing on a type error inside Effect code, the ports go back to plain
  interfaces and the lifetimes go back to `try`/`finally`. The leak this rule
  prevents then comes back with them.
- If a build step ever becomes necessary, rule 2 is the decision to revisit, and the
  `.ts` specifiers are what has to change.

---
*Replaces archived 0002, 0010, 0022, 0023, 0026 in [decisions-archive](../decisions-archive/).*
