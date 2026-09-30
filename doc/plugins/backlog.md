# `backlog:`

| | |
|---|---|
| **Does** | Would set the severity at or below which a reviewer's finding is filed instead of buying a fix round. |
| **Write it at** | **Nowhere yet.** No step reads it. |
| **Needs** | `backlog`: `blocker` \| `major` \| `minor`, default `minor`. |
| **Refuses** | Everything, at every step, with a sentence saying where the code is called instead. |
| **Watch out** | Naming a thing is not wiring it. The bar is written in two places today; wiring one changes nothing. |

The one row in the closed set that does nothing: it has a schema and a default
and serves no step, because the bar it names is a literal in two folds. It is on
the list so that a recipe writing it is told *why it does nothing* rather than
having it accepted, recorded, drawn on the board and never read (`#61`).

## What it does

It is the design for one setting: **the severity at or below which a finding is
filed** rather than refusing. `minor` is what the code does, and the default says
so. Nearly half of what a reviewer says arrives at or below it — 316 minor and 281
major of 660 findings across 231 refusals in 14 days
([012 §4](../experiments/012-where-the-turns-go.md)).

What happens today is two literals that cannot see each other: `verdictFor`
(`packages/actions/src/agent-action.ts`) decides what **refuses**, off a hard-coded
*blocker-or-major*, and `backlogProjection` (`packages/projector/src/backlog.ts`)
decides what is **filed**, off a literal `minor`. `decideBacklog`
(`packages/conductor/src/backlog.ts`) is that comparison as a function. **Both take
the value or neither does**: changing only the fold's still gets `failed` for a
major and buys the round, and reads as honoured.

A person decides what happens to a filed one with `lingtai backlog` or the board
(`acceptFinding` / `declineFinding`). It routes nothing, declares no `when:`, no
`kinds:` and no `dedup:` — the key is over ticket, step, action, file and claim.

## Where it may be declared

*Nowhere yet.* `backlogPlugin.at` is `{}`, and `CALLED_DIRECTLY.backlog` in
`recipe.ts` says where the code is called instead, in the sentence the refusal
prints. This is the page for a person who found the key and wants to know why
writing it does nothing.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How the action would be addressed. |
| `backlog` | `blocker` \| `major` \| `minor` | no, `minor` | At or below this, a finding is filed and buys no round. Read off `SEVERITIES`. |

## Examples

There is no recipe that uses it, so there is nothing real to copy. **What a person
can write today is the default, and it resolves nowhere** — the refusal below is
the example. The two other ways the same thing gets changed are in code:

- the fold's literal, `packages/projector/src/backlog.ts`
- the refusal's hard-coded bar, `verdictFor` in `packages/actions/src/agent-action.ts`

Neither is a recipe line, and editing one alone is the failure described above.

## What it refuses

```yaml
end:
  - name: bar
    backlog: minor
```

> the "bar" action is a "backlog" at the "end" step, and no step reads a
> `backlog:` action from the recipe yet — … Today **the bar is in two places and
> wiring one of them changes nothing.** …

The same sentence at every step, whichever the key is written at — asked first, so
the useful half of the truth is told rather than *no plugin implements `end`*. When
the recipe resolves — before a worktree, before an agent, before any money.

## Related

- [0038](../decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
  §5 — a finding buys an agent before it buys your attention; the bar is its
  fifth point.
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 —
  naming a thing is not wiring it.
- `#137` built the backlog; `#61` is the failure a silently accepted key would be.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
