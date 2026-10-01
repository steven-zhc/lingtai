# `worktree:`

| | |
|---|---|
| **Does** | Cuts the branch and the worktree the pass owns, from `origin/<base>`. |
| **Write it at** | `admit` — the only step that cuts. |
| **Needs** | `worktree.base` and `worktree.submodules`, both required. No defaults. |
| **Refuses** | A `worktree:` without `submodules`, or at any step but `admit`. |
| **Watch out** | `base:` lives here and nowhere else — `merge:` declares none, so what a pass cut and what it lands cannot disagree. |

Gives every pass one disposable branch to work on, cut from the remote's base
rather than from whatever a local checkout happens to hold, so a ticket starts
from what was merged and not from somebody's half-finished state.

## What it does

`createWorktreeAction` in `packages/actions/src/worktree-action.ts` runs
`provisionWorktree` (`packages/repo/src/worktree.ts`): a branch `agent/<n>` and a
git worktree cut from `origin/<base>`. It does nothing else — no install, no
claim. **Declaring nothing at `admit` runs the same action** off the recipe's
base and submodules, so this key is for changing those values, not for turning
the cut on.

`repo.base` and `repo.submodules` are the same two settings in their v1 spelling,
and a recipe may write either. `baseOf` and `submodulesOf` in `settings.ts` are
the one place that knows which spelling a file used; the merge lane, `lingtai
doctor`, `lingtai add` and the board all ask that.

## Where it may be declared

`worktreePlugin.at` is `{ admit }`. A pass is cut one branch before anything is
claimed against it or written in it, and every later step works inside what the
cut made — so a `worktree:` further down the spine would move the ground under a
change already written, and one before `admit` would ask for a tree while the item
is still in the queue.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How the step's verdicts address this action. |
| `worktree.base` | string | yes | The branch work is cut from and lands on — `origin/<base>`, never local state. |
| `worktree.submodules` | boolean | **yes, no default** | Whether the tree gets its submodules. `git worktree add` leaves them empty, so a test that imports one fails in a way that reads as the agent's fault. Written out on purpose. |

## Examples

```yaml
# this repository's own settings, from .lingtai/config.yaml (`repo:` — the v1 spelling)
admit:
  - name: cut
    worktree: { base: main, submodules: false }
```

```yaml
# a repository with a vendored submodule that its tests import
admit:
  - name: cut
    worktree: { base: main, submodules: true }
```

```yaml
# a repository that lands on a long-lived branch rather than main
admit:
  - name: cut the branch
    worktree: { base: develop, submodules: false }
```

The first is the resolved shape of `repo: { base: main, submodules: false }`; the
others differ in what they decide — what is on disk, and what `origin/…` means.

## What it refuses

```yaml
admit:
  - name: cut
    worktree: { base: main }
```

> `steps.admit.0.worktree.submodules`: … its "worktree" field is not what
> "worktree" accepts: Invalid input: expected boolean, received undefined.

At any other step: *`worktree:` does not implement `implement` — it serves
`admit`: … a `worktree:` further down the spine would move the ground under a
change already written*. Both when the recipe resolves — before a worktree,
before an agent, before any money.

## Related

- [`plugins/index.md`](index.md) — all the plugins, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
- [reference.md](../reference.md) — every recipe key, including `repo:`.
