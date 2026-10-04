# 0104 — The recipe: one file per project on this machine, ten steps in order, each setting on the step that uses it

**Status** accepted · 2026-10-01

A project's recipe is `~/.lingtai/<project>/recipe.yml`, on the operator's
machine and never in the managed repository. It is `version: 2`, and its heart
is `steps:` — the ten step names in pass order, each a list of plugins written
Ansible-style with the plugin name as the key. A setting is written once, on the
step that uses it, and every field is validated when the recipe resolves, before
anything is claimed; the one templated field is judged again when it expands.
The canonical recipe a run was given is appended to the log beside its hash, as
a record nothing reads back. `~/.lingtai/config.yml` is the machine's file: which
store holds the log and where the board listens, plus the default runtime and
assignee rule that have not yet moved into the recipe, and a `runtime.limits`
that may narrow — never raise — the ceiling the recipe itself now states
([#371](https://github.com/steven-zhc/lingtai/issues/371)).

## Context

The recipe is the one file a person reads to learn what Lingtai will do to their
repository, so it has to read as the pipeline itself, top to bottom. Lingtai is
personal (each person runs their own, against their own log), so the recipe is
that person's pre-flight before they push. It is not the team's contract. What
must hold for everyone is branch protection on GitHub. An agent works inside a
worktree and must not be able to edit the rules that judge it. Numbers that
decide behaviour, such as how long a failed ticket waits or how much evidence a
prompt quotes, belong where a reader can see and change them, not in constants
in the source.

## Decision

1. **The recipe lives on the machine, at `~/.lingtai/<project>/recipe.yml`.**
   `recipePath()` in `packages/recipe/src/local.ts` names it (under `stateDir()`,
   so `LINGTAI_HOME` moves it). Nothing is read from or written to the managed
   repository for it, so a `.lingtai/config.yaml` committed there is an ordinary
   file that changes nothing. Onboarding a repository commits nothing to it. The
   file is outside every worktree, so no agent can reach it. The file is read on
   every resolve, so an edit reaches the next pass without a restart.

2. **The file shape is `version: 2` and `steps:`.** The top-level keys are
   `version`, `extends`, `repo`, `source`, `env`, `steps`, `discuss`,
   `subscribers` and `runtime`. Any other key is refused by name, and so is any
   `version` other than 2. `extends:` names a preset (`presets.ts`) that fills
   whatever the file omits. The ten steps are
   `claim · admit · prepared · design · implement · build · review · proposed · merge · end`,
   and the order in the file is the order of the pass.

3. **A step is a plain list of plugins, and the plugin is the key.** Each entry
   has exactly one plugin key (`run:`, `agent:`, `worktree:`, `queue:`,
   `judge:`, …) whose value is its configuration, plus a `name` that verdicts,
   waivers and the board address it by. The closed set is `PLUGINS` in
   `packages/recipe/src/recipe.ts`. A step's plugins run in the order written,
   and what the step does with their results belongs to the step. Which plugins
   exist and which steps each one serves is a separate decision ([0105](0105-a-plugin-is-a-declaration-and-an-implementation.md)).

4. **A step may be omitted from the file; the resolved recipe has all ten.** An
   absent step resolves to `[]`, and the board, `lingtai doctor` and
   `lingtai add` draw all ten. An empty step is shown as skipped, never left
   out.

5. **Each setting has one home, on the step it bounds or uses.** Values flow from
   that home to whatever else needs them; they are never declared twice.
   - `admit`'s `worktree:` carries `base` and `submodules`. The merge lane is
     handed the same `base` and has no key of its own.
   - `claim`'s `queue:` carries `kinds` (priority order), `exclude`, `backoff`
     and `assignee` (`{ login?, take: mine | unassigned | both }`, where `mine`
     requires a `login`).
   - `agent:` carries the runtime as an enum (`RuntimeId`), with `model:`,
     `prompt:` and an optional `limits: { turns, wall }` beside it.
   - `review`'s agent reads its diff bound from `runtime.budget.diff`.

   `repo.{base, submodules}` and `source.{kinds, exclude, backoff}` are still
   accepted as a second spelling of the same settings. The accessors in
   `packages/recipe/src/settings.ts` (`baseOf`, `submodulesOf`, `kindsOf`,
   `excludeOf`, `backoffOf`, `assigneeOf`, `queueOf`, `limitsFor`, `ceilingOf`)
   read the step first and the old key second. They are the only code that
   knows which spelling a file used, and every reader goes through them.

6. **`runtime.limits` is the ceiling, stated once in the recipe; a dispatch
   may only narrow it, and so may the machine file.** `turns` (default 300)
   and `wall` (default `2h`) bound one agent run.
   `rounds` (default 2) bounds how many times a pass sends the work back, and
   `restarts` (default 0) bounds how many times a ticket starts over. `usd`
   (`#370`) bounds one agent run in dollars and has **no default** — absent
   means no dollar ceiling, reported as such rather than assumed unbounded or
   silently zero. A dispatch's own `limits:` may lower `turns` and `wall`; it
   may not carry `usd` at all either, because the dispatch schema has no key
   for it — unlike `rounds` and `restarts`, which are refused by name with a
   stated reason, `usd` there is refused only as an unrecognized key. A higher
   `turns` or `wall` is refused at resolve, and so is `rounds` or `restarts`
   inside a dispatch. `discuss:` carries its own
   `agent`, `model`, `prompt` and `limits` (defaults 40 turns, `5m`), because a
   discussion spends money outside any pass, and that `limits` carries no `usd`
   either.

7. **The machine file, `~/.lingtai/config.yml`, holds the machine's facts.**
   `database.store` and `database.url` (which log; see [0100](0100-one-append-only-log.md)) and `board.port`
   are read by `packages/env`. `packages/recipe/src/local.ts` reads
   `runtime.agent` and `runtime.assignee`, either machine-wide or under
   `projects.<name>.runtime`, and merges them into the resolved recipe. A
   recipe that writes either of those two keys under `runtime:` is refused,
   naming the machine file. A machine file that writes `steps:` is refused,
   naming the recipe. When no file names a runtime, the only runtime signed in
   is used. If several are signed in, or none, Lingtai refuses rather than
   picking one (`resolveAgent`). Whether a runtime is installed and signed in
   is checked, never written down. Every `agent:` the recipe names must be
   signed in on this machine, or the pass is refused before the claim
   (`agentRefusal`).

   **`runtime.limits` is the one key both files may carry, and the recipe
   states the ceiling** (`#371`). The machine file's `runtime.limits`, same
   place as `agent` and `assignee`, may narrow any of the five numbers — never
   raise one: a machine value larger than the recipe's is refused by name,
   naming both files and both numbers, rather than silently ignored or
   silently applied. Resolved per key, not per block, so a recipe that narrows
   `rounds` and a machine that narrows `wall` both take effect at once. A key
   neither file writes gets the schema's own default. Equal is not narrowing —
   the recipe's value applies either way, which is what makes copying the
   numbers across and leaving the machine file in place, mid-migration, safe.

8. **The backoff is `queue:`'s `backoff`: a positive duration, `1h` by default,
   and flat.** After a failed attempt, the ticket stays out of the queue until
   `lastAttemptAt + backoff` (`heldUntil` in `packages/conductor/src/queue.ts`).
   The wait does not grow with attempts. `0` is refused (`must be a positive
   duration, like 1h`). The backoff stops blind retries and nothing else: an item
   with a repair pending skips it, and so does `lingtai now`, which selects with
   `backoffMs: 0` because the person typing it is the new information. A held
   ticket says when it is free: `lingtai status` prints
   `[backing off — runnable in 32m]`, and the board's queued card carries a
   `runnable in` pill. Both read `heldUntil`.

9. **The prompt budget is `runtime.budget`.** `evidence` (2000 characters of
   the last failure quoted into the next prompt), `attempts` (5 rows in the
   attempt table), `findings` (5 review findings carried forward) and `diff`
   (400000 bytes of diff a review agent sees). The values are passed into
   `attemptBrief` and the review prompt as arguments and never defaulted at the
   point of use. Two numbers stay constants on purpose, because they bound what
   is written to the permanent log rather than what a prompt is given:
   `EVIDENCE_LINES` (60) and `EVIDENCE_BYTES` (8000) in
   `packages/actions/src/command.ts`. `DEFAULT_RETENTION_DAYS` (2) in
   `packages/projector/src/task-view.ts` is a board-wide setting, not a
   per-project one. Every such number is listed in `../reference.md`'s policy
   section.

10. **The recipe declares environment names, never values.** `env:` holds
    `required`, `allow`, `deny`, `refuseHosts` and `plantAt`, and a `run:`
    plugin's own `env:` lists the names that one command gets. How those names
    become an agent's environment is
    [0107](0107-the-agent-gets-what-the-recipe-allows.md).

11. **Every field is validated at resolve, before any claim, and every problem
    is reported in one answer.** Each plugin owns its schema: types, defaults,
    enums, cross-field rules, and `noLog` for a value that must never leave the
    plugin. A step refuses a plugin it does not serve, and a plugin refuses a
    field it does not understand. A refusal names the step, the plugin and the
    field. `lingtai add`, `lingtai doctor` and the daemon all resolve, so a bad
    recipe turns red before it costs money.

12. **A templated field is judged twice: once on the string as written, and once
    on its expansion where that exists.** The one templated field is `file:`'s
    path, which takes `{{issue}}` (`THE_PLACEHOLDER` in `recipe.ts`). At resolve,
    `whyThePathEscapes` refuses `..`, a leading `/` or `~`, an empty segment, and
    any other `{{…}}`. When the action runs, `thePathForThisTicket` substitutes
    the placeholder first and then asks the same function about the result.
    `packages/actions/src/file-action.ts` answers `did-not-finish` and writes
    nothing if that check fails. Expansion is never done at resolve, because it
    would make `configHash` differ per ticket. A check written on the template
    is not a check on the expansion. Adding a second templated field means
    building both judgements for it.

13. **The recipe a run got is on the log, and nothing resolves from it.**
    `configHash` is `sha256` of the canonical resolved recipe (`hashRecipe` in
    `packages/recipe/src/resolve.ts`): parsed, `undefined` dropped, keys sorted,
    `noLog` values replaced by a digest. The empty-step entries for `claim`,
    `design`, `implement`, `build` and `review` are left out while they are empty,
    so an unchanged file keeps its hash. `StepsResolved` (`schemaVer` 4) carries
    `configHash`, all ten steps with their action names, and `recipe`, the
    canonical body the hash was taken over, so a reader can check one against the
    other. It is a record. No code in `conductor`, `recipe` or `actions` reads it
    back to decide anything (`conductor/unit/recorded-recipe.test.ts`). An event
    that predates the field has no `recipe`, and readers say *not recorded*.

## Consequences

- Nothing in a managed repository shows that Lingtai is used on it. Two people
  on one repository will have recipes that drift, and branch protection is what
  holds the shared bar.
- The recorded body drops YAML comments, so a past run's recipe shows what ran
  but not the reasoning behind it. That is accepted: recording the source text
  as well would put two representations on one event that could disagree.
- The log is permanent, so the recipe schema must never carry a secret value;
  `noLog` and the names-only `env:` are what guarantee that.
- A refused recipe stops every pass for the project (`stage: "recipe"`).
- A failed ticket costs at most about one agent run per backoff window, with no
  limit on how many windows it runs. A cap on the number of attempts is a
  separate ceiling and is not decided here.
- The second judgement of a templated field costs one claim, one clone and the
  run up to that action when it refuses. That is the cost to weigh before
  templating another field.

## Not built yet

- **Moving the default runtime and the assignee rule out of
  `~/.lingtai/config.yml` and into the recipe is accepted and not done.** The
  run ceiling moved already (`#371`): the recipe's `runtime.limits` is the
  ceiling, and the machine file only narrows it. What is left is
  `runtime.agent` and `runtime.assignee` — the intended end state is that
  `config.yml` holds only the machine's own facts (store, board port), with
  `agent:` written per step in the recipe and `queue:`'s `assignee` carrying
  the rule, the machine file refusing both keys by name, and `local.ts`
  stopping the merge. Today the reverse still holds for these two: the machine
  file supplies them, and the recipe refuses them under `runtime:`.
  `queue:`'s `assignee` and a per-step `agent:` are already accepted in the
  recipe, beside the machine-wide ones that still win when a step says
  nothing.

---
*Replaces archived 0005, 0028, 0029, 0045, 0046, 0047, 0061, 0063, 0071 in [decisions-archive](../decisions-archive/).*
