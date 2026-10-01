# 0023 — Effect at the port boundary, and nowhere else

**Status** accepted · 2026-09-04 · implements the injection [0022](0022-the-seams.md) asks for

## Context

[0022](0022-the-seams.md) says `conductor` declares the interfaces it needs and a
host provides them. That is dependency injection, and this repository already
does the easy half of it: `runOnce` takes `client`, `runtime`, `token` and
`store` as parameters.

**Parameters work for values and do not work for lifetimes.** 0022 also says
every host that appends holds a `projector` while it runs. Something then has to
guarantee that the projector opened for a run is closed when the run ends — on
*every* path, including the four early `return 1`s in `run()` for a missing
recipe, project, owner or hook binary. Nothing does today. The consequence is not
hypothetical: a follower left open holds a session-mode Postgres connection **and
keeps the event loop alive**, so a leaked one is a command that finishes its work
and never exits. `catchUpProjections` avoids it only by closing in a `finally`
one line after it opens — which is exactly why the board is blind during a run
(#64).

The same shape recurs everywhere the system acquires something: the worktree that
must be removed before the integrator can update the ref, the advisory lock, the
hook socket, the agent process under a wall limit.

## The spike

Run before deciding, because [0010](0010-source-runs-unbuilt.md) forbids a build
step and Effect is a type-heavy library:

- `effect@3.22.1`, Node 26, **no build**. `Context.Tag`, `Layer.scoped`,
  `Effect.gen`, `Data.TaggedError` and `Effect.catchTag` all run under Node's
  strip-only TypeScript. Nothing needs a transform; no `enum`, no `namespace`,
  no decorators.
- `tsc --noEmit` under this repository's exact `strict` +
  `noUncheckedIndexedAccess` + `verbatimModuleSyntax` + `isolatedModules`
  settings: **0 errors, 0.55s**.
- A scoped resource was released on all three paths — the happy one, an early
  typed refusal *taken before the resource was ever used*, and a mid-run
  failure. Acquired 3, released 3.

The third result is the decision. That is the bug class, closed structurally.

## The decision

**`Context.Tag` names a port. `Layer` provides one. `Scope` ties an acquired
resource to a lifetime, so release is structural rather than remembered.**

And the boundary of the boundary:

- `domain`, `recipe` and `actions` stay **plain functions** that Effect code
  calls. They have no resources and no failure modes worth a channel.
- The adapter packages and `conductor` are Effect.
- The hosts call `runPromise` at the edge, once.

## The cost, which is real

[design.md §8](../design.md) refuses ceremony until a specific failure demands
it, and a framework adopted up front is the shape that list guards against. Three
costs are accepted deliberately:

**It is viral.** Once `conductor` returns an `Effect`, everything calling it
does. That is why the pure packages are kept out: the virus stops at functions
that take values and return values.

**It is a second idiom.** A reader now needs `Effect.gen` as well as
`async`/`await`. Confining Effect to the ports and `conductor` keeps that cost
where the benefit is.

**This repository is written by an agent.** A steep idiom is not paid once by a
person who learns it; it is paid again on every run, by a model that has to
produce it correctly under a turn limit. This is the cost that is specific to
Lingtai and it is the strongest argument against. It is accepted because the
alternative — hand-rolled lifetime management across five adapters and three
hosts — is the thing that has already failed twice this week.

## What would reverse this

A run that fails because the agent could not write correct Effect, twice, on
work that is otherwise in scope. That is checkable from the log: a `RunFailed`
or a `proposed` gate refusing on a type error inside Effect code. If it happens,
the ports go back to plain interfaces and lifetimes go back to `try`/`finally` —
and the leak this file exists to prevent comes back with them, which is the
trade being made rather than a hidden risk.
