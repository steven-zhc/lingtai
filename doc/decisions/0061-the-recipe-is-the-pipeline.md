# 0061 — The recipe is the pipeline, and every step is a list of plugins

**Status** accepted · 2026-09-22 · **implements
[0058](0058-lingtai-is-a-development-pipeline.md) §2b and §4 as a file shape** ·
**replaces `gates:` with `steps:` and does not migrate** · generalises
[0059](0059-a-point-carries-only-the-kinds-it-runs.md) from five points to ten
steps

The recipe is the one file a person reads to learn what this system will do to
their repository. Today it takes four sections to describe one pass and hides
the two numbers that decide how much a refusal costs. **After this, the file is
the pipeline: ten step names in order, each a list of plugins, read top to
bottom.**

## Context

### One pass, four places

```yaml
repo:    { base: main }                 # what `admit` does
source:  { kinds, exclude, backoff }    # what `claim` does
gates:   { admit, prepared, proposed, merge, end }   # five of the ten steps
runtime: { agent, limits, budget }      # turns/wall belong to `implement`
                                        # rounds/restarts belong to `proposed`
```

Nothing in the file says that `repo.base` is the branch `admit` cuts a worktree
from, or that `source.kinds` is how `claim` picks. A reader assembles the pass
from four sections and the order is nowhere.

### The two numbers that cost money are not in the file's vocabulary

`runtime.limits.rounds: 3` reads as a global setting. It is not: it is the
ceiling **`proposed` counts** when it decides whether a refusal buys another
agent. That decision lives in `buyRound` at `run-once.ts:1761`, and
[0058](0058-lingtai-is-a-development-pipeline.md) §3 says of it: *visible to
nobody*. A number that buys ~31 turns and ~$3.40
([012 §3](../experiments/012-where-the-turns-go.md)) should be readable beside
the step that spends it.

### The six action kinds are already the right shape

```yaml
- name: install          # universal key
  run: pnpm install      # the plugin is the key; its value is the configuration
  timeout: 10m           # universal key
```

`run:`, `agent:`, `watch:`, `human:`, `close:`, `labels:` — this is Ansible's
module-as-key, and it already works. What is missing is that only five of the
ten steps may carry it.

## Decision

### 1. `steps:`, ten names, in order

```yaml
claim · admit · prepared · design · implement · build · review · proposed · merge · end
```

The order in the file is the order of the pass. `gates:` is gone — not renamed,
replaced: it named five of ten and the five it named were not a category
([0058](0058-lingtai-is-a-development-pipeline.md) §2).

### 2. Every step is a list of plugins, and the plugin is the key

**Ansible's shape, not Kubernetes's or GitHub Actions'.** Those spend a level
of nesting — `uses:` plus `with:` — to buy a namespace, and a namespace is for
third-party modules that must not collide.

**This system has no third-party plugins to namespace.**
[0037](0037-an-extension-is-a-command.md) §2 settled that: *there is no plugin
system, an extension is a command*. The extension point is `run:`, and
everything else is built in. A closed set needs no namespace, so it does not
pay for one.

A plugin's value is a scalar where one reads well and a map where it does not:

```yaml
- run: pnpm install --frozen-lockfile        # scalar
- worktree: { base: main, submodules: false } # map
```

`name`, `when`, `timeout` and `env` stay universal keys, as they are today.

### 3. The plugins

| step | plugin | carries |
|---|---|---|
| `claim` | `queue:` | `kinds` · `exclude` · `backoff` |
| | `assignee:` | who |
| `admit` | `worktree:` | `base` · `submodules` |
| `prepared` | `run:` | the command |
| `design` | `agent:` | the prompt |
| `implement` | `agent:` | runtime · model · `turns` · `wall` |
| `build` | `run:` | the command |
| `review` | `agent:` | the prompt · `findings` · `diff` |
| `proposed` | `route:` | **`rounds` · `restarts`** |
| `merge` | `merge:` | strategy |
| | `agent:` | the conflict prompt |
| `end` | `close:` `labels:` | `when` |

Ten plugins. Two things fall out rather than being added:

**`agent:` appears at four steps** — `design`, `implement`, `review`, `merge` —
one plugin with four configurations. That is
[0053](0053-the-recipe-chooses-the-agent-for-each-role.md), *the recipe chooses
the agent for each role*, as a consequence of the shape rather than as a rule
beside it.

**`route:` makes the ceilings sayable.** `rounds` and `restarts` become the
configuration of the plugin at the step that counts them, which is
[0058](0058-lingtai-is-a-development-pipeline.md) §Consequences' *the ceilings
come out of `run-once.ts` into a plugin a person can read*, literally.

