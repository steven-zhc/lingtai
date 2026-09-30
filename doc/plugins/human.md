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
change merging with nobody's approval — `#58`, where a declared `human:` was drawn
on the board but never built, and two changes merged unapproved. This repository
declares none, so it merges unattended by configuration.

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
- **No rejection to declare** (`#150`); end a wait with `lingtai requeue`.
- **`lingtai run --no-merge` is the injected form, not the declared one**
  (`alsoHeldAtMerge`, `#20`): a test passing the flag says nothing about a
  declared `human:`, how `#58` stayed hidden. The pinning test is
  `packages/conductor/unit/conduct-a-whole-pass.test.ts`, *holds at a person the
  recipe declared before the lane, with no --no-merge anywhere*.

## Where it may be declared

`humanPlugin.at` in
[`packages/recipe/src/recipe.ts`](../../packages/recipe/src/recipe.ts) is
`{ proposed }`, the spine step every pass past `review` reaches, one step before
anything lands.

- **Not `merge`, since `#270`.** The lane is an action in that list, so a hold
  after it asks whether to merge a change already merged. 0058 §3b: only
  `proposed` may send a pass to a person; the lane is last at `merge:`
  ([0065](../decisions/0065-the-default-is-a-plugin.md) §8).
- **Not `prepared`.** A hold there is a release: the run ends before anyone can
  answer, so the item re-claims and asks again every pass
  ([0059](../decisions/0059-a-point-carries-only-the-kinds-it-runs.md)).

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
# — pins #58: no flag anywhere, the file alone asks, `integrate` is never called.
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
> implement `merge` — it serves `proposed`: `merge` may not reach a person, and
> that is the third of its three ways out (0058 §3b) … **only `proposed` may send
> it to a person**. So … is `proposed:`, and that is the step to write this at.

At `prepared` it ends *a hold at `prepared` cannot be answered — the run is
released back to the queue and the question goes with it … Ask before the claim
with `lingtai ask`, or at `proposed`, where there is a diff to approve*. A
`timeout: 10m` is refused as *"human" declares no "timeout" field — what it
declares is "name", "human"* (0061 §9). All before any money.

## Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b — only `proposed` may send a pass to a person.
- [0059](../decisions/0059-a-point-carries-only-the-kinds-it-runs.md) — a hold at `prepared` is a release that re-asks.
- [0016](../decisions/0016-the-settled-model.md) §4 — a configured gate that did not run is Lingtai's bug (`#58`).
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 — legality is `humanPlugin.at`.
- [0065](../decisions/0065-the-default-is-a-plugin.md) §6 — `merge: []` is decided to run nothing, not yet built; §8 — the lane is last at `merge:`.
- `#58` the failure; `#20` made `--no-merge` a `human:` action; `#270` took this key off `merge`.
- [reference.md](../reference.md) — the `human:` row and the `ApprovalRequested` / `ApprovalGranted` shapes.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than declaring one.
