# `refs:`

| | |
|---|---|
| **Does** | Deletes the `agent/<n>-attempt-<k>` history refs a landed ticket left on `origin`. |
| **Write it at** | `end`. |
| **Needs** | `refs: true`. `branch` defaults to `false`; `when` is `landed`, the only value. |
| **Refuses** | `when: any`, `refs: false`, any step but `end`. |
| **Watch out** | Only for a ticket that **landed**: for one that did not, those refs are the only account of what was tried. Leave it out to keep every branch. |

Stops the remote from collecting one ref per approach a repository has ever tried.
Nothing else deletes a branch, so the count only grows — this repository carried
**150 `agent/*` refs**, thirteen of them abandoned arms, and every clone and fetch
paid for all of them.

## What it does

An effect at `end`, like `close:` and `labels:`, so it cannot refuse. It removes
the siblings `armBranch` pushes ([0062](../decisions/0062-what-a-claim-leaves-behind.md) §2).
**`agent/<n>` itself stays** unless `branch: true`: after a merge its commits are
reachable from `main`, but it is the ref a person follows from the merge commit, so
the default keeps what somebody might read.

**It is declinable by not being declared**, which is why it is a plugin (0061 §2).
A team that keeps every branch for audit leaves it out.

## Where it may be declared

`refsPlugin.at` is `{ end }`: an effect, and only `end` carries out effects.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How the effect is named on the log. |
| `refs` | `true` | yes | The key. What is deleted is decided by `branch`, not by this value. |
| `branch` | boolean | no, `false` | Also delete `agent/<n>`, on top of its arms. |
| `when` | `landed` | no, `landed` | Only `landed`, written out so the file says which ending. |

**`when` is a literal and not an enum, and that is the safety argument.** `#239`
creates these refs precisely so a later attempt can fetch what an earlier one
tried, and a cleanup on any other ending destroys that. A value nobody can write is
a mistake nobody can make.

## Examples

```yaml
# the default: clean the arms of what landed, keep the branch
end:
  - name: tidy
    refs: true
```

```yaml
# delete the branch too, for a team that reads history from main and nowhere else
end:
  - name: tidy
    refs: true
    branch: true
```

```yaml
# beside close: — the ticket is closed and its refs go in the same ending
end:
  - name: close it
    close: true
  - name: tidy
    refs: true
```

Each resolves under `resolveSource`. They differ in what is destroyed: the arms,
the arms and the branch, and what else happens at the same ending.

## What it refuses

```yaml
end:
  - name: tidy
    refs: true
    when: any
```

> `steps.end.0.when`: … its "when" field is not what "refs" accepts: Invalid
> input: expected "landed".

At any other step: *`refs:` does not implement …  — it serves `end`: it is an effect
rather than a verdict.* Both when the recipe resolves — before a worktree, before an
agent, before any money.

## Related

- [0062](../decisions/0062-what-a-claim-leaves-behind.md) §2 — what a claim leaves
  on `origin`, and why the arms exist.
- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §2 — declinable by not
  being declared.
- `#240` built it; `#239` is why a non-landed ticket keeps its refs.
- [`close.md`](close.md), [`labels.md`](labels.md) — the other two effects at `end`.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
