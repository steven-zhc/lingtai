# `human:`

| | |
|---|---|
| **Does** | Stops the pass at `proposed` and asks a person your question; nothing merges until they answer. |
| **Write it at** | `proposed` — and nowhere else. |
| **Needs** | `name` and `human` (the question). No other field exists. |
| **Refuses** | Any step but `proposed`, and a `timeout:`, `when:`, `then:` or `approvers:` beside it. |
| **Watch out** | `merge: []` is not a hold — it resolves and still merges. Declare `human:` at `proposed:`, or nothing holds. |

`human:` stops the pass at `proposed` and asks a person the question you wrote;
nothing reaches the base branch until they answer. The failure it prevents is a
change merging with nobody's approval. A recipe that declares none merges
unattended.

## What it does

`createHumanAction` in
[`packages/actions/src/human-action.ts`](../../packages/actions/src/human-action.ts)
returns `needs-approval` with the question as evidence — a third outcome, not a
failure. It asks every time, costs only the wait, and is not re-asked on a fix
round. The answer is `ApprovalGranted`: `lingtai approve <project> --issue <n>
[--note <text>]`, or the held card.

- **`onSha` binds the answer to a commit**, so a force-push invalidates it.
- **No `approvers:` field, deliberately** — a recipe naming its own approvers
  could approve itself. Who answered is recorded (`by`), not restricted.
- **No rejection to declare**; end a wait with `lingtai requeue`.
- **`lingtai run --no-merge` is an injected hold, not a declared one.** A test or
  run that passes the flag says nothing about a `human:` written in the recipe;
  to know the recipe holds, run without the flag.

## Where it may be declared

`humanPlugin.at` in
[`packages/recipe/src/recipe.ts`](../../packages/recipe/src/recipe.ts) is
`{ proposed }`, the step every pass past `review` reaches, one step before
anything lands.

- **Not `merge`.** The lane is an action in that list, so a hold after it asks
  whether to merge a change already merged. Only `proposed` may send a pass to a
  person, and the lane is the last action at `merge:`.
- **Not `prepared`.** A hold there is a release: the run ends before anyone can
  answer, so the item re-claims and asks again every pass.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How verdicts, `lingtai waive` and the board address this action; two holds at one step want two names. |
| `human` | string | yes | The question. No minimum length: `human: ""` resolves and the card asks nothing. |

## Examples

```yaml
# `APPROVE_ACTION` in packages/conductor/src/wizard-page.ts — what `lingtai init`
# writes when a person answers yes to the merge question: hold every merge.
proposed:
  - name: approve
    human: Merge this?
```

```yaml
# `HUMAN_BEFORE_THE_LANE` in packages/conductor/test/one-pass.ts (the `steps:` of it)
# — no flag anywhere, the file alone asks, `integrate` is never called.
proposed:
  - name: approval
    human: "Merge this? It is Lingtai's own code."
```

```yaml
# packages/conductor/unit/judge.test.ts — a hold beside a glob that fails outright
proposed:
  - name: tamper
    watch: ["**/recipe.yml"]
    then: fail
  - name: approval
    human: merge this?
```

## What it refuses

```yaml
merge:
  - name: approve
    human: Merge this?
```

> the "approve" action is a "human" at the "merge" step, and `human:` does not
> implement `merge` — it serves `proposed`: `merge` may not reach a person … **only
> `proposed` may send it to a person**. So … is `proposed:`, and that is the step
> to write this at.

At `prepared` it ends *a hold at `prepared` cannot be answered — the run is
released back to the queue and the question goes with it … Ask before the claim
with `lingtai ask`, or at `proposed`, where there is a diff to approve*. A
`timeout: 10m` is refused as *"human" declares no "timeout" field — what it
declares is "name", "human"*. All before any money.

## Related

- [reference.md](../reference.md) — the `human:` row and the `ApprovalRequested` / `ApprovalGranted` shapes.
- [`plugins/index.md`](index.md) — every plugin, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than declaring one.
