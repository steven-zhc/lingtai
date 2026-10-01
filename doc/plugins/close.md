# `close:`

| | |
|---|---|
| **Does** | Closes the GitHub issue the pass was about, so nobody runs `gh issue close` by hand. |
| **Write it at** | `end` — the one step that carries out effects. |
| **Needs** | `close: true`. `when` defaults to `landed`. |
| **Refuses** | `close: false`, a `when` outside the five outcomes, any step but `end`. |
| **Watch out** | `end` fires on **every** ending: with `when: any` a blocked or failed ticket is closed too. |

Closes the issue when a ticket ends, so the board and GitHub agree about what is
finished. It runs for effect — `end` is the point that cannot refuse.

## What it does

`end-step.ts` resolves the effects for an outcome (`resolveEndActions`) and
`tell.ts` carries them out. `when` filters on the outcome: *close it when it
lands, label it when it is blocked* is one configuration. `closed` is the fourth
outcome and `any` includes it: a ticket a person ended is closed on GitHub too.

## Where it may be declared

`closePlugin.at` is `{ end }`. It is an effect and not a verdict, and only `end`
carries out effects; at any deciding step it would be a thing a pass waits on that
produces no answer.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How the effect is named on the log. |
| `close` | `true` | yes | The key. Only `true`; there is no `close: false`. |
| `when` | `landed` \| `blocked` \| `failed` \| `closed` \| `any` | no, `landed` | Which endings it runs on. |

## Examples

```yaml
# packages/recipe/unit/plugin.test.ts — the default: close only what landed
end:
  - name: close it
    close: true
```

```yaml
# a ticket that ended for any reason is finished with — including a person closing it
end:
  - name: close it
    close: true
    when: any
```

```yaml
# close on landing, and label what did not (see labels.md)
end:
  - name: close it
    close: true
  - name: flag it
    labels: [needs-human]
    when: blocked
```

The first is the default spelled out; the second widens what ends an issue; the
third pairs it with a different effect on a different outcome.

## What it refuses

```yaml
end:
  - name: close it
    close: true
    when: sometimes
```

> `steps.end.0.when`: … its "when" field is not what "close" accepts: Invalid
> option: expected one of "landed"|"blocked"|"failed"|"closed"|"any".

At `proposed`: *`close:` does not implement `proposed` — it serves `end`: it is an
effect rather than a verdict, and only the `end` step carries out effects.* Both
when the recipe resolves — before a worktree, before an agent, before any money.

## Related

- [`labels.md`](labels.md), [`refs.md`](refs.md) — the other two effects at `end`.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