### 4. A setting moves to the step that owns it

```
runtime.limits.rounds / restarts   →  proposed:   route:
runtime.limits.turns / wall        →  implement:  agent:
repo.base / submodules             →  admit:      worktree:
source.kinds / exclude / backoff   →  claim:      queue:
```

**This is the readability claim, and it is checkable.** Every one of those is a
setting whose owning step is knowable today and unwritten today. A setting that
cannot be placed under a step is a setting whose owner nobody has established,
and it stays top-level until someone does.

Top-level after the move: `version`, `env`, `steps`, `subscribers`.

### 5. The file may omit a step; the resolved recipe may not

A step with no plugins need not be written. The **resolved** recipe has all ten,
each at least `[]`, and the board and `lingtai doctor` draw all ten.

That is this repository's oldest rule applied to a file: *an unconfigured gate
is shown as skipped, never omitted, because absent and silently-not-run must be
distinguishable*. The distinction belongs in what a reader is **shown**; making
them type `design: []` buys nothing. The mechanism already exists —
`recipe.ts:583` defaults the five gates exactly this way.

### 6. `subscribers:` stays outside `steps:`

A subscriber is not a step. 0015's one real division is that it **runs off the
log and cannot change an outcome**, and that is the only division this ADR does
not flatten. Filing subscribers under a step would erase it.

### 7. No migration, and no version 1

`version: 2`, and a version 1 file is refused by name. There is one recipe in
existence and its owner rewrites it.

**But the log is not the file, and the log is append-only.** `GatesResolved`
records what a run was given
([0047](0047-the-recipe-a-run-got-is-on-the-log.md)); events already written
carry the five-point shape and must stay readable, so the upcast that
[0058](0058-lingtai-is-a-development-pipeline.md) §5 calls for is still owed.
*No compatibility* is a statement about the file a person edits, never about
the log.

### 8. 0059 becomes a matrix and stays one rule

[0059](0059-a-point-carries-only-the-kinds-it-runs.md) is now ten steps against
ten plugins, with the rule unchanged: **a step refuses a plugin it cannot run**,
at resolve time, by name. `worktree:` written under `end:` is refused before
anything runs.

The ten silent cells `#61` measured cannot exist in this shape: a cell is
either a plugin a step runs, or a name the resolve refuses.

## Consequences

**The file becomes the explanation.** *What will this do to my repository* is
answered by reading one file downward, which is the only form of documentation
that cannot go stale.

**`lingtai add` prints a pipeline rather than a summary.** Its job today is to
tell you what `merge:` says before you start a run; after this it can print the
ten lines, which is the same answer without the reader having to know which key
mattered.

**One recipe is rewritten by hand, and that is the whole migration cost.** It is
also the test: if the v2 file is not plainly easier to read than the v1 it
replaces, this ADR was wrong and the file will say so.

**A plugin's configuration has to be hashed into `configHash`**, the way a
gate's is, or 0047's *what a run was given is on the log* loses everything that
moved out of `runtime:`. This is the open item 0058 §What-is-not-decided named,
and it is now concrete: `route:`'s `rounds` is exactly as load-bearing as an
action's command.

## What is not decided

- **Whether plugins that must agree can be expressed in this file**, which is
  [0058](0058-lingtai-is-a-development-pipeline.md)'s largest open question and
  is unchanged by the shape: `admit`'s `worktree:` and `merge`'s `merge:` must
  agree about one repository and base. The shape helps — both have names in the
  file now — and does not answer it.
- **Whether `queue:` and `assignee:` at `claim` compose or exclude each other.**
- **What a plugin's own schema is**, and whether a `run:` action's `env:` list
  ([0037](0037-an-extension-is-a-command.md) §1) generalises to every plugin or
  stays the property of the ones that spawn a process.

## Related

- [0058](0058-lingtai-is-a-development-pipeline.md) — the ten steps, and that
  everything which acts is a plugin. This is its file shape.
- [0037](0037-an-extension-is-a-command.md) §2 — *there is no plugin system, an
  extension is a command*. The reason §2 needs no namespace.
- [0046](0046-lingtai-is-personal.md) §3 — the recipe is the machine's, at
  `~/.lingtai/<project>/recipe.yml`. Nothing here moves it.
- [0047](0047-the-recipe-a-run-got-is-on-the-log.md) — what a run was given is
  on the log. §7 is the half of it this ADR does not get to skip.
