# `human:`

`human:` stops the pass at `proposed` and asks a person the question you wrote;
nothing reaches the base branch until they answer. The failure it prevents is a
change merging with nobody's approval — `#58`, where a `human:` this repository
had declared was resolved into the record, printed by `lingtai add` and drawn on
the board without ever being built into a pipeline, and two of Lingtai's own
changes merged unapproved while the card said somebody was being asked. **So this
is the key that decides whether a repository merges unattended**, and it is worth
reading that both ways: this repository declares none, which is why it merges its
own work unattended — configuration rather than a gap.

## What it does

`createHumanAction` in
[`packages/actions/src/human-action.ts`](../../packages/actions/src/human-action.ts)
is almost nothing, and that is the design: a verification, a cold review and a
person's approval are one primitive — a named check that produces a verdict about
a specific diff — which is what makes *hold anything touching payments for a
person* a configuration line instead of a branch through the scheduler. It
returns `needs-approval` with the question as its evidence and nothing else.
`runActionPipeline` in
[`packages/actions/src/action.ts`](../../packages/actions/src/action.ts) emits
`ApprovalRequested`, skips the actions after it, `endingOf` in `pass.ts` reads
that as `held`, and `outcomeOf` says `blocked`. **`needs-approval` is a third
outcome and not a flavour of failure**: folding it into `failed` would put *the
build is broken* on a card whose build is fine, and folding it into `passed` would
merge it.

It **asks every time**, so there is nothing for it to be green about, and it costs
nothing to run — what it costs is the wait. It is not asked once per round either:
a pass that goes back for a fix round returns to `proposed` without re-running
`proposed`'s own actions, because they are verdicts about a diff that has not
changed (`pass.test.ts`, *runs the router without re-running proposed's own
inspection*).

The answer arrives later as `ApprovalGranted` on the same stream —
`lingtai approve <project> --issue <n> [--note <text>]`, or the held card on the
board. Two properties of the wait belong to everything rather than to this plugin,
and both are worth knowing before you declare one:

- **`onSha` binds the answer to a commit**, so a force-push invalidates the
  approval by arithmetic rather than by somebody remembering to revoke it — the
  bug the old label-based approval had, where a label survived any amount of
  rewriting and a rewritten branch inherited its own approval. `lingtai approve`
  merges the held run's own `headSha` for the same reason: finishing the run by
  starting a new one would merge a diff nobody looked at.
- **There is no `approvers:` field, here or anywhere in the recipe, and that is
  deliberate** — a recipe that could name its own approvers could approve itself.
  Who answered is recorded rather than restricted: `by` on the approval, in the
  log.

There is no rejection to declare either. `--reject` is gone (`#150`): it appended
`ApprovalRevoked` and put the run straight back into `awaiting-approval`, so the
wait it appeared to end went on. What ends a wait the other way is
`lingtai requeue <project> --issue <n> --note <why>`, which ends it with a new
run.

**`lingtai run --no-merge` is the injected form of the same thing, and it is not
the declared one.** `alsoHeldAtMerge` in
[`packages/conductor/src/conduct.ts`](../../packages/conductor/src/conduct.ts)
builds a `createHumanAction` named `no-merge` and composes it into `merge`'s list
ahead of the lane (`heldBeforeTheLane`); a pending repair is the other one. Both
ask for the same `ApprovalRequested` a declared `human:` asks for, because being
one is how you ask for it (`#20` — not a second mechanism), and being the
conductor's own rather than read off a file is why the flag may sit at a step this
key may not. **The two are not interchangeable in a test**, and that is how `#58`
stayed hidden for four days: every test held its run with the flag, and the daemon
does not pass it. A test that passes `--no-merge` exercises the injected action
and says nothing about the declared one. The one that makes the claim is
`packages/conductor/unit/conduct-a-whole-pass.test.ts`'s *holds at a person the
recipe declared before the lane, with no --no-merge anywhere* — `merge: true` on
the fake, so a pipeline that let it past would really land, and the assertion is
that `integrate` was never called.

