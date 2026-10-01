# `queue:`

| | |
|---|---|
| **Does** | Decides which issue the pass is about: your kinds, your holds, your backoff, your assignee rule. |
| **Write it at** | `claim` — the only step that picks. |
| **Needs** | All four of `kinds`, `exclude`, `backoff`, `assignee`. None is defaulted here. |
| **Refuses** | A block that names fewer than four, `take: mine` without a `login`, any step but `claim`. |
| **Watch out** | Order is kind, then issue number — so a dependent ticket of a higher-priority kind goes first. Chain with GitHub's *blocked by*, never in the body. |

Turns a repository's own labels into a queue, so nothing runs that you did not
mark as work and nothing runs that you marked as held. An issue with no kind
label is invisible to it, which is the most common reason a ticket is never taken.

## What it does

`createQueueAction` in `packages/actions/src/queue-action.ts` re-reads the offer
for the issue the pass was pointed at and confirms the claim. **Declaring nothing
at `claim` runs the same action** off the recipe's `source:`, so this key is for
moving those four settings to the step that owns them.

- **Kinds are vocabulary, filter and priority at once.** A label outside `kinds`
  is not a kind; earlier wins.
- **Open blockers pass an issue over**, always, and no recipe turns it off.
  `blockedBy` counts blockers still *open*; a GitHub that says nothing about
  dependencies passes nothing over on that account.
- **It cannot refuse.** A claim that took nothing is holding nothing, so it ends
  `did-not-finish` with `passed-over`, `not-claimed` or `claim-unconfirmed`.
- **`source:` is the v1 spelling.** `settings.ts` reads whichever the file wrote.

## Where it may be declared

`queuePlugin.at` is `{ claim }`. A pass is about one work item, `claim` is where
it is decided which, and every step after is about that one — so a `queue:` further
down would have a pass working one ticket while holding another.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How the claim's outcome is addressed. |
| `queue.kinds` | list of labels (≥ 1) | yes | Labels that mark work, **most wanted first**. |
| `queue.exclude` | list of labels | yes | Labels that keep the agent off a ticket. `[]` is none. |
| `queue.backoff` | duration | yes | How long a failed attempt keeps its own ticket out, like `1h`. |
| `queue.assignee` | `{ login?, take }` | yes | `take`: `mine` \| `unassigned` \| `both` (default `both`). `mine` needs `login`. |

**No field is defaulted on purpose**: a block naming only `kinds` would replace the
hold list with `[]` and claim an `agent:hold` ticket. `source:` defaults them
(`exclude: []`, `backoff: 1h`); this block does not.

## Examples

```yaml
# this repository's `source:` in .lingtai/config.yaml, as a step
claim:
  - name: pick
    queue:
      kinds: [ bug, tech-debt, feature ]
      exclude: [ blocked, in-progress, agent:hold, agent:blocked, epic ]
      backoff: 1h
      assignee:
        take: both
```

```yaml
# a machine that only takes what is assigned to it, on a short backoff
claim:
  - name: pick
    queue:
      kinds: [ bug, feature ]
      exclude: [ agent:hold ]
      backoff: 30m
      assignee:
        login: steven-zhc
        take: mine
```

```yaml
# a shared repository: only what nobody has picked up
claim:
  - name: pick
    queue:
      kinds: [ bug ]
      exclude: []
      backoff: 2h
      assignee:
        take: unassigned
```

The first is the repository's own file; the other two differ in *who* may be
handed a ticket and how soon a failure returns.

## What it refuses

```yaml
claim:
  - name: pick
    queue:
      kinds: [ bug ]
```

> `steps.claim.0.queue.exclude`: … Invalid input: expected array, received
> undefined. (and the same for `backoff` and `assignee`)

`assignee: { take: mine }` with no login: *take: mine needs a login — the GitHub
login this machine's issues are assigned to*. Elsewhere: *`queue:` does not
implement `build` — it serves `claim`*. All when the recipe resolves — before a
worktree, before an agent, before any money.

## Related

- [`plugins/index.md`](index.md) — all the plugins, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
- [reference.md](../reference.md) — every recipe key, including `source:`.
