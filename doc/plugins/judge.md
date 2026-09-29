# `judge:`

`judge:` answers *what now* when a step refused — one entry per direction, at
`proposed`, in place of the person the pass would otherwise stop for. The
failure it prevents is a pass parked with money already paid for it and nothing
spending it: `#267` and `#263` each refused at `review` with `rounds: 3` unspent
and cost $14.19 between them waiting for somebody to read the findings, and nine
passes in one night ended the same way. **It is also the only key on which two
legal values differ by a purchase** —
`judge: same-worktree` is a function and spends nothing, `judge: claude-code`
buys an agent every time that direction arrives — so the line below decides what
a refusal costs as well as where it goes.

## What it does

A pass that did not pass arrives at `proposed` carrying the reason the last step
gave (`ARRIVE_AT_THE_ROUTER` in
[`packages/conductor/src/pass.ts`](../../packages/conductor/src/pass.ts)), and
`judgeDeclaredAt` in
[`packages/conductor/src/judge.ts`](../../packages/conductor/src/judge.ts) takes
the one entry whose `when:` matches that reason. What it answers is **which
judge**, never which step: a built-in comes back as a name the pass applies
(`MECHANICALLY` in `pass-steps.ts`), and a runtime comes back as a runtime,
which `askTheAgent` in
[`packages/conductor/src/conduct.ts`](../../packages/conductor/src/conduct.ts)
dispatches — settings, run, read the answer, say what it cost. The prompt it is
given is `judgePrompt` in `judge-agent.ts`: what refused, the reviewer's findings
verbatim, the destinations on offer, and one JSON object back.

**A judge answers *which of these*, never *what may be spent*.** The offer is the
workflow's — `stepsOnOffer` reads `rounds` and `restarts`, counts what is spent,
looks at how far the pass got, and hands the judge the set
([0061](../decisions/0061-the-recipe-is-the-pipeline.md) §3). No ceiling reaches
the judge at all: `JudgeBrief` declares `rounds`, `roundsSpent`, `restarts` and
`restartsSpent` as `never`, so a judge cannot widen what it cannot see. An answer
outside the set is refused by name and the pass is held:

> the "the lines or the approach" judge answered "review" for `review`'s
> findings, and that is not one of the steps it was offered — "implement",
> "waiting". A judge chooses which of the offered steps is next; which steps are
> on offer is the workflow's, and it counts the rounds and restarts spent to work
> them out (0061 §3). The pass is held for a person, because a judge that
> answered outside the set is not one to ask a second time

That is `judged` in `pass-steps.ts`, and the fallback is a person rather than the
next cheapest step: a wrong answer costs one pass and stops.

**The two halves of the value are two kinds of decider and not two spellings.**
`isBuiltInJudge` is the whole of the test, read off `BUILT_IN_JUDGES` in one
place so that nothing else compares a name to `"same-worktree"` by hand:

| what you write | what answering costs |
|---|---|
| `judge: same-worktree` | nothing. It is a synchronous function — which is the *type* making the promise, because nothing that dispatches an agent can answer without awaiting. |
| `judge: claude-code` (or `codex`) | one dispatch, every time that direction arrives. `#277`'s first pass spent two of them at $0.41 each and landed the ticket with no person involved. |

Two things it does not do. It **declares no `rounds:` and no `restarts:`**, and
that is the safety property rather than an omission — a misconfiguration that
fails is cheap, and a judge that carried its own ceilings could answer *back to
`implement`* for ever at ~31 turns and ~$3.40 a round
([012 §3](../experiments/012-where-the-turns-go.md)) with nothing reporting a
fault. And it is **never asked for a set of one**: `waiting` is on every offer,
so a refusal at `admit` or `prepared` offers nothing else, and

> the "the lines or the approach" judge was not asked about this "findings":
> `waiting` was the only step on offer, and an agent paid to pick the only item
> on a list has judged nothing

## Where it may be declared

