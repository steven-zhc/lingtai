# `labels:`

| | |
|---|---|
| **Does** | Sets the issue's labels when the ticket ends: Lingtai's own are replaced, everybody else's are kept. |
| **Write it at** | `end`. |
| **Needs** | `labels`: a list of label names. `when` defaults to `any`. |
| **Refuses** | `labels:` as a bare string, a `when` outside the five outcomes, any step but `end`. |
| **Watch out** | The default is `any`, not `landed` — unlike `close:` it runs on every ending unless you narrow it. |

Leaves a label on the issue saying how it ended, so the next person to open the
queue in GitHub sees why a ticket stopped without opening the board.

## What it does

Carried out by `tell.ts` off `resolveEndActions` (`packages/conductor/src/end-step.ts`)
like every effect at `end`. `when` picks the outcomes it runs on, so *label it
`needs-human` when blocked* and *close it when landed* are two entries and one
configuration.

**Lingtai's own labels are the ones beginning `lingtai:`** (`labels.ts`). Those
are set as a whole computed set — never a union — and every label without that prefix
is somebody else's and is left alone.

## Where it may be declared

`labelsPlugin.at` is `{ end }`: an effect, not a verdict, and only `end` carries
out effects.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How the effect is named on the log. |
| `labels` | list of strings | yes | The labels to set. |
| `when` | `landed` \| `blocked` \| `failed` \| `closed` \| `any` | no, `any` | Which endings it runs on. |

## Examples

```yaml
# packages/recipe/unit/plugin.test.ts — a label on whatever the ending was
end:
  - name: label it
    labels: [lingtai:done]
```

```yaml
# say a blocked ticket needs a person, and only then
end:
  - name: flag it
    labels: [needs-human]
    when: blocked
```

```yaml
# a failed attempt is tagged for triage
end:
  - name: triage
    labels: [needs-triage]
    when: failed
```

They differ in which ending they answer: every one, blocked, failed.

## What it refuses

```yaml
end:
  - name: flag it
    labels: needs-human
```

> `steps.end.0.labels`: … its "labels" field is not what "labels" accepts:
> Invalid input: expected array, received string.

At `build`: *`labels:` does not implement `build` — it serves `end`: it is an effect
rather than a verdict, and only the `end` step carries out effects.* Both when the
recipe resolves — before a worktree, before an agent, before any money.

## Related

- [`close.md`](close.md), [`refs.md`](refs.md) — the other two effects at `end`.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
