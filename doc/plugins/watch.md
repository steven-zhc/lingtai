# `watch:`

| | |
|---|---|
| **Does** | Holds the pass for a person when the diff touches a path you named. |
| **Write it at** | `proposed` — and nowhere else. |
| **Needs** | `watch`: a non-empty list of globs. `then` defaults to `request-approval`; `fail` is the other value. |
| **Refuses** | An empty list, any other `then`, any step but `proposed`. |
| **Watch out** | On a repository whose every ticket edits its own machinery, nearly every diff matches, and it holds everything. |

Holds a change for a person when it touches something a person should see,
so the agent cannot edit the thing that judges its work and then pass that
judgement. It reads the diff's file list and matches globs — no process, no model,
no cost — and the file names in its evidence are what a card says about why.

## What it does

`createWatchAction` in `packages/actions/src/watch-action.ts` compiles the globs
when the action is built (so a bad pattern is a configuration error, not a watch
that silently matches nothing) and matches them against the diff's paths.

- **`then: request-approval`** — the diff is fine, it is just not the machine's
  to wave through. The pass holds at `proposed` and the card names the files.
- **`then: fail`** — *this should not have happened*, for a path nothing
  legitimate touches.

**Who it is for.** A repository whose watched paths are rare: there a hold means
something. A repository whose every ticket is about its own machinery will match
most diffs and hold most passes, so name only paths a person must always see. The
recipe lives outside every worktree, so an agent cannot edit it
([tamper-watch.md](../tamper-watch.md) lists the paths worth watching).

## Where it may be declared

`watchPlugin.at` is `{ proposed }`. A glob over the file list is a question about
a change already built, which is `proposed`'s. Not `merge`: a `then:
request-approval` is a way of reaching a person, and only `proposed` may send a
pass to a person — a hold written at `merge` would be asked about a merge the
same list had already made.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How the hold, the card and the waiver address this action. `tamper` and `migrations` also select built-in advice. |
| `watch` | list of globs | yes (≥ 1) | Matched against the diff's file list, relative to the repository root. |
| `then` | `request-approval` \| `fail` | no, `request-approval` | What a match means. |

## Examples

```yaml
# doc/tamper-watch.md — the tamper guard, abridged
proposed:
  - name: tamper
    watch: [".lingtai/config.yaml", "packages/recipe/**", "package.json", "**/package.json", "pnpm-lock.yaml"]
```

```yaml
# a hold that cannot be approved: the lockfile should never move in this repository
proposed:
  - name: lockfile
    watch: ["pnpm-lock.yaml"]
    then: fail
```

```yaml
# `migrations` is a name with advice built in: apply it by hand first, then approve
proposed:
  - name: migrations
    watch: ["packages/event-store/migrations/**"]
```

Each resolves under `resolveSource`. They are the same block at different
strictness: who is asked, nobody, and who is asked with instructions.

## What it refuses

```yaml
merge:
  - name: t
    watch: ["package.json"]
```

> `watch:` does not implement `merge` — it serves `proposed`: `merge` may not
> reach a person …

An empty list is refused by the field (`Too small: expected array to have >=1
items`), and `then: hold` by `Invalid option: expected one of
"request-approval"|"fail"`. All of it when the recipe resolves — before a
worktree, before an agent, before any money.

## Related

- [tamper-watch.md](../tamper-watch.md) — the list of paths worth watching, and
  how to turn it on.
- [`plugins/index.md`](index.md) — all the plugins, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
- [reference.md](../reference.md) — every recipe key.
