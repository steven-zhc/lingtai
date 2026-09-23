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

**A universal key is the workflow's bound on a plugin; the plugin's own key is
its configuration.** `name`, `when`, `timeout` and `env` are universal today and
`rounds`/`restarts` join them (§3). The distinction is not cosmetic and
`timeout:` already shows why: a `run:` plugin cannot ignore its timeout, because
the runner enforces it rather than the plugin honouring it. Every universal key
works that way — **the plugin is told, it does not decide.**

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
| `proposed` | `judge:` | how the decision is made; **`rounds` · `restarts` are universal, not its own** |
| `merge` | `merge:` | strategy |
| | `agent:` | the conflict prompt |
| `end` | `close:` `labels:` | `when` |

Ten plugins. Two things fall out rather than being added:

**`agent:` appears at four steps** — `design`, `implement`, `review`, `merge` —
one plugin with four configurations. That is
[0053](0053-the-recipe-chooses-the-agent-for-each-role.md), *the recipe chooses
the agent for each role*, as a consequence of the shape rather than as a rule
beside it.

**The ceilings become sayable, and they do not become the plugin's.** `rounds`
and `restarts` move out of `buyRound` at `run-once.ts:1761` — where
[0058](0058-lingtai-is-a-development-pipeline.md) §3 says they are *visible to
nobody* — and onto the step, beside `timeout:`.

**Every plugin is replaceable, including `judge:`, and the loop is still
bounded.** Those two are only compatible because of the split above, and the
reason is an asymmetry worth stating plainly:

```
a misconfiguration that fails    is cheap — it errors, you fix it
a misconfiguration that loops    is not — it never errors, it only spends
```

A replaced `judge:` that could carry its own ceilings could answer *back to
`implement`* for ever, at ~31 turns and ~$3.40 a round
([012 §3](../experiments/012-where-the-turns-go.md)), and nothing anywhere
would report a fault. So:

> **`judge:` decides which step is next. The workflow decides which steps it
> may choose from.**

The workflow counts the rounds and restarts spent — it is the thing appending
the events — and hands the judge the result as a fact: the findings, the
refusal's `reason`, and **the set of steps on offer**. When `rounds` is spent,
`implement` is not in that set. A judge that returns a step it was not offered
is refused by name, which is §8's rule used once more: *a step refuses a plugin
it cannot run* becomes *a step refuses a destination it did not offer.*

**This is why no plugin has to be un-replaceable.** The bound lives in the key,
not in a privileged built-in.

### 4. A setting moves to the step that owns it

```
runtime.limits.rounds / restarts   →  proposed:   universal keys on the step
runtime.limits.turns / wall        →  implement:  agent:
repo.base / submodules             →  admit:      worktree:
source.kinds / exclude / backoff   →  claim:      queue:
```

**This is the readability claim, and it is checkable.** Every one of those is a
setting whose owning step is knowable today and unwritten today. A setting that
cannot be placed under a step is a setting whose owner nobody has established,
and it stays top-level until someone does.

Top-level after the move: `version`, `env`, `steps`, `subscribers`.

**A setting has exactly one home, and a step that needs another step's setting
receives the value rather than declaring it again.** `base` is written once,
under `admit`'s `worktree:`; the merge lane is handed it. That is already how
the code works — `worktree.ts:133` and `integrate.ts:73` both take `base` as a
parameter, and `recipe.repo.base` is the single place it is written — and it is
worth stating because the shape below makes it easy to break: giving `merge:` a
`base:` of its own would manufacture a disagreement that cannot happen today.

**This is the whole of cross-step agreement, and it is deliberately not a
dependency model.** An earlier draft of this ADR wanted plugins to declare what
they must agree with, so that a pipeline which is legal but incoherent could be
refused before it ran. Two things killed it. The one case that would have been
load-bearing — `admit` and `merge` disagreeing about a base — **is prevented by
the value flowing rather than by any check**. And the remaining case is
`prepared`'s `pnpm install` against `build`'s `pnpm typecheck`: two free-text
commands, where catching *you typed npm in one and pnpm in the other* requires
a system that understands commands. A plugin offers a capability; a person who
configures it wrongly gets an error. That is the Jenkins bargain, and it is the
right one here.

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

### 7. No migration — not for the file, and not for the log

`version: 2`, and a version 1 file is refused by name. There is one recipe in
existence and its owner rewrites it.

**And no upcaster is owed for `GatesResolved` growing to ten.** This log gets
reset instead. That is affordable here for a reason that is written down rather
than assumed: **a `seq` was never a durable citation** — the durable one is a
GitHub issue number ([1.0](../design/1.0.md)) — and this log has been reset
twice already
([007](../experiments/007-the-log-before-the-reset.md),
[010](../experiments/010-the-log-before-the-second-reset.md)), with
[0055](0055-two-implementations-chosen-at-init.md) §3 making the choice of the
other store start an empty log rather than carry this one over.

**What a reset spends is the measurements, and they are paid for in advance.**
[012](../experiments/012-where-the-turns-go.md) is a fold over this log; after
a reset none of its numbers can be recomputed. That is why 007 and 010 exist as
documents and why the practice is already the rule: **fold the log into a file
before resetting it, and the reset costs nothing that was worth keeping.**

**Two things this is not.** It is not a licence to delete
[`upcast.ts`](../../packages/domain/src/upcast.ts): the mechanism was built
before it was needed on purpose ([0001](0001-event-sourcing.md)) — *the first
upcaster is written under time pressure against real history, which is the
worst moment to also be designing the mechanism* — and a Lingtai somebody else
runs will need it for a log nobody may reset. And it is not a property of event
sourcing; it is a property of **this** repository, pre-1.0, whose log is its
own workshop floor.

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
and it is now concrete: `proposed`'s `rounds` is exactly as load-bearing as an
action's command, and it is a universal key rather than a plugin's, so the hash
has to reach both.

## What is not decided

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
  on the log. §7 does not weaken that: a reset log still records all ten steps
  from its first row.
- [0001](0001-event-sourcing.md) — why `schemaVer` is on every row from the
  first one. §7 spends this log's history and keeps that.
