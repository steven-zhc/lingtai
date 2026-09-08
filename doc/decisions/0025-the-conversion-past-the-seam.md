# 0025 — The conversion goes past the seam: `runOnce` and the adapters are Effect

**Status** accepted · 2026-09-08 · supersedes the *"What is not built"* paragraph
of [0024 §2](0024-agent-env-is-its-own-package.md); implements
[0023](0023-effect-at-the-boundary.md)

## Context

0023 drew a boundary and named the two sides:

> - `domain`, `recipe` and `actions` stay **plain functions** that Effect code calls. …
> - The adapter packages and `conductor` are Effect.
> - The hosts call `runPromise` at the edge, once.

0024 recorded, deliberately rather than leaving it to be discovered, that only
the middle line was unbuilt: *"`runOnce` and the adapter packages are still
`async`/`await` behind `Effect.promise`. … today only the seam is."*

The whole conversion was eleven lines of `apps/cli/src/run.ts`, and the last of
them undid it:

```ts
yield* Projector;
const ports = { repo: yield* Repo, agent: yield* AgentHost };

return yield* Effect.promise(async () => {   // ← the frame the guarantee stopped at
```

Past that line the run was 754 lines of `async`/`await` holding 0023's two
guarantees by hand:

- **Release** was two nested `finally` blocks — `server.close()` and
  `ports.repo.remove(...)`, each swallowing its own failure with
  `.catch(() => {})`.
- **Every exit appends** was a `catch (err)` whose own comment admitted what it
  was: *"the catch-all that keeps 'every exit appends' true for anything
  unforeseen."* `Effect.promise` surfaces no failure type at all, so nothing
  above that frame could see one either way.

`repo/src/integrate.ts` had its own pair of nested `finally`s, and
`github/src/app.ts` guarded a token refresh with `.finally()`.

The point is not that any of these were wrong. They were right, and each was
right for the same reason: one function happened to own both ends of one
resource. That is the property 0023's spike closed structurally, and it is a
property a refactor can quietly remove.

## The decision

**0023 as written, one frame further in.**

1. **`runOnce` and `runQueue` are `Effect`s.** They ask for `Repo` and
   `AgentHost` where they use them; `RunPorts` survives only as the plain shape
   a `Layer` is *built from* — what `livePorts()` returns and what a test's
   fakes are. The hosts (`apps/cli/src/run.ts`, `apps/cli/src/conduct.ts`)
   provide `PortsLive` and call `runPromise` at their own edge.

2. **The port methods return `Effect`s**, so the failure of a port is in a
   channel the conductor's types can see: `RepoFailed` from `@lingtai/repo`,
   `AgentHostFailed` from `@lingtai/agent`. One tagged error per package, with
   the *operation* as a field, so a new call site adds a value and not a type.

3. **Three acquisitions, three scopes.** The worktree, the hook socket and the
   agent process are `Effect.acquireRelease` pairs. The agent process is the one
   that had no release at all: an interrupted run left a `claude` process
   holding the worktree, and the release is an `AbortController` whose signal
   `RunRequest` already accepted.

4. **The scopes carry an ordering that used to be a comment.** *The worktree is
   gone before the integrator runs* — because git refuses to update a ref some
   worktree has checked out — is now expressed by the integrator being outside
   the worktree's scope, rather than by an explicit `remove` call halfway down
   the function with a paragraph explaining why it is there.

5. **The catch-all is reduced to a defect handler and named as one.** Every
   refusal `runOnce` makes after the claim is a `Data.TaggedError` carrying the
   stage, the detail and the release reason; one handler releases and reports
   for all of them. What is left catches *defects* — a store that would not
   append, a gate callback that threw — and an `ensuring` catches the third
   ending, an interruption, which is neither a failure nor a defect.

6. **The refusals still come before the acquisitions.** 0024's one lesson —
   *a `Layer` is built where it is provided, so a scope that starts too early
   acquires what a refusal would have made unnecessary* — applies unchanged to
   the scopes inside `runOnce`. The recipe, the environment, the dispatch tier
   and the claim all refuse before the first `acquireRelease`.

7. **`agent-env` stays plain.** 0023's list of packages that stay plain
   functions is `domain`, `recipe` and `actions`; `agent-env` decides *what an
   agent may see* and acquires nothing, so it belongs with them. `live.ts`
   wraps it in the one place that is allowed to know the names.

## What is stated as a test rather than as a comment

Two of the sentences this file argues for are now assertions in
`packages/conductor/pure/run-once.test.ts`, which runs against fakes with no
database, no git and no socket:

- **"It refuses before it acquires anything."** A run that stops at an
  unreadable recipe reaches the refusal with the fake ports' record empty —
  no `provision`, nothing to unwind.
- **"Every exit appends."** A port that throws where its type says it cannot
  still leaves `WorkItemReleased` on the work item and still takes the worktree
  down. That was the catch-all's comment; it is the test's name.

The third, that a scope releases what a `finally` used to, is the `close`
assertion in the held-run test: nothing in the file calls it, and it happens —
before the worktree's removal, because finalizers run in the reverse of
acquisition.

## What is *not* converted, so that the gap is a fact rather than a discovery

- **`Runtime` is still a promise interface.** `packages/actions` consumes it,
  and 0023 keeps `actions` plain. Converting `Runtime` would carry Effect into
  the one package 0023 names as staying out, which is a bigger decision than
  this ticket.
- **`GitHubClient` is still a promise interface.** `github` exposes
  `installationToken` as its Effect face and the `.finally()` at the token
  refresh is gone, but the client's own methods are used by the board, the
  daemon and four CLI commands. Converting it is worth its own ticket, and worth
  doing only if something asks for it.
- **`git`, `provisionWorktree`, `removeWorktree`, `integrate` keep promise
  faces** beside their Effect ones, because `apps/board/src/app/actions.ts` is a
  Next.js server action and `conductor/src/approve.ts` is ordinary `async` code.
  One implementation, two faces; the promise face is a `runPromise` and nothing
  else.
- **The event store is still a promise, and its failures are defects.** That is
  a choice and not an oversight: a store that will not append is not a refusal
  `runOnce` can make on anyone's behalf, and the defect handler is where it is
  answered. If that turns out to be the wrong line, it moves — with a
  superseding file, not an edit.

## The cost 0023 wrote down, one run later

0023 said the strongest argument against was that *"this repository is written
by an agent"*, and set the reversal condition: **an agent failing twice on
Effect it could not write**, visible in the log as a `RunFailed` or a `proposed`
gate refusing on a type error inside Effect code. That has not happened, and
this conversion is the largest single piece of Effect the project has asked for.
The condition stands unchanged and is still the thing to watch for; this file
does not claim it has been retired, only that it has not fired.

## Consequences

- `effect` is a dependency of `repo`, `agent` and `github` as well as
  `conductor` and `cli`. Five of thirteen packages, which is what "viral at the
  seam" costs when the seam moves one frame in.
- `doc/README.md` lists 0023 as accepted, and that is now true of the code as
  0023 described it rather than of its seam only.
- There is no `finally` in `packages/conductor/src/run-once.ts` and none in
  `packages/repo/src/integrate.ts`.