`proposed`, and nowhere else — which is `judgePlugin.at` in
[`packages/recipe/src/recipe.ts`](../../packages/recipe/src/recipe.ts) and the
whole of what makes the key legal anywhere
([0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4). It
opened there in `#274`; before that the plugin served no step at all.

**`judge:` is answered by kind before any step but `end`**, which is the one
inversion of `whyThatPair`'s usual order. Every other branch there says *what
this step asks of an action*, and a judge is not an action — it is asked once a
step has already decided — so the reason is the same at `prepared`, `build`,
`review` and `merge` alike, and it is the sentence the refusal prints:

> `proposed` is the only step that routes (0058 §3b), and a judge is asked there
> once about wherever the pass got to: a refusal at this step *travels* to it
> carrying its reason (`ARRIVE_AT_THE_ROUTER` in
> `packages/conductor/src/pass.ts`), so a `judge:` here would be a second router
> at a step that has not finished deciding what its own ending is. Written at
> `proposed` it is read — `proposed` takes the one entry whose `when:` matches
> the reason the last step gave, one judge per direction, and only the `findings`
> one is a judgement worth an agent — and **the workflow counts, the judge
> chooses** (0061 §3): the workflow reads `rounds` and `restarts`, works out which
> steps are on offer, and hands the judge that set. The set depends on how far the
> pass got and not only on what is left to spend, so a judge answers which of
> these and never what is legal, and one that returns a step it was not offered is
> refused by name.

`end` has its own sentence and it is the one that names this key: *"It is not
that they are the plugins with a `when:` field: `judge:` declares one too and
reads the reason the last step gave (`#238`), so what picks these three out is
the kind and never the shape."* Two steps, two vocabularies —
`close:` and `labels:` read the work item's **outcome**, a judge reads the
**reason** — and a value one of them does not know is refused by name.

### Five directions, and two of them already have an answer

This is the section to read before declaring anything, because a `judge:` written
at `red` or `verify-failed` is usually a line that changes nothing and an agent
there is money for a conclusion a `switch` reaches. `BUILT_IN_FOR` in `judge.ts`
is the table, and the counts are 0061 §3's fourteen days:

| `when:` | seen | with nothing declared | what a `judge:` is worth here |
|---|---|---|---|
| `red` | 34 | `same-worktree` — back to `implement` with the error, spending nothing | little. Declaring `judge: same-worktree` applies the same rule; what changes is the card, which then names your line rather than saying *a "red" is mechanical*. |
| `verify-failed` | 26 | `same-worktree`, the same fix on a moved base | the same. |
| `conflict` | 6 | a person | a judgement, but about the base rather than the diff. |
| `needs-input` | — | a person | a question somebody asked; answering it mechanically is answering it wrongly. |
| `findings` | 231 | a person | **the one 0061 §3 calls the judgement** — *the lines are wrong* and *the approach is wrong* are different work, and a `switch` cannot tell them apart from a findings array. |

Where nothing is declared and no built-in answers, the pass says so and stops:

> no `judge:` is declared for a "findings" and there is no built-in that answers
> one, so `review`'s findings is held for a person rather than the workflow
> choosing from "implement", "waiting" on its own (0061 §3)

An empty `proposed:` therefore behaves exactly as it did before this key existed
([0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §5:
absent is not empty), which is why `proposed: []` is a block a person can fill
rather than one they are waiting for.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. It is what the route's own sentence names — *the "the lines or the approach" judge* — so a refusal says which line of the recipe to edit rather than which built-in disagreed. Worth writing as the decision it makes. |
| `judge` | `same-worktree` \| `claude-code` \| `codex` | yes | Who decides. `JudgeName` is `BUILT_IN_JUDGES` and `RuntimeId` joined, and the two halves cost differently — see the table above. `ask-or-assume` from 0061 §3's own example is **not** in it, because nothing implements it: the enum says what the code does and grows when the code does. |
| `when` | `red` \| `verify-failed` \| `conflict` \| `needs-input` \| `findings` | yes, and **undefaulted** | The direction this entry answers. No default is the schema enforcing *one entry per `when:`*: no entry can answer for all five, so one judge cannot be paid sixty times to reach a mechanical conclusion. Where a file writes two for one direction the first wins, and neither is dropped quietly — both are in `StepsResolved` and on the board. |

**What it does not declare is the point of the table.** There is no `rounds:`
and no `restarts:` here, and writing either is refused by name. The two bounds
are universal keys on the steps they bound — `rounds` on `implement`, `restarts`
on `claim`, written today as `runtime.limits` — because a bound a judge can set
is not a bound.

## Examples

```yaml
# ~/.lingtai/lingtai/recipe.yml — the two mechanical directions, written out
proposed:
  - name: a red build is the agent's to fix, in the worktree it is already in
    judge: same-worktree
    when: red
  - name: a merge whose re-verify went red is the same fix on a moved base
    judge: same-worktree
    when: verify-failed
```

This machine's own file. Both are what `BUILT_IN_FOR` would have answered, so
declaring them buys no behaviour — it buys the sentence: a card that reads *the
"a red build is the agent's to fix" judge on … the recipe declares
`judge: same-worktree` for a "red"* instead of the default's *a "red" is
mechanical*. Written out rather than left absent for the reason `env: []` is,
one key over: this is the repository that has to be able to read its own policy
without opening its own source.

```yaml
# ~/.lingtai/lingtai/recipe.yml — the judge that stops `findings` reaching a person
proposed:
  - name: the lines or the approach
    judge: claude-code
    when: findings
```

The best example this page has, added 2026-09-28. Nine passes had parked at
`findings` in one night — `#267`, `#263` twice, `#268`, `#274`, `#247`, `#270`,
`#277`, `#269` — every one with `build` green in about thirty seconds and every
one refused by the cold reviewer, so the rounds the ceilings paid for went unspent
and each ticket cost a hand-landing. This buys one dispatch per arrival at
`findings` and spends a round when the answer is `implement`; `runtime.limits.rounds`
is what bounds it. The other two judgement directions are still a person's,
deliberately.

```yaml
# packages/conductor/test/one-pass.ts — `JUDGED`, with one round to spend
proposed:
  - name: the lines, until the rounds are spent
    judge: same-worktree
    when: findings
```

The same direction answered for free. A built-in is legal at `findings` and the
rule it applies is *back to `implement` where that is on offer, a person where it
is not* — which is a real policy for a repository whose reviewer files mostly
line-level findings, and it costs nothing. What it cannot do is tell *the lines
are wrong* from *the approach is wrong*, so it never asks for `claim`. `rounds: 1`
in the fixture is the shortest arrangement that shows both halves: the first
refusal buys the round, and the second has nothing left and reaches a person.

```yaml
# packages/conductor/test/one-pass.ts — `JUDGED_BY_AN_AGENT`, with two
proposed:
  - name: the lines or the approach
    judge: claude-code
    when: findings
runtime:
  agent: claude-code
  limits: { turns: 10, wall: 2m, rounds: 2, restarts: 0 }
```

The same entry as this machine's, and the `rounds: 2` beside it is the whole
reason the fixture is separate: two rounds means the judge is **dispatched twice
on one pass**, which is what a per-direction session id would collide on
(`#195`). `conduct.ts` counts the judgements and puts the count in the id. The
third arrival is left with `waiting` as the only step on offer, and nothing is
dispatched for a set of one.

## What it refuses

Every one of these is refused when the recipe resolves — so `lingtai add` and
`lingtai doctor` say it without running anything, and a daemon restarted onto the
file takes no ticket at all.

```yaml
build:
  - name: the lines or the approach
    judge: claude-code
    when: findings
```

> the "the lines or the approach" action is a "judge" at the "build" step, and
> `judge:` does not implement `build` — it serves `proposed`: `proposed` is the
> only step that routes (0058 §3b), and a judge is asked there once about
> wherever the pass got to: a refusal at this step *travels* to it carrying its
> reason (`ARRIVE_AT_THE_ROUTER` in `packages/conductor/src/pass.ts`), so a
> `judge:` here would be a second router at a step that has not finished deciding
> what its own ending is. … Refusing rather than accepting it: an action that is
> silently absent is worse than a run that will not start.

```yaml
proposed:
  - name: the lines or the approach
    judge: claude-code
```

> the "the lines or the approach" action is a "judge" at the "proposed" step, and
> its "when" field is not what "judge" accepts: Invalid option: expected one of
> "red"|"verify-failed"|"conflict"|"needs-input"|"findings". Refused when the
> recipe resolves, before a worktree, before an agent, before any money.

Required and undefaulted, so an omitted `when:` is the same refusal as a
misspelled one. There is no entry that answers every direction.

```yaml
proposed:
  - name: the lines
    judge: ask-or-assume
    when: findings
```

> the "the lines" action is a "judge" at the "proposed" step, and its "judge"
> field is not what "judge" accepts: Invalid option: expected one of
> "same-worktree"|"claude-code"|"codex". Refused when the recipe resolves, before
> a worktree, before an agent, before any money.

`ask-or-assume` is in 0061 §3's own yaml example and is refused here, which is
the enum doing its job: a name the schema accepts and no code answers is `#61`
arriving through the one door this repository has decided it will not leave open.

```yaml
proposed:
  - name: the lines
    judge: claude-code
    when: findings
    rounds: 5
```

> the "the lines" action is a "judge" at the "proposed" step, and "judge" declares
> no "rounds" field — what it declares is "name", "judge", "when". A plugin
> refuses a field it does not understand, rather than accepting it and ignoring it
> (0061 §9). Refused when the recipe resolves, before a worktree, before an agent,
> before any money.

One refusal on this page is not the schema's, and it is worth knowing it exists:
a **runtime** `judge:` naming a runtime this conductor does not dispatch is
refused before the claim by `agentRefusal` in `conduct.ts` — *`steps.proposed`'s
"the lines" action names judge codex, and this conductor runs claude-code*. One
conductor dispatches one runtime, so `judge: codex` on a Claude Code conductor
would have its judgement bought from the wrong model with nothing anywhere saying
so. A built-in names no runtime and is passed over: `isBuiltInJudge` is the whole
of that test.

## Related

- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §3 — **`judge:` decides
  which step is next. The workflow decides which steps it may choose from.** It
  names the five directions, measures them, and is the argument for both the
  split and the built-in.
- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b — `proposed`
  is the only step that routes, and only `proposed` may send a pass to a person.
  That is why this key serves one step.
- [0038](../decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
  §2 — a refusal carrying nothing an agent could be held to buys no round, which
  is the rule that takes every step but a person off the offer before a judge is
  asked at all.
- [0040](../decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) — rounds
  are depth and restarts are breadth, which is what makes `claim` safe to put in
  front of a judge and `rounds:` unsafe to put in this plugin.
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 —
  legality is `judgePlugin.at` and there is no table beside it; §5 — `proposed: []`
  is written out, and absent is not empty.
- [the-plugin-body.md](../design/the-plugin-body.md) §5 — where a runtime judge's
  `Runtime` and prompt live, and *code, restart, paste*: a `judge:` naming a
  plugin the running daemon's copy does not serve is refused every pass.
- `#274` — made the entry legal at all, opening `judgePlugin.at.proposed`.
- `#277` — made a runtime a legal name, so `findings` is a line in the recipe
  rather than a person's every time.
- [`plugins/index.md`](index.md) — the thirteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
