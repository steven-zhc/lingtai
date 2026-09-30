# `run:`

| | |
|---|---|
| **Does** | Runs one command in the worktree and takes its exit code as the verdict — zero passes, anything else refuses. |
| **Write it at** | `prepared`, `build`, `proposed`, `merge` — a red one buys a fix round only at `build`. |
| **Needs** | `run`: the command. `timeout` defaults to `15m`; `env` defaults to `[]`, which is nothing. |
| **Refuses** | Any other step, any field it does not declare, a `LINGTAI_*` name in `env`, a `run:` after the lane at `merge`. |
| **Watch out** | The step decides what a red command costs: at `build` the agent gets a fix round, at the other three a person is asked and **no round is bought**. A `timeout` typo is not refused at resolve. |

`run:` is **the extension point that needs nothing declared**: every check
Lingtai does not make itself is one of these. It stops a change that satisfies the
ticket and breaks the build from landing because nothing ever compiled it.

## What it does

`createProcessAction` in `packages/actions/src/process-action.ts` runs the command
through a shell in the pass's worktree, with only the environment the action
declared plus `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`, `LOGNAME`. Evidence is the
exit code, duration and log ([0043](../decisions/0043-evidence-is-plain-text.md)),
the last 60 lines within 8 000 bytes (`#171`). A timeout is `failed`. **It reports
and finds nothing** (`findings: []`). `pnpm test` is the unit half only
([0060](../decisions/0060-the-gate-runs-unit-tests.md)).

**`env` is names, never values; absent means nothing, not everything**
([0037](../decisions/0037-an-extension-is-a-command.md) §1). Names resolve from
[0021](../decisions/0021-the-recipe-decides-the-environment.md)'s files, before
`env.allow`/`env.deny` (the *agent's*).

## Where it may be declared

`runPlugin.at` is `{ prepared, build, proposed, merge }` (not `"*"`: `end` runs no
pipeline). At `merge` a check goes **before** the lane (`#270`). **What a red
`run:` costs** — only `build` buys a round:

| a red `run:` at | what the pass does |
|---|---|
| `prepared` | `blocked`: no agent has run, so `implement` is not on offer. **No round bought.** |
| `build` | Back to the agent with the error. **A fix round** (`#256`). |
| `proposed` | `blocked`: the router has nowhere above it to appeal to. **No round bought.** |
| `merge` | `action-refused` is no direction a `judge:` answers: held for a person. **No round bought.** |

A check the diff can satisfy belongs at `build`; the other six steps are refused.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. |
| `run` | string | yes | The command. Its exit code is the only channel. |
| `timeout` | duration string | no, `15m` | `30s`, `15m`, `2h`. **The shape is not checked at resolve**: `parseDuration` throws `"soon" is not a duration like 30s, 15m or 2h` inside the pass; `lingtai doctor` catches it. |
| `env` | list of strings | no, `[]` | The **names** of variables the process is given. `LINGTAI_*` names are refused. |

## Examples

```yaml
# ~/.lingtai/lingtai/recipe.yml — the install: `git worktree add` copies no node_modules
prepared:
  - { name: install, run: pnpm install --frozen-lockfile, timeout: 10m }
```

```yaml
# ~/.lingtai/lingtai/recipe.yml — the build; the `pnpm-workspace` preset puts the same at `proposed`, where a red one costs a person
build:
  - { name: build, run: pnpm typecheck && pnpm test, timeout: 20m }
```

```yaml
# packages/conductor/unit/pass.test.ts — a check that gates the merge goes above the lane
merge:
  - { name: verify, run: pnpm typecheck }
  - { name: land it, merge: { strategy: merge-commit } }
```

## What it refuses

All when the recipe resolves, before a worktree or any money.

```yaml
review:                      # 1. a step it does not serve
  - { name: build, run: pnpm test, env: [] }
---
build:                       # 2. a field it does not declare
  - { name: build, run: pnpm test, model: opus, env: [] }
---
build:                       # 3. one of Lingtai's own names
  - { name: build, run: pnpm test, env: [LINGTAI_DATABASE_URL] }
```

1. > the "build" action is a "run" at the "review" step, and `run:` does not
   > implement `review` — it serves `prepared`, `build`, `proposed`, `merge`:
   > `review` returns findings and judges nothing (0058 §3b) — … A command that
   > decides whether the diff stands is a `run:` at `build`; a glob over it or a
   > hold on it is `proposed`'s.
2. > … "run" declares no "model" field — what it declares is "name", "run",
   > "timeout", "env". A plugin refuses a field it does not understand (0061 §9).
3. > … "LINGTAI_DATABASE_URL" is one of Lingtai's own names and cannot be declared
   > for an extension — every name Lingtai reads for itself begins "LINGTAI_" (#63).

A `run:` after the lane at `merge` is refused: *… Write it before the lane.*
## Related

- [0037](../decisions/0037-an-extension-is-a-command.md) §1 — an extension's
  code is not trusted, so this is the one key with an `env:`. **§2's *there is no plugin system* is superseded by
  [0067](../decisions/0067-a-plugin-is-a-declaration-and-an-implementation.md)**:
  a plugin is a declaration, and `PLUGINS` is where every one of them lives.
- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §2, §3b — a
  refusal goes to `proposed`.
- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §9 — a plugin refuses a
  field it does not understand; [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md)
  §4 — legality is `runPlugin.at`.
- [0065](../decisions/0065-the-default-is-a-plugin.md) §8 — the lane is last at
  `merge:` (`#270`). `#256` — `build:` opened (`a417908`) to buy the round.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, not declaring one.
