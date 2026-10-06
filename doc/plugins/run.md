# `run:`

| | |
|---|---|
| **Does** | Runs one command in the worktree and takes its exit code as the verdict — zero passes, anything else refuses. |
| **Write it at** | `prepared`, `build`, `implement`, `proposed`, `merge` — a red one buys a fix round only at `build`. |
| **Needs** | `run`: the command. `timeout` defaults to `15m`; `env` defaults to `[]`, which is nothing. |
| **Refuses** | Any other step, any field it does not declare, a `LINGTAI_*` name in `env`, a `run:` after the lane at `merge`. |
| **Watch out** | The step decides what a red command costs: at `build` the agent gets a fix round, at `implement` the command's own exit code never refuses — it commits what it changed and leaves a refusal to `build`'s own copy of the check — and at the other three a person is asked and **no round is bought**. `implement` still stops for a person if the wrapper's own restore cannot run (a stale lock, say) — that is the tree, not the command, failing. A `timeout` typo is not refused at resolve. |

`run:` is **the extension point that needs nothing declared**: every check
Lingtai does not make itself is one of these. It stops a change that satisfies the
ticket and breaks the build from landing because nothing ever compiled it.

## What it does

`createProcessAction` in `packages/actions/src/process-action.ts` runs the command
through a shell in the pass's worktree, with only the environment the action
declared plus `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`, `LOGNAME`. Evidence is the
exit code, duration and log,
the last 60 lines within 8 000 bytes. A timeout is `failed`. **It reports
and finds nothing** (`findings: []`). `pnpm test` runs the unit half only.

**`env` is names, never values; absent means nothing, not everything.** Names
resolve from the recipe's environment files, before `env.allow`/`env.deny` (the
*agent's*).

## Where it may be declared

`runPlugin.at` is `{ prepared, build, implement, proposed, merge }` (not `"*"`:
`end` runs no pipeline). At `merge` a check goes **before** the lane. **What a
red `run:` costs** — only `build` buys a round:

| a red `run:` at | what the pass does |
|---|---|
| `prepared` | `blocked`: no agent has run, so `implement` is not on offer. **No round bought.** |
| `build` | Back to the agent with the error. **A fix round.** |
| `implement` | The command's own exit code never refuses: a command written after the agent (`implement: [agent, run]`) runs after every agent run and commits what it changed onto the attempt's branch — `createKeptRunAction` in `@lingtai/actions`. `implement` may not refuse (`REFUSING_STEPS`), so a non-zero exit puts the tree back to what the agent's commit left (excluding whatever the agent left dirty, which stays as it was) and the step still passes, with the failure first in the evidence. **No round bought** — `build`'s own copy of the command is what catches it. The one case this does stop for a person is the restore itself failing — a stale `.git/index.lock`, say — which is `did-not-finish` rather than a quiet pass, because then nobody can say what tree `build` would be judging. |
| `proposed` | `blocked`: the router has nowhere above it to appeal to. **No round bought.** |
| `merge` | `action-refused` is no direction a `judge:` answers: held for a person. **No round bought.** |

A check the diff can satisfy belongs at `build`; a mechanical fix-up after the agent belongs at `implement`; the other five steps are refused.

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
  - name: install
    run: pnpm install --frozen-lockfile
    timeout: 10m
```

```yaml
# ~/.lingtai/lingtai/recipe.yml — the build; the `pnpm-workspace` preset puts the same at `proposed`, where a red one costs a person
build:
  - name: build
    run: pnpm typecheck && pnpm test
    timeout: 20m
```

```yaml
# packages/conductor/unit/pass.test.ts — a check that gates the merge goes above the lane
merge:
  - name: verify
    run: pnpm typecheck
  - name: land it
    merge:
      strategy: merge-commit
```

## What it refuses

All when the recipe resolves, before a worktree or any money.

```yaml
# 1. a step it does not serve
review:
  - name: build
    run: pnpm test
---
# 2. a field it does not declare
build:
  - name: build
    run: pnpm test
    model: opus
---
# 3. one of Lingtai's own names
build:
  - name: build
    run: pnpm test
    env: [LINGTAI_DATABASE_URL]
```

1. > the "build" action is a "run" at the "review" step, and `run:` does not
   > implement `review` — it serves `prepared`, `build`, `implement`, `proposed`, `merge`: … A command that decides whether the diff stands is a `run:` at `build`.
2. > … "run" declares no "model" field — what it declares is "name", "run",
   > "timeout", "env". A plugin refuses a field it does not understand.
3. > … "LINGTAI_DATABASE_URL" is one of Lingtai's own names and cannot be declared
   > for an extension — every name Lingtai reads for itself begins "LINGTAI_".

A `run:` after the lane at `merge` is refused: *… Write it before the lane.*

## Related

- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [`watch.md`](watch.md) — a hold on a glob over the diff at `proposed`, where a `run:` cannot.
- [`human.md`](human.md) — asking a person at `proposed`.
- [`reference.md`](../reference.md) — `env` and the recipe's environment files.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, not declaring one.
