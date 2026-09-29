# `agent:`

`agent:` buys a model a turn in this pass's worktree, and it is **one of the two
keys in a recipe that spend money** — since `#277` a `judge:` naming a runtime
rather than a built-in is the other, and `agentRefusal` (`conduct.ts`) holds both
to the dispatched runtime alike, so an audit of what a recipe costs reads both
keys. **The three fields are the same wherever it is written and the job is
not**: at `design` it drafts a document before any code
exists, at `implement` it writes the change, and at `review`, `proposed` and
`merge` it reads a diff it did not write. The failure the last of those prevents
is the one this action was built for and measured on — an agent that has spent
eighty-nine turns committing to an approach is not a second opinion about that
approach. [Experiment 001](../experiments/001-cold-review-issue-58.md) is what
that costs: four defects survived self-review, a `verify.sh`, CI and a full human
read, merged, and were filed hours later by the same agent against its own code;
a reviewer given only the issue and the diff found all four in a single finding,
plus two nobody had found.

## What it does

**One key, three actions, and the step is what picks between them** —
`actionsFromRecipe` in
[`packages/actions/src/from-recipe.ts`](../../packages/actions/src/from-recipe.ts),
which is the seam that knows the step; the actions themselves know only what
they were handed.

| declared at | what is built | what it is handed | what it leaves |
|---|---|---|---|
| `design` | `createDraftAction` | the ticket and the worktree, with nothing committed | a document, or nothing, or one question |
| `implement` | `createWorkAction` | the dispatch `conduct.ts` already runs — the hook wired, the socket served | **a commit**, which is the step's receipt ([0057](../decisions/0057-a-gate-that-did-not-finish.md) §2) |
| `review` `proposed` `merge` | `createAgentAction` | the ticket, the diff `base...head`, the worktree | **findings**, and a verdict the step may or may not read |

The first and third are in
[`packages/actions/src/agent-action.ts`](../../packages/actions/src/agent-action.ts);
the second is `work-action.ts` beside it, which **wraps and does not
reimplement** — the dispatch, the receipt and the fix round are `conduct.ts`'s
and have been since before the key existed.

**Cold is the whole mechanism of the reviewer, and it is fragile.** It gets the
issue text, the diff and the worktree, and it does not get the implementer's
plan, transcript or session. `sessionIdFor` is a function of the run id, so
handing this the run's own id would resume the implementer's session and quietly
destroy the only property that matters — the review id is
`<runId>:review:<name>:<sha>`, with the head in it so that each fix round's
review is a different reviewer rather than one asked whether it still agrees with
itself.

**Three things are fixed in the code rather than left to the recipe**, because
experiment 001 measured each of them going wrong: the severity rubric (silent
corruption is a `blocker`, not a `major`), the rule that a finding without a
failure scenario is an opinion and is **dropped rather than repaired**, and the
checklist that names concurrency and check-then-write first. A recipe's `prompt`
is **appended to that, never substituted for it** — the rule all three actions
follow, so a project can add what it cares about and cannot remove the ticket,
the rubric or the round it is in.

