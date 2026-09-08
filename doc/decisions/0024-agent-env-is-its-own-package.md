# 0024 — The agent's environment is its own package, and Effect is in

**Status** accepted · 2026-09-08 · records two decisions taken while building
[0022](0022-the-seams.md) and [0023](0023-effect-at-the-boundary.md)

## Context

Two things were decided by code during 0022's execution and were, until this
file, written down only in GitHub comments. That is the failure mode
[doc/README.md](../README.md) exists to prevent: the repository said one thing
and the source said another.

## 1. `@lingtai/agent-env`, a name 0022 recorded as undecided

0022 lists `secrets` under **Not decided**, and `#67` repeats it: *"Splitting
`@lingtai/env`. The boundary is wrong — it holds the machine's credentials …
beside the agent's own `allow`/`deny`/`required` — but the split and its name
are undecided."*

The split happened anyway, in `#68`, because `worktree.ts` forced it. That file
was 617 lines of two unrelated things: running git, and deciding what
environment an agent is given. **Those two being neighbours is the shape by
which a machine credential reaches a subprocess** — not a hypothetical, since
`RESERVED` exists precisely because someone noticed it could.

Splitting `repo` out of `conductor` meant deciding where the environment half
went, and leaving it beside git would have carried the adjacency into the new
package.

**Decision.** `@lingtai/agent-env` holds the agent's environment — the layers of
0021, `filterEnv`, `resolveAgentEnv`, `renderEnvFile`. `@lingtai/env` keeps the
**machine's**: the two connection strings, the App key, `stateDir`. The names
say whose environment each one is, which is the distinction that matters and the
one that was invisible while they shared a file.

`repo` depends on `agent-env` to render the file it plants. Not the reverse:
deciding the content is not a filesystem operation.

**What is still not decided** is `secrets` — a source that fetches a value on
demand (`SECRET=!op read op://…`). 0022 left it out and it stays out.

## 2. Effect is in, and 0023 stands

0023 was accepted on 2026-09-04 and then not implemented: `#66` and `#68` both
reached for `try`/`finally` where it prescribes `Scope`, on the reasoning that
one resource with one acquisition point does not need a framework, and that
`#68` turned the lifetime into a port method a fake can assert.

**That reasoning was overruled by the operator, deliberately, on 2026-09-08.**
The stated grounds are the two things 0023 offers that `try`/`finally` does not:
dependency injection that does not thread a parameter through every caller, and
a typed error channel. Both are bets on later work rather than on today's, which
is a call the operator gets to make and this file records rather than argues.

**Decision.** 0023 stands unchanged. It is now partly built:

- `Context.Tag` names `Repo` and `AgentHost`; `Layer` provides them
  (`conductor/src/ports.ts`, `conductor/src/live.ts`).
- `Layer.scoped` holds the projector for a run (`apps/cli/src/projector.ts`).
- `Data.TaggedError` carries `run()`'s five refusals; `Effect.catchTag` turns
  each back into one line and one exit code, in one place.
- `Effect.runPromise` at the edge, once.

**What is not built**, so that the gap is a fact rather than a discovery:
`runOnce` and the adapter packages are still `async`/`await` behind
`Effect.promise`. 0023 says *"the adapter packages and `conductor` are Effect"*;
today only the seam is.

> **Superseded by [0026](0026-the-conversion-past-the-seam.md)** on 2026-09-08.
> The paragraph above described the state on the day this file was written and
> is left as written; 0026 is what closed it, and its own "what is not
> converted" list is the current answer to the same question.

### One thing the conversion taught, worth keeping

A `Layer` is built where it is *provided*, so providing the projector to the
whole of `run()` acquired it **before the first refusal could be raised** —
`lingtai run no-such-project` opened a Postgres connection in order to say a
project does not exist. `Scope` guarantees release; it says nothing about
whether acquiring was wanted. Where a scope starts is still a decision, and it
now starts after the refusals.

## 3. Only the daemon reconciles

`#69` asked that `reconcile` be *"called by every long-lived host at startup"*.
Only `lingtai daemon` calls it. The pass **appends** — it releases claims other
runs hold — and a one-shot command somebody is watching should not have that
effect on work it was not asked about. The daemon is what takes work unattended,
so it is what owes the repair. Recorded in `reconcile.ts` beside the code.

## Consequences

- Thirteen packages, and `agent-env` is one of them by decision rather than by
  accident.
- The `effect` dependency is real and viral at the seam; the cost 0023 wrote
  down — *"this repository is written by an agent"* — is now being paid, and its
  own reversal condition (an agent failing twice on Effect it could not write)
  remains the thing to watch for.
- `doc/README.md` lists 0023 as accepted, and that is now true of the code as
  well as of the decision.
