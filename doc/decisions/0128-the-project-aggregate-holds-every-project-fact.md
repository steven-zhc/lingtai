# 0128 — The Project aggregate holds every fact about a project, and its recipe file is a projection of it

**Status** accepted · 2026-11-14 · not yet built

A project is one aggregate, `prj-{project}`, and everything Lingtai knows
about a project is reduced from that stream: where its code lives, whether it
is paused or refused, which recipe it runs, and which sandbox boundary its runs
actually met. The recipe is part of that aggregate, not an aggregate of its
own: every change to it is an event on `prj-{project}`, and
`~/.lingtai/<project>/recipe.yml` is a projection of those events that the
project module keeps — a person may still edit it by hand, and the module
records that edit as an event the next time it reads. One module,
`@lingtai/project`, is the only way in: it hands out the Project, with its
recipe, and it is the only code that writes a recipe or reads the file. Inside
it, whether a field comes from replaying the stream or from the file is its own
choice; to every other part of the system the project is event-sourced.

## Context

A project's recipe has been a file on the operator's machine since #180
([0104](0104-the-recipe-is-the-pipeline.md) §1), read fresh by every attempt
and written in place by the board and the CLI. The log holds only what a run
used — `StepsResolved { configHash }` on the attempt — and the content of each
hash once, on `rcp-{configHash}`, *"as a record nothing reads back"* (0104).
So the log cannot say when a project's configuration changed or who changed it,
and the project's current recipe is not a fact the log holds at all.

That was deliberate once: `packages/domain/src/project.ts` still says *"The
recipe itself is not here. It lives in the managed repository and is re-read
from `origin/<base>` for every run, because a snapshot of it would be a second
source of truth"* (archived 0005). The reason went with the move to the
machine: the file has no history of its own now, so the log is the only place
one could be kept.

It cost #1163: to show a project's sandbox state, the board had to search the
attempt streams of each project for the latest recorded boundary and the
latest recipe, with a bound on how far it searched; every review round found
another ordering it read wrongly, because the state was assembled by searching
rather than reduced from one stream.

The streams that exist, and what each holds:

| Stream | Aggregate | Holds |
| --- | --- | --- |
| `ticket-{project}-{issue}` | Ticket | discovered, claimed, waits, landed, closed |
| `pass-{uuid}` | Attempt | runs, steps, routing, rounds, each run's sandbox boundary |
| `prj-{project}` | **Project** | registration, pause and resume, refused and recovered — and, by this decision, the recipe and the observed sandbox state |
| `rcp-{hash}` | none (a value, shared) | a recipe's content — **no longer written** (§4) |
| `int-{project}-{base}` | Integration | one landing lane per base |
| `ctl-conductor` | Control | the day's ceiling, drains, starts |
| `ctl-github-app` | GitHub App | the installation's App |
| `acct-{platform}` | Account | a platform account's limit ([0126](0126-a-stop-is-a-lock-and-an-unlock.md)) |
| `chat-{id}` | Discussion | one discussion |
| `bkl-{project}-{key}` | Backlog finding | a minor finding a person decides |
| `ext-subscribers` | none (a log) | subscribers that failed |

## Decision

1. **The word is project.** Lingtai manages projects. *Repository* names only
   where a project's code lives — the GitHub `owner/repo`, a clone, a mirror —
   never the thing Lingtai manages.

2. **The Project aggregate holds every fact about a project.** Its reduce,
   `reduceProject` in `packages/domain/src/project.ts`, pure, gives one
   `Project`: where its code lives (owner, base), its standing (paused,
   refused), its **recipe** — the current `configHash` and the canonical recipe
   it names — and its **observed sandbox state** (§5). A fact about a project
   that is not reduced from `prj-{project}` is a fact the log does not hold,
   and this ADR names the one that remains (§7).

3. **The recipe is part of the Project, not an aggregate.** It is a value,
   identified by its hash, that the Project holds and replaces. A change is one
   event on `prj-{project}`:
   `ProjectRecipeChanged { sourceHash, source, by }`, where `source` is the
   recipe **as a person declared it** — the file's text in its canonical form —
   `sourceHash` its hash, and `by` who changed it: a person through the board
   or the CLI, or `file` when the module found the file changed outside it
   (§6). Appended on the transition only (0126 §3): a `sourceHash` equal to the
   Project's current one appends nothing. **The declared recipe is not the
   resolved one.** Resolving adds what this host and this moment supply — a
   runtime detected as signed in where the file names none
   (`packages/recipe/src/local.ts:190`, `:383`), the preset merged underneath
   (`packages/recipe/src/resolve.ts:268-273`) — and its `configHash` changes
   when they do, with the file untouched. So the Project holds the declared
   source, which changes only when someone changes it, and each run keeps the
   resolved `configHash` it ran under on its own `StepsResolved`. Like the file,
   the source holds environment names and never values (0104 §10), so the log
   is given no secret by it. `ProjectConfigured` remains the registration
   (owner, base); its `configHash` is a resolved hash and is not read as the
   Project's recipe — a project registered before this decision gets its first
   `ProjectRecipeChanged` from the file on the first read (§6).