**What it returns differs by step, and that is the whole of it.** At `review` a
`failed` is its findings and not a verdict about the step: `pass.ts:1734` reads
`if (spec.step === "review") return { ending: "passed" }` whatever the action
said ([0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3b), and
the findings ride out on `results` for `proposed` to route on. At `implement` the
receipt is a commit and nothing else — a document committed there would not do,
which is why `firstDispatch` measures the receipt against the head *this* agent
found rather than against `tree.baseSha` (`#265`). At `design` what it returns is
a document, and **what it writes into the tree is not the document**: the prompt
asks it not to edit a file, not to run a command that writes one and not to
commit, and that asking is the only thing between a drafting agent and the
branch. `firstDispatch`'s one line narrows what ignoring it costs rather than
undoing it — a design commit can no longer be read as the implementer's receipt,
so a pass that drafted and wrote no code still stands down (0057 §2) — and **the
commit itself stays**: nothing resets the worktree between the two steps, so a
`doc/design/foo.md` committed at `design` travels to `build` and `review` and
lands with the change, and a file left uncommitted is there for the implementer to
stage. So if a drafting agent's tree writes matter here, what catches them is a
`watch:` on those paths at `proposed` or the cold reviewer reading them in the
diff — never that guard, which is about the receipt.

**An answer that does not parse is `unreadable`, and it costs nothing either
way** (`#279`). A reviewer whose JSON cannot be read and a reviewer with nothing
to say both returned `findings: []` and reached `proposed` as the same shape;
`#269`'s third review said four things, one a `major` with a failure scenario,
and stopped one closing brace short of valid JSON — the pass parked as though the
reviewer had held an opinion, and 61 turns and $8.97 went with it. The flag is
what a log can be asked and a sentence is not, so a person is handed *the
machinery lost a judgement* rather than an opinion, and no round is bought: an
answer nobody can read is not a criterion
([0038](../decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2).
At `design` the same word covers an answer that opened a `question` fence and
never closed it.

**It carries no clock of its own**, which is the one thing a reader coming from
`run:` will look for and not find — see the parameters below.

## Where it may be declared

`design` · `implement` · `review` · `proposed` · `merge` — which is
`agentPlugin.at` in
[`packages/recipe/src/recipe.ts`](../../packages/recipe/src/recipe.ts) and the
whole of what makes the key legal anywhere
([0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4).
Five steps and three jobs, and **the board got this wrong in prose until
`#266`**: `describeAction` called every `agent:` *a cold reviewer*, including the
one at `implement`, so the task page told a reader that the agent writing the
change was reading it. It takes the step as an argument now, and answers *an
agent* rather than guessing where it is not given one.

**Where it is written decides what a refusal costs**, and that is the reason to
read this section rather than pick whichever step reads best:

| a refusing `agent:` at | what the pass does with it |
|---|---|
| `design` | `design` is not one of `REFUSING_STEPS`, so `endingOf` reports `did-not-finish` and **no round is bought**. A *question* is different and is its own ending since `#296`: `because: NEEDS_INPUT` on the result is the last place that token is compared to anything — `runActionPipeline` reads it, answers `askedAt` and appends `StepAsked`, and the step ends `asked`, which reaches `proposed` as the `needs-input` direction. `BUILT_IN_FOR` has no answer there, so a person holds it unless a recipe declared a judge for it. |
| `implement` | the same rectangle — `implement` cannot refuse either. It passes with a commit, ends `asked` with the question, or leaves no receipt and stands the pass down (0057 §2). |
| `review` | the step ends `passed` whatever it said, and the findings travel. `proposed` then has a `findings` direction to route — **which is the point of declaring it here**. The pipeline stops at the first action that did not pass, so a second reviewer written after this one is not asked about a diff the first already has findings on. |
| `proposed` | `proposed` is one of `REFUSING_STEPS`, so it refuses **on its own behalf** — and `ARRIVE_AT_THE_ROUTER` does not carry `proposed`, so there is nowhere to appeal to. The outcome is `blocked` and a person is asked. **No round bought.** |
| `merge` | it arrives, and `directionOf` reads the step's ending: an action that refused says `action-refused`, which is not a direction any `judge:` answers, so the pass is held for a person. **No round bought.** |

That table is why the cold reviewer moved from `proposed:` to `review:` on
2026-09-27 (`a417908`): the same reviewer, the same prompt, and a refusal that
went from *`proposed` says no* to *`proposed` is asked what to do about this*.

The five steps it may not be declared at each have a sentence, and it is the
sentence the refusal actually prints (`whyThatPair`, same file). `build` is the
one a person reaches for:

> `build` is the independent build of what was written (0058 §3), and what it
> asks of an action is a command's exit code — `run:` is the one plugin declared
> there, and none of the other three builds anything. An agent asked to would be
> paid to read, and a cold read of the diff is `review`; a glob over the diff's
> file list and a hold on it are questions about a change already built, which is
> `proposed`.

`prepared` is the step whose sentence `whyThatPair` answers by the *kind* of the
action rather than by the step — `agent:` gets one, `watch:` the one written
directly beside it, and everything else the general one about a hold that cannot
be answered. (It is not the only kind-answered branch in the function: `judge:`,
`merge:`, the `merge` × `human`|`watch` pair and the three effects are all
answered by kind, above the step branches — but **below `end`**, which is the
function's first branch and so answers every kind at that step, `judge:` and
`merge:` included, with `end`'s own sentence — the one at the foot of this
section. Changing what a misplaced
`judge:` is told is therefore two edits and not one, and
`conductor/unit/step-matrix.test.ts` walks the `end` × `judge` cell that says so.)
This key's is:

> nothing has been committed at `prepared`, so a cold reviewer would be given no
> diff to read

`claim` and `admit` say their own version of the same thing — nothing has been
claimed or cut, so there is no diff to read and no worktree to read it in. `end`
is the one that is different in kind: it *"fires on every terminal outcome and
produces no verdict, so the only actions it can carry are the three that run for
effect"*.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. It is on the card, in `StepsResolved`, in the run log's `review` note and in the refusal when something about this entry is wrong. |
| `agent` | `claude-code` or `codex` | yes | **The runtime, not the prose** — `RuntimeId` in `packages/domain/src/events.ts`, which is a `z.enum` and not a string (0063 §2, `#245`). |
| `model` | string | no — **the runtime's own default** | Handed to the runtime as-is. Lingtai keeps no table of what each runtime defaults to, so it is passed through *absent* rather than resolved to a name here, and it is **not validated**: the legal model names are the runtime's to know, and a stale allowlist would refuse a model that works. |
| `prompt` | string | yes | What this project wants looked for, appended to the fixed brief. It cannot remove the rubric, the checklist, the failure-scenario rule, the ticket or the diff. |

**The enum on `agent` is the whole safety of the field rather than a style
choice.** A `z.string()` here would take the paragraph of prose a file written
before `#245` puts under `agent:`, parse it cleanly, and hand it on as the *name
of a runtime* — failing at spawn, in a worktree, a long way from the line that is
wrong.

**And a legal name is not yet a true one.** One conductor dispatches one runtime
and hands it to every step, so a value here that is not the dispatched one cannot
be honoured: `agentRefusal` in `packages/conductor/src/conduct.ts` reads **every**
`agent:` in the file, not `runtime.agent` alone, and refuses the recipe before the
claim —

> steps.review's "review" action names agent codex, and this conductor runs
> claude-code

— naming the step, the action and the key, because *which* `agent:` is wrong and
*which file to open* are one fact. Per-step dispatch is not built; until it is,
the only honest answer to a second runtime named at a step is to say so.

**There is no `timeout:`, and that is the field a reader arriving from
[`run:`](run.md) will look for.** What bounds an agent is `runtime.limits` —
`turns` and `wall` — which is a recipe-wide setting and not this plugin's:
`limitsFor` in `packages/recipe/src/settings.ts` takes a step and ignores it, so
every agent at every step gets the same ceiling today. The board says so in as
many words rather than inventing one: `describeAction` returns `no timeout in
the recipe`. What a *refusal* may buy is `runtime.limits.rounds`, counted at
`proposed`.

`diff` is the other number an agent at `review`, `proposed` or `merge` spends and
does not declare: `runtime.budget.diff` is where the diff is clipped
([0029](../decisions/0029-the-prompt-budget-is-the-recipes.md)), and above it the
diff is truncated rather than sent whole — a diff far past it is a work item that
was scoped too large, and sending a megabyte to a reviewer produces a worse
review rather than a better one.

## Examples

```yaml
# packages/conductor/test/one-pass.ts — the `DRAFTED` fixture
design:
  - name: draft
    agent: claude-code
    prompt: say what shape this takes
```

The drafting job, and **the only way the step does anything**: `conduct.ts`'s
`defaultsAt` has no row for `design`, so an unconfigured one runs nothing and
briefs `implement` with `""` — every pass, as every pass already did. A default
here would buy an agent on every pass of every project whose recipe never
mentioned the step, which is 0065 §7's footgun rather than §2's decision.

```yaml
# ~/.lingtai/lingtai/recipe.yml — this machine's own cold reviewer, with the
# six shapes under `prompt:` elided
review:
  - name: review
    agent: claude-code
    prompt: |
      This is an event-sourced scheduler that schedules its own development.
      Six shapes have produced real defects here. Look for them as well as the
      checklist above.

      1. **A comment that was true when it was written and is false now.**
         ...
```

The reading job, at the step where a refusal **travels**. Everything under
`prompt:` is what *this* repository keeps getting wrong — a stale comment, a
check that is not looking at what its name claims, a projection that is not a
pure fold — and none of it is the rubric or the checklist, which are in
`agent-action.ts` and cannot be removed from here. It is the **only** entry at
its step in the file it comes from, and nothing else could be written ahead of it
there: `runPlugin.at` is `prepared`, `build`, `proposed`, `merge`, and `agent:`
is the only plugin whose `at` carries `review`. What keeps a diff that does not
compile from being paid to be reviewed is therefore not entry order but the step
order — `build` comes before `review` in `Step`
([`packages/domain/src/events.ts`](../../packages/domain/src/events.ts)) and is
one of `REFUSING_STEPS`, so a red build refuses there and the pass never arrives
here.

```yaml
# packages/conductor/test/one-pass.ts — the `REVIEWED` fixture
proposed:
  - name: review
    agent: claude-code
    prompt: look for races
```

The same action, one step later, deciding something different: here a refusal is
`proposed` refusing on its own behalf, with nowhere above it to appeal to and no
round bought. This is where this repository's reviewer was declared until
2026-09-27, and moving it is the whole of `a417908`.

```yaml
# packages/conductor/test/one-pass.ts — the `JUDGED_BY_AN_AGENT` fixture
review:
  - name: cold reviewer
    agent: claude-code
    prompt: look for races
proposed:
  - name: the lines or the approach
    judge: claude-code
    when: findings
```

What the findings are *for*, and the shape this machine's recipe took on
2026-09-28. `findings` is the one direction with no built-in answer, so without
the `judge:` beside it a refused review parks at `waiting` with the round unspent —
nine passes did that in one night, every one with `build` green in about thirty
seconds. The judge is a second purchase and is `judge:`'s business rather than
this page's; what belongs here is that a reviewer declared at `review:` is the
only thing that puts a `findings` arrival in front of one.

**There is no fifth block, because no recipe on this machine declares an
`agent:` at `implement`** — and that is the default doing its job rather than a
gap. `conduct.ts`'s `defaultsAt` has a row for the step:

```ts
return [createWorkAction({ name: "write the change", prompt: "" }, { work: dispatch })];
```

Unlike `design`, this row is not optional: the port it replaced dispatched on
every pass, so *behaves exactly as it does today* means an unconfigured
`implement` still buys the one agent — on `runtime.agent`, which is what
`dispatch` runs and what a recipe's own `agent:` is held to by `agentRefusal`
before the claim. `prompt: ""` because the implementer's brief is rendered from
the ticket and the design, and a recipe's `prompt:` is appended to that: the
default adding nothing is the default changing nothing. A recipe that declares
one replaces this row, which is 0065 §2's substitution rule and the reason the
block above is safe to paste and safe not to paste.

## What it refuses

Every one of these is refused when the recipe resolves — so `lingtai add` and
`lingtai doctor` say it without running anything, and a daemon restarted onto the
file takes no ticket at all.

```yaml
build:
  - name: review
    agent: claude-code
    prompt: look for races
```

> the "review" action is a "agent" at the "build" step, and `agent:` does not
> implement `build` — it serves `design`, `implement`, `review`, `proposed`,
> `merge`: `build` is the independent build of what was written (0058 §3), and
> what it asks of an action is a command's exit code — `run:` is the one plugin
> declared there, and none of the other three builds anything. An agent asked to
> would be paid to read, and a cold read of the diff is `review`; a glob over the
> diff's file list and a hold on it are questions about a change already built,
> which is `proposed`. Refusing rather than accepting it: an action that is
> silently absent is worse than a run that will not start.

```yaml
prepared:
  - name: review
    agent: claude-code
    prompt: look for races
```

> the "review" action is a "agent" at the "prepared" step, and `agent:` does not
> implement `prepared` — it serves `design`, `implement`, `review`, `proposed`,
> `merge`: nothing has been committed at `prepared`, so a cold reviewer would be
> given no diff to read. Refusing rather than accepting it: an action that is
> silently absent is worse than a run that will not start.

```yaml
review:
  - name: review
    agent: claude-code
    prompt: look for races
    timeout: 20m
```

> the "review" action is a "agent" at the "review" step, and "agent" declares no
> "timeout" field — what it declares is "name", "agent", "model", "prompt". A
> plugin refuses a field it does not understand, rather than accepting it and
> ignoring it (0061 §9). Refused when the recipe resolves, before a worktree,
> before an agent, before any money.

```yaml
review:
  - name: review
    agent: gpt-5
    prompt: look for races
```

> the "review" action is a "agent" at the "review" step, and its "agent" field is
> not what "agent" accepts: Invalid option: expected one of
> "claude-code"|"codex". Refused when the recipe resolves, before a worktree,
> before an agent, before any money.

A runtime this conductor is not dispatching is a *legal* name and is refused one
layer later, by `agentRefusal` and before the claim rather than at resolve — see
the parameters above.

## Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3, §3b, §3c —
  the ten steps, which four of them may refuse, and which three may end by
  asking. It is what makes the cost table above true, and why a reviewer's
  `failed` at `review` is findings rather than a verdict.
- [0038](../decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
  — a finding buys an agent before it buys your attention, which is why the same
  action re-runs on the head a fix produced and why an unreadable answer buys
  nothing.
- [0031](../decisions/0031-a-run-that-never-started.md) §1, §3 — a run that never
  started is about the account and not about the diff, and the classification is
  the adapter's rather than a second reading at this seam.
- [0057](../decisions/0057-a-gate-that-did-not-finish.md) §2 — a gate that did
  not finish has judged nothing, and `implement`'s receipt is a commit.
- [0063](../decisions/0063-every-setting-is-the-recipes.md) §2 — the recipe
  chooses the runtime, which is why `agent:` is a `RuntimeId` and the prose moved
  to `prompt:`.
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 —
  legality is `agentPlugin.at` and there is no table beside it.
- [0065](../decisions/0065-the-default-is-a-plugin.md) §1, §4, §5 — the default
  is a plugin, which is how `implement` and `design` became keys a recipe can
  write; §5 is why one key builds three actions rather than one that would pass
  on an empty diff.
- [experiment 001](../experiments/001-cold-review-issue-58.md) — the measurement
  the cold reviewer exists on.
- `#265` — `design` opened, and a drafting agent's commit cannot stand in for the
  implementer's receipt.
- `#266` — `implement` opened, closing 0065 §1's asymmetry; and the board stopped
  calling every `agent:` a cold reviewer.
- `#279` — an answer that cannot be read has its own word, because *the machinery
  lost a judgement* and *the reviewer had an opinion* must not park the same way.
- [`plugins/index.md`](index.md) — the twelve, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
