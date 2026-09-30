# `watch:`

| | |
|---|---|
| **Does** | Holds the pass for a person when the diff touches a path you named. |
| **Write it at** | `proposed` — and nowhere else. |
| **Needs** | `watch`: a non-empty list of globs. `then` defaults to `request-approval`; `fail` is the other value. |
| **Refuses** | An empty list, any other `then`, any step but `proposed`. |
| **Watch out** | On a repository whose every ticket edits its own machinery — Lingtai's — nearly every diff matches, and it holds everything. |

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

**Who it is for.** A managed repository that is not Lingtai should almost
certainly have it on: a watched path is rare there, and a hold means something.
It was on here for one night (`#31`) and held six consecutive items with
`build=passed review=passed`; it is off because every ticket in this queue is
about Lingtai's own machinery, not because it failed. Since `#180` the recipe is
outside every worktree, so the file it mostly guarded is out of an agent's reach
([tamper-watch.md](../tamper-watch.md)).

## Where it may be declared

`watchPlugin.at` is `{ proposed }`. A glob over the file list is a question about
a change already built, which is `proposed`'s. Not `merge` since `#270`: a
`then: request-approval` is a way of reaching a person, and *only `proposed` may
send a pass to a person* (0058 §3b) — a hold written at `merge` would be asked
about a merge the same list had already made.

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
> reach a person, and that is the third of its three ways out (0058 §3b) …

An empty list is refused by the field (`Too small: expected array to have >=1
items`), and `then: hold` by `Invalid option: expected one of
"request-approval"|"fail"`. All of it when the recipe resolves — before a
worktree, before an agent, before any money.

## Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b — only
  `proposed` may send a pass to a person.
- [0046](../decisions/0046-lingtai-is-personal.md) §4 — the recipe left the
  repository, which is where this watch lost its subject.
- `#31` built it; `#270` moved it off `merge`.
- [tamper-watch.md](../tamper-watch.md) — the list, the test that keeps it
  correct, and how to turn it on.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