4. **`rcp-{hash}` is not written again.** A recipe's content travels on the
   Project's own event. `RecipeRecorded` is retired: still parsed, so the log
   written before this decision reads, and never appended. What a run used
   stays on the attempt: `StepsResolved` carries the `configHash` and, from
   this decision, the resolved recipe itself, so a run's own record answers *what did this run use*
   without any other stream; only a run older than this decision falls back to
   `rcp-{hash}`. The test that holds *"nothing decides from it"*
   (`packages/conductor/unit/recorded-recipe.test.ts:12-13`) is rewritten to
   this decision: the Project's declared source is what an attempt resolves
   from.

5. **What a project's runs actually met is a Project fact too.** A run's
   `SandboxBoundaryRecorded` stays on its attempt. When it differs from the
   Project's observed state — sandboxed, degraded because the host cannot run
   it, off by choice — `ProjectSandboxObserved { kind, runId }` is appended on
   `prj-{project}`, on the transition only. So a project's sandbox state is
   two fields of one reduce: what its recipe asks (`configured`, from the
   recipe) and what its runs met (`observed`), never a search across attempts.
   The base check's boundary (`BaseChecked.boundary`, on the integration lane,
   [0108](0108-a-refusal-buys-a-round.md) §13) is a run of the project's too,
   and is observed the same way.

6. **The recipe file is a projection the project module keeps.**
   `~/.lingtai/<project>/recipe.yml` is written by the module after the event
   that changed the recipe is appended — the event first, then the file. On
   every read the module compares the hash of the file's canonical text with
   the Project's `sourceHash` — never a resolved hash, which moves with the
   host:
   - **equal** — nothing to do;
   - **the file differs and the Project has a recipe** — the file was edited
     outside the module: append `ProjectRecipeChanged { by: 'file' }` with the
     file's content, then answer with it. A hand edit is a change like any
     other, and the log says when it was seen;
   - **the Project has no recipe yet** (a project from before this decision)
     — append the first `ProjectRecipeChanged` from the file, `by: 'file'`;
     no person does anything;
   - **the file is missing or unreadable while the Project has a recipe** —
     the module writes the file from the Project; a missing projection is
     rebuilt, never read as *no recipe*;
   - **the file does not resolve** (invalid YAML, a refused field) — nothing
     is appended, and the read fails with the resolver's refusal, as a recipe
     that will not resolve fails today.
   Two readers that notice the same edit at once both append at the version
   they read; the second meets a concurrency error, re-reads, finds the hash
   already recorded, and appends nothing.

7. **One module is the way in: `@lingtai/project`, and it owns the whole
   stream.** It exports `loadProject(project)` — the Project, its recipe
   resolved — and the project's commands as Effects: `changeRecipe`, `pause`,
   `resume`, and the conductor's `refuse`/`recover` transitions. Every append
   to `prj-{project}` and every read of it goes through the module — today
   they come from three packages and are reduced inline in seven places
   (`doc/design/aggregate-audit.md` F6), and the board reaches pause and resume
   by importing the daemon (F12). Nothing else reads `recipe.yml` or writes a
   recipe: the conductor at an attempt's start, the
   board's pages and its recipe editor, `lingtai add`, the setup module
   ([0125](0125-setup-is-one-module-two-inputs.md)), and `lingtai doctor` all
   go through it. Inside the module, whether a field is answered from the file
   or from replaying the stream is the module's choice, and may change without
   any caller changing. A unit test refuses any read of `recipe.yml` or any
   write of a recipe outside `@lingtai/project`, the way the Effect ratchet
   refuses an `async`.

8. **The Project domain is two packages, one per layer.** `@lingtai/recipe`
   is what a recipe *is* — its schema, parsing, validation, the canonical form,
   the hash, the plugins and where each may stand — pure, in the plain-logic
   layer ([0101](0101-typescript-packages-effect-unbuilt.md) §4), so `actions`
   and anything else that needs a recipe's shape keeps depending on it without
   reaching the store. It reads no file and appends nothing: the file and
   store IO it holds today (`packages/recipe/src/local.ts`'s `recipePath` and
   reads, `packages/recipe/src/write.ts`'s writes, `files.ts`'s disk port, and
   the host read `sandbox.ts` makes through `@lingtai/sandbox/host`)
   moves to `@lingtai/project`, in the touches-the-world layer, which uses
   `@lingtai/recipe` to parse and hash. One domain, split where the layering
   needs it; the boundary is this ADR and §7's test, not the package name.

   The one fact still outside the log after this is the machine's own
   `~/.lingtai/config.yml`, which is not a project's (0104 §7).

## Consequences

- *Who changed this project's configuration, and when* is answered by the log,
  hand edits included, from the read that first saw them.
- A project's state on the board is one reduce of one stream; #1163's search
  across attempts and its ordering bugs have nothing left to be about.
- Every reader of a recipe changes once, to `loadProject`. The comment in
  `packages/domain/src/project.ts` that keeps the recipe out of the aggregate
  is replaced by this decision.
- A recipe's content is stored once per project that uses it, not once for all;
  a recipe is a few kilobytes and changes rarely.

## Not built yet

All of it: `@lingtai/project`, `ProjectRecipeChanged`, `ProjectSandboxObserved`,
the file reconciliation of §6, the reader test of §7, `RecipeRecorded`'s
retirement, and every caller moving to `loadProject`.

## Not decided here

- Whether the machine's `config.yml` becomes events of an installation
  aggregate.
- Showing a project's recipe history on the board.

---
*New topic; replaces no archived ADR. Reverses the reason archived 0005 gave
for keeping the recipe out of the Project aggregate.*