What it does not do: it decides nothing about the diff, reports nothing, and
carries no `when:` — a hold is reached by every pass that got to `proposed`,
whatever the outcome that brought it there.

## Where it may be declared

**`proposed`, and nothing else.** That is `humanPlugin.at` in
[`packages/recipe/src/recipe.ts`](../../packages/recipe/src/recipe.ts), which
carries one key and is the whole of what makes the plugin legal at a step
([0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4).

**Not at `merge`, since `#270`** — this is the key whose legal position moved most
recently, and the move is a subtraction. While the landing happened in `merge`'s
own *body*, after the whole pipeline, an approval declared there held it: that is
`#58`'s fix, and `CLAUDE.md` described it in as many words. Since `mergePlugin`
took that step the lane is an action in the same list, so an approval written
after it would be *run* after it — the pipeline merging the branch and then asking
a person whether to, which is `#58` again with the order reversed. The rule
underneath is 0058 §3b's: `merge` has three ways out and the third is *anything
else → `proposed`, and only `proposed` may send it to a person*. The refusal is
`ONLY_PROPOSED_ASKS_A_PERSON`, and it is what an operator meets:

> `merge` may not reach a person, and that is the third of its three ways out
> (0058 §3b): a lane that refuses carries its reason to `proposed`, **and only
> `proposed` may send it to a person**. So the step where a proposed change is
> inspected — an approval, a glob over its files, the tamper check — is
> `proposed:`, and that is the step to write this at.

**And not at `prepared`, for a different reason: a hold there is a release.** The
gate is built and it runs, but the run that asked is over before anybody can
answer, so the question outlives the run it belonged to and re-asks itself for
ever — the item re-claims, pays for an install, and asks again on every pass
([0059](../decisions/0059-a-point-carries-only-the-kinds-it-runs.md) calls this
the subtlest of the ten cells and the most expensive). `whyThatPair`'s sentence is
the one to read, because it also names what to do instead:

> a hold at `prepared` cannot be answered — the run is released back to the queue
> and the question goes with it, so the item would re-claim, re-install and ask
> again on every pass. Ask before the claim with `lingtai ask`, or at `proposed`,
> where there is a diff to approve

`proposed` is on the spine — every pass that got past `review` arrives there — so
a hold declared at `proposed:` is reached by the daemon unprompted, one step
before anything lands. That is what makes it the answer to *I do not want this
merging by itself* rather than `merge: []`, which resolves and **still merges**:
the conductor reads an empty list and an omitted key as the same thing, so the
default lane runs ([0065](../decisions/0065-the-default-is-a-plugin.md) §6 decides
otherwise and is not built). The refusal for a `merge:` step written with checks
and no lane says so in one clause — *to hold a pass before anything lands, declare
a `human:` action at `proposed:`*.

## Parameters

Two fields, and the schema's own list of them is `"name", "human"` — so a
`timeout:`, a `when:`, a `then:` or an `approvers:` written beside them is refused
by name rather than ignored (0061 §9).

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. `task_view` keys a verdict `step:action`, `lingtai waive` names one, and the board draws it, so two holds at one step want two names. |
| `human` | string | yes | The question. `z.string()` with no floor, so `human: ""` resolves and the card asks nothing — `createHumanAction`'s fallback sentence is reached only when no question is given at all, which a recipe always does. |

## Examples

```yaml
# `APPROVE_ACTION` in packages/conductor/src/wizard-page.ts — what `lingtai init`
# writes into a new project's recipe when a person answers *yes* to the merge
# question. One line is the whole of "hold every merge for me".
proposed:
  - name: approve
    human: Merge this?
```

```yaml
# `HUMAN_BEFORE_THE_LANE` in packages/conductor/test/one-pass.ts, verbatim — the
# recipe that pins `#58`. The point of it is that no flag is passed anywhere: the
# file is the only thing asking, and `integrate` is never called.
version: 2
repo: { base: main, submodules: false }
source: { kinds: [bug], exclude: [] }
env: { required: [], plantAt: .env.local }
steps:
  proposed:
    - name: approval
      human: "Merge this? It is Lingtai's own code."
runtime: { agent: claude-code, limits: { turns: 10, wall: 2m } }
```

```yaml
# packages/conductor/unit/judge.test.ts — *reads the key rather than the shape, so
# nothing else at the step is a judge*. Three plugins at one step: the router
# answers `findings`, the glob holds on a path, and the hold holds on everything.
# A `human:` beside a `judge:` is not a judge for any direction — the key is the
# discriminator, which is the case `#238` cost.
proposed:
  - name: the lines or the approach
    judge: same-worktree
    when: findings
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
> that is the third of its three ways out (0058 §3b): a lane that refuses carries
> its reason to `proposed`, **and only `proposed` may send it to a person**. So
> the step where a proposed change is inspected — an approval, a glob over its
> files, the tamper check — is `proposed:`, and that is the step to write this at.
> Since `#270` the landing is itself an action in `merge`'s list
> (`mergePlugin.at.merge`), so a hold written here would be asked about a merge
> the same list had already made — `#58` with the order reversed. A run that must
> not merge unattended is held at `proposed:`, which is before the lane, or by
> `lingtai run --no-merge`, whose hold is the conductor's own and composes ahead
> of the lane rather than being declared in the file. Refusing rather than
> accepting it: an action that is silently absent is worse than a run that will
> not start.

```yaml
prepared:
  - name: approve
    human: Go?
```

> the "approve" action is a "human" at the "prepared" step, and `human:` does not
> implement `prepared` — it serves `proposed`: a hold at `prepared` cannot be
> answered — the run is released back to the queue and the question goes with it,
> so the item would re-claim, re-install and ask again on every pass. Ask before
> the claim with `lingtai ask`, or at `proposed`, where there is a diff to
> approve. Refusing rather than accepting it: an action that is silently absent is
> worse than a run that will not start.

```yaml
proposed:
  - name: approve
    human: Go?
    timeout: 10m
```

> the "approve" action is a "human" at the "proposed" step, and "human" declares
> no "timeout" field — what it declares is "name", "human". A plugin refuses a
> field it does not understand, rather than accepting it and ignoring it
> (0061 §9). Refused when the recipe resolves, before a worktree, before an agent,
> before any money.

All three are refused **when the recipe resolves** — before a worktree, before an
agent, before any money — and a refusal is a whole pass and not one action:
`conduct.ts` answers `stage: "recipe"` for every ticket while the file is illegal,
so a daemon restarted onto one takes nothing at all. `lingtai add` and
`lingtai doctor` both resolve without running anything, so you meet it before a
run rather than during one.

## Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b — `merge` has
  three ways out and **only `proposed` may send a pass to a person**. That is the
  rule this key's one step comes from, and the ADR's own open question already
  puts the approval, the glob and the tamper check at `proposed`.
- [0059](../decisions/0059-a-point-carries-only-the-kinds-it-runs.md) — a point
  carries only the kinds it runs, and `prepared` × `human:` is the cell it calls
  the subtlest and most expensive: a hold folded into a release asks an
  unanswerable question for ever.
- [0016](../decisions/0016-the-settled-model.md) §4 — an unconfigured gate is
  skipped and that is your call; **a gate that was configured and did not run is
  Lingtai's bug**. `#58` is that rule being broken at `merge`.
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 —
  legality is `humanPlugin.at` and there is no table beside it; §5 — absent and
  empty stay different, which is why `proposed: []` is written out.
- [0065](../decisions/0065-the-default-is-a-plugin.md) §6 — `merge: []` is
  *decided* to run nothing and does not yet, so it is not the way to stop merging
  unattended; §8 — the lane is the last action at `merge:`, which is what took
  this key off that step.
- `#58` — the failure: two changes merged with nobody's approval, because `merge:`
  was drawn and never built into a pipeline.
- `#20` — `--no-merge` and a pending repair became the `human:` action they always
  were, so there is one way to ask for a person rather than two.
- `#270` — gave `mergePlugin` the `merge` step, and took this key and `watch:`
  off it in the same diff.
- [reference.md](../reference.md) — the `human:` row in the plugin table, and the
  `ApprovalRequested` / `ApprovalGranted` event shapes.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
