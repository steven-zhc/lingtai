# `backlog:`

| | |
|---|---|
| **Does** | Would set the severity at or below which a reviewer's finding is filed instead of buying a fix round. |
| **Write it at** | **Nowhere.** No step reads it. |
| **Needs** | `backlog`: `blocker` \| `major` \| `minor`, default `minor`. |
| **Refuses** | Everything, at every step, with a sentence saying where the code is called instead. |
| **Watch out** | Writing the key changes nothing. The bar is fixed in code in two places, and the recipe reaches neither. |

The one row in the closed set that does nothing: it has a schema and a default
and serves no step, because the bar it names is a literal in two places in the
code. A recipe that writes it is told *why it does nothing* rather than having it
accepted and never read.

## What it does

`backlog:` is not read by any step, and writing it is refused. The setting it
names would be **the severity at or below which a finding is filed** rather than
refusing. The fixed value is `minor`, and the default says so.

Two literals that cannot see each other fix the bar: `verdictFor`
(`packages/actions/src/agent-action.ts`) decides what **refuses**, off a hard-coded
*blocker-or-major*, and `backlogProjection` (`packages/projector/src/backlog.ts`)
decides what is **filed**, off a literal `minor`. `decideBacklog`
(`packages/conductor/src/backlog.ts`) is that comparison as a function. **Both take
the value or neither does**: changing only the fold's still gets `failed` for a
major and buys the round, and reads as honoured.

A person decides what happens to a filed finding with `lingtai backlog` or the
board (`acceptFinding` / `declineFinding`). It routes nothing, declares no `when:`,
no `kinds:` and no `dedup:` — the key is over ticket, step, action, file and claim.

## Where it may be declared

*Nowhere.* `backlogPlugin.at` is `{}`, and `CALLED_DIRECTLY.backlog` in
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
can write is the default, and it resolves nowhere** — the refusal below is the
example. The two places the bar is set are in code:

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
> `backlog:` action from the recipe — … **the bar is in two places and
> wiring one of them changes nothing.** …

The same sentence at every step, whichever the key is written at — asked first, so
the useful half of the truth is told rather than *no plugin implements `end`*. When
the recipe resolves — before a worktree, before an agent, before any money.

## Related

- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
- [reference.md](../reference.md) — the glossary: event types, stream prefixes, limits.
