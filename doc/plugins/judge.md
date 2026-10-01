# `judge:`

| | |
|---|---|
| **Does** | Answers *what now* when a step refused, in place of the person the pass would otherwise stop for. |
| **Write it at** | `proposed` — and nowhere else. |
| **Needs** | `judge` (`same-worktree` \| `claude-code` \| `codex`) and `when` (no default). `model` and `limits` default to the runtime's own. |
| **Refuses** | Any step but `proposed`, an omitted or unknown `when`, `ask-or-assume`, and `rounds:` or `restarts:` anywhere on it. |
| **Watch out** | `claude-code` buys an agent every time that direction arrives; `same-worktree` spends nothing. One line decides what a refusal costs. |

`judge:` keeps a pass from parking with rounds unspent and nothing spending
them: a refusal at `review` with `rounds` left over waits for a person to read the
findings unless a judge answers it.

## What it does

A refused pass arrives at `proposed` carrying the reason, and `judgeDeclaredAt`
(`packages/conductor/src/judge.ts`) takes the entry whose `when:` matches; a
runtime is dispatched by `askTheAgent` (`conduct.ts`). **A judge answers *which
of these*, never *what may be spent*:** `stepsOnOffer` counts `rounds` and
`restarts` and hands over the set; an answer outside it holds the pass for a
person, and a set of one is never asked. `claude-code` (or `codex`) costs one
dispatch per arrival.

**Five directions, two already answered.** With nothing declared, `BUILT_IN_FOR`
sends `red` and `verify-failed` to `same-worktree`, so a `judge:` there only
rewords the card; `conflict` and `needs-input` go to a person. **`findings` is the
one worth an agent**: *the lines* and *the approach* are different work.

## Where it may be declared

`proposed` only (`judgePlugin.at` in `packages/recipe/src/recipe.ts`). A refusal
at `build`, `review` or `merge` *travels* to `proposed`, so a `judge:` at the
refusing step would be a second router. `proposed: []` declares nothing, and the
built-in answers apply.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict and waiver addresses this action; the route's sentence names it, so write it as the decision it makes. |
| `judge` | `same-worktree` \| `claude-code` \| `codex` | yes | Who decides. `ask-or-assume` is not in the enum: nothing implements it. |
| `when` | `red` \| `verify-failed` \| `conflict` \| `needs-input` \| `findings` | yes, **no default** | The direction this entry answers. Two entries for one direction: the first wins, both are on the board. |
| `model` | string | no, the runtime's own default | Which model buys the judgement; handed to the runtime unvalidated. |
| `limits` | `{ turns?, wall? }` | no, `runtime.limits` | What this call may spend; it may only narrow the ceiling. |

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
> only step that routes … — refused when the recipe resolves, before any money.

An omitted or misspelled `when:` gives `its "when" field is not what "judge"
accepts: Invalid option: expected one of "red"|"verify-failed"|"conflict"|"needs-input"|"findings"`;
`judge: ask-or-assume` gives the same with `"same-worktree"|"claude-code"|"codex"`.
`rounds: 5` gives `"judge" declares no "rounds" field`.

**Not the schema's:** a runtime this machine is not signed in to is refused
before the claim by `agentRefusal` (`conduct.ts`).

## Related

- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [`agent.md`](agent.md) — `model` and `limits` work as they do there; also the paid reviewer a `findings` judge reads.
- [`human.md`](human.md) — holding at `proposed` for a person.
- [`reference.md`](../reference.md) — the recipe's fields and `runtime.limits`.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
