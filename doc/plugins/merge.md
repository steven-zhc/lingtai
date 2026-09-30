# `merge:`

| | |
|---|---|
| **Does** | Lands the branch on the base: merge the base in, verify, merge out, push. |
| **Write it at** | `merge` — the last action there. |
| **Needs** | Nothing beyond `name`. `merge.strategy` defaults to `merge-commit`, the only value. |
| **Refuses** | Any other `strategy`, a `base:` of its own, any step but `merge`. |
| **Watch out** | It **reports and does not decide**: a refused landing goes to `proposed`, where a round is bought. A hold written after it asks about a merge already made. |

Puts a change on the base exactly once, after every other step has passed — so
what lands is the thing the review was of, and a failed landing is a report
carrying its own reason rather than a half-merged `main`.

## What it does

`createMergeAction` in `packages/actions/src/merge-action.ts` drives `integrate`
(`packages/repo/src/integrate.ts`): merge the base into the branch, re-verify
against what landed in the meantime, merge out with `git merge --no-edit`, then
push — a fast-forward where it can be one. **Declaring nothing at `merge` runs the
same action** off the same base (0065 §2).

A refusal carries the lane's own `reason` (`conflict`, `verify-failed`, …) and
`detail` to `proposed`. `strategy` has one value because `integrate.ts` offers
one; a second would be a behaviour this repository does not have, declared as
though it did.

## Where it may be declared

`mergePlugin.at` is `{ merge }`: it is the last step before `end` and the only one
that changes the base, so the lane is read there and a pass lands once. **It is
the last action in that list** — anything written after it is refused (0065 §8),
because a check that fails there fails about a change already on `main`. A
person-asking action at `merge` is refused too: hold at `proposed`, or run with
`--no-merge`.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict addresses this action. |
| `merge.strategy` | `merge-commit` | no, `merge-commit` | How the branch goes in. The enum is the code's: it grows when the code does. |

**There is no `base:`, deliberately** (0061 §4). `base` is written on `worktree:`
(or `repo.base`) and handed to the lane, so what a pass cut and what it lands
cannot disagree.

## Examples

```yaml
# packages/recipe/unit/edit-mechanism.test.ts — the landing written out
merge:
  - name: land the branch
    merge: { strategy: merge-commit }
```

```yaml
# the default spelled out: `strategy` may be left off
merge:
  - name: land
    merge: {}
```

```yaml
# a repository that wants a person to approve first: the hold is at `proposed`, before the lane
proposed:
  - name: approve the merge
    human: "Land this change on main?"
merge:
  - name: land
    merge: {}
```

The first two differ in nothing but spelling, on purpose — leaving the key out is
the third spelling. The last is the one that decides something.

## What it refuses

```yaml
merge:
  - name: land
    merge: { strategy: squash }
```

> `steps.merge.0.merge.strategy`: … its "merge" field is not what "merge"
> accepts: Invalid input: expected "merge-commit".

Written at `proposed`: *`merge:` does not implement `proposed` — it serves `merge`:
`merge` is the last step before `end` and the only one that changes the base …
a lane declared earlier on the spine would put a change on `main` while the steps
after it were still deciding about it.* All when the recipe resolves — before a
worktree, before an agent, before any money.

## Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b–§3c — the
  three ways out of `merge`, and that the lane reports rather than decides.
- [0065](../decisions/0065-the-default-is-a-plugin.md) §2, §8 — the landing is
  an action in the step's own list, and the last one.
- `#270` opened the key; `#58` is why a hold cannot come after it.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
