# `judge:`

| | |
|---|---|
| **Does** | Answers *what now* when a step refused, in place of the person the pass would otherwise stop for. |
| **Write it at** | `proposed` — and nowhere else. |
| **Needs** | `judge` (`same-worktree` \| `claude-code` \| `codex`) and `when` (no default). `model` and `limits` default to the runtime's own. |
| **Refuses** | Any step but `proposed`, an omitted or unknown `when`, `ask-or-assume`, and `rounds:` or `restarts:` anywhere on it. |
| **Watch out** | `claude-code` buys an agent every time that direction arrives; `same-worktree` spends nothing. One line decides what a refusal costs. |

`judge:` keeps a pass from parking with money already paid for it and nothing
spending it: `#267` and `#263` refused at `review` with `rounds: 3` unspent and
cost $14.19 waiting for somebody to read the findings.

## What it does

A refused pass arrives at `proposed` carrying the reason, and `judgeDeclaredAt`
(`packages/conductor/src/judge.ts`) takes the entry whose `when:` matches; a
runtime is dispatched by `askTheAgent` (`conduct.ts`). **A judge answers *which
of these*, never *what may be spent*:** `stepsOnOffer` counts `rounds` and
`restarts` and hands over the set ([0061](../decisions/0061-the-recipe-is-the-pipeline.md)
§3); an answer outside it holds the pass for a person, and a set of one is never
asked. `claude-code` (or `codex`) costs one dispatch per arrival (`#277`: two at $0.41).

**Five directions, two already answered.** With nothing declared, `BUILT_IN_FOR`
sends `red` and `verify-failed` to `same-worktree`, so a `judge:` there only
rewords the card; `conflict` and `needs-input` go to a person. **`findings` is the
one worth an agent**: *the lines* and *the approach* are different work.

## Where it may be declared

`proposed` only ([0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4). A refusal at `build`, `review` or `merge` *travels* to `proposed`, so a `judge:`
at the refusing step would be a second router
([0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b). `proposed: []`
behaves as before the key existed (0064 §5).

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict and waiver addresses this action; the route's sentence names it, so write it as the decision it makes. |
| `judge` | `same-worktree` \| `claude-code` \| `codex` | yes | Who decides. `ask-or-assume` from 0061 §3's example is not in the enum: nothing implements it. |
| `when` | `red` \| `verify-failed` \| `conflict` \| `needs-input` \| `findings` | yes, **no default** | The direction this entry answers. Two entries for one direction: the first wins, both are on the board. |
| `model` | string | no, the runtime's own default | Which model buys the judgement; handed to the runtime unvalidated (`#314`, [0070](../decisions/0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md) §2). |
| `limits` | `{ turns?, wall? }` | no, `runtime.limits` | What this call may spend; it may only narrow the ceiling (0070 §5). |

`model` and `limits` come from [`agent:`](agent.md)'s dispatch group. **A built-in
takes neither**, and `rounds` and `restarts` are declared nowhere here.

## Examples

```yaml
# ~/.lingtai/lingtai/recipe.yml — a mechanical direction written out (`verify-failed` is the twin)
proposed:
  - name: a red build is the agent's to fix, in the worktree it is already in
    judge: same-worktree
    when: red
```

```yaml
# ~/.lingtai/lingtai/recipe.yml — the paid judge for `findings` (model/limits optional)
proposed:
  - name: the lines or the approach
    judge: claude-code
    model: haiku
    limits: { turns: 5 }
    when: findings
```

```yaml
# packages/conductor/test/one-pass.ts — `JUDGED`: free, but cannot tell lines from approach
proposed:
  - name: the lines, until the rounds are spent
    judge: same-worktree
    when: findings
```

## What it refuses

```yaml
build:
  - name: the lines or the approach
    judge: claude-code
    when: findings
```

> the "the lines or the approach" action is a "judge" at the "build" step, and
> `judge:` does not implement `build` — it serves `proposed`: `proposed` is the
> only step that routes (0058 §3b) … — refused when the recipe resolves, before any money.

An omitted or misspelled `when:` gives `its "when" field is not what "judge"
accepts: Invalid option: expected one of "red"|"verify-failed"|"conflict"|"needs-input"|"findings"`;
`judge: ask-or-assume` gives the same with `"same-worktree"|"claude-code"|"codex"`.
`rounds: 5` gives `"judge" declares no "rounds" field` (0061 §9).

**Not the schema's:** a runtime this machine is not signed in to is refused
before the claim by `agentRefusal` (`conduct.ts`).

## Related

- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §3 — **`judge:` decides
  which step is next; the workflow decides which steps it may choose from.**
- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b — only
  `proposed` routes, so this key serves one step.
- [0038](../decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
  §2 — a refusal an agent could not be held to buys no round.
- [0040](../decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) — rounds
  bound depth, restarts breadth: `rounds:` is unsafe on a judge.
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4, §5 —
  legality is `judgePlugin.at`; absent is not empty.
- `#274` opened `judgePlugin.at.proposed`; `#277` made a runtime a legal name;
  `#314` added `model:` and `limits:`; [the-plugin-body.md](../design/the-plugin-body.md) §5 — *code, restart, paste*.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
