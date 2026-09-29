# `run:`

`run:` runs one command in the worktree and takes its exit code as the verdict —
zero passes, anything else refuses. It is **the extension point that needs
nothing declared**, so every check Lingtai does not make itself is written as one
of these. A plugin needs a declaration — a key, its fields, the steps it serves —
and today every one of those lives in `PLUGINS`;
[0067](../decisions/0067-a-plugin-is-a-declaration-and-an-implementation.md) is
what lets one come from elsewhere, with the code still a subprocess. The failure it prevents is the one an agent cannot
see from inside its own turn: a change that satisfies the ticket and breaks the
build, landing on the base branch because nothing between the agent and `main`
ever compiled it.

## What it does

The work is `createProcessAction` in
[`packages/actions/src/process-action.ts`](../../packages/actions/src/process-action.ts),
and it is a translation and nothing else — from *a command ended* to *a verdict
about a commit*. The spawning is `runCommand` in `command.ts` beside it: through
a shell, so a recipe may write `pnpm typecheck && pnpm test` and splitting that
correctly is nobody's problem; `cwd` is the worktree this pass cut and never
anywhere else; and the child's environment is exactly what the action declared,
plus the six variables a process needs in order to be a process.

What comes back is a verdict and evidence. `pnpm test exited 0 in 41.2s` on a
pass; on a failure, the exit code, how long it took, and the log — terminal
escapes stripped at capture
([0043](../decisions/0043-evidence-is-plain-text.md)), the last 60 lines kept
and capped at 8 000 bytes, with whole lines from the top **on top of that cap
rather than out of it** (`#171`) — up to a quarter of it again, then the line
counting what was elided between, so the payload bound is 8 000 bytes and a
quarter. That bound is not only the card's: the fix prompt quotes the same
evidence and `budget.evidence` is counted in it. A timeout is a distinct outcome
inside `runCommand` — `SIGTERM`, `SIGKILL` five seconds later, evidence that
opens `timed out after 20m` — and the same verdict out here: `failed`, exactly as
a non-zero exit. The difference survives in what a person reads, not in what the
pass does.

**It reports and it finds nothing.** `findings: []` is returned literally. A
`run:` cannot say *this line is wrong, and here is the scenario it fails under* —
that is what an `agent:` is paid for — so a refusal from one carries its output
and no structure. And it does not decide what happens next either: where a
refusal goes is the **step's**, which is the next section and is the thing worth
knowing before writing one.

## Where it may be declared

`prepared` · `build` · `proposed` · `merge` — which is `runPlugin.at` in
[`packages/recipe/src/recipe.ts`](../../packages/recipe/src/recipe.ts) and the
whole of what makes the key legal anywhere
([0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4).
Four steps, and they are four different jobs: `prepared` is setup that must
happen before an agent runs, `build` is the independent build of what was
written, `proposed` is a question about a change already built, and `merge` is a
check on the way into the base branch — since `#270`, **before** the lane and
never after it.

**Where a command goes changes what a red one costs**, and that is the reason to
read this section rather than pick whichever step reads best. A refusal at seven
of the ten steps arrives at `proposed`, the router, carrying its reason
(`ARRIVE_AT_THE_ROUTER` in `packages/conductor/src/pass.ts`); `directionOf` in
`pass-steps.ts` names which of the five directions it is, and only two of them
are answered without a person:

| a red `run:` at | what the pass does with it |
|---|---|
| `prepared` | arrives at `proposed` as `red` — *a command said no … `prepared`'s install, which is the same kind of evidence one step earlier* — and the built-in `same-worktree` judge asks for `implement` and does not get it. `onOffer` offers that step only from `implement` and after it (`AFTER_AN_AGENT` in `pass.ts`, which leaves `prepared` off: *a failed install refuses before any agent has run, so there is no diff and no error in one to fix*), so the mechanical answer falls to its `orElse`, the outcome is `blocked`, and a person is asked. **No round bought** — and no ceiling to raise either, because `implement` is off `reachable` as well as `affordable`. |
| `build` | the same direction, and here the judge gets what it asked for: `build` is after an agent, so `implement` is on offer and the refusal goes back to it with the error. **A fix round**, and this is the one everybody copies. |
| `proposed` | nothing. `proposed` is the router, and `ARRIVE_AT_THE_ROUTER` does not carry it — *a visit that did not pass there has nowhere above it to appeal to* — so the walk stops, the outcome is `blocked`, and a person is asked. **No round bought.** |
| `merge` | arrives, and `directionOf` reads `merge`'s ending for the lane's own words: an action that refused says `action-refused`, which is *not a direction any `judge:` answers*, so the pass is held for a person. **No round bought.** |

**`build` is the only one of the four where a red command buys a fix round**, and
that is `#256`'s lesson and why the step exists as somewhere to write a command at
all. A `run:` was legal at three of them before it — `prepared`, `proposed` and
`merge`, which is what `runPlugin.at` carried until `a417908` added the fourth, so
the install above is older than `build` and was never what the move was about.
What had nowhere to go was a check on what an agent had *written*: of the three,
`proposed` was the only step after `implement`, and the five gate points the old
engine had bought a round where the router does not — so the same `pnpm test`,
unmoved, stopped costing one fix and started costing a person. **A check that the
diff is expected to be able to satisfy belongs at `build`.** `prepared` is for
what must be true before an agent starts, `proposed` for a question whose answer
is *somebody decide*, and `merge` for one whose answer is *do not land this* — and
a red one at any of the three is a person's.

The six steps it may not be declared at each have a sentence, and it is the
sentence the refusal prints (`whyThatPair`, same file). `review` and `implement`
are the two a person reaches for:

> `review` returns findings and judges nothing (0058 §3b) — `pass.ts` makes its
> ending `passed` whatever the action said, so a verdict declared here is one the
> step throws away, and `agent:` is the only plugin that answers with findings
> rather than with a verdict. A command that decides whether the diff stands is a
> `run:` at `build`; a glob over it or a hold on it is `proposed`'s.

> `implement` is the change itself (0058 §3), so the only plugin it carries is
> the one that writes one — `agent:`, which is the key `agentPlugin` declares
> there, and at this step it implements rather than reads. The step's own receipt
> is a commit (0057 §2), which is what none of the other three can leave: a
> command that checks what was written is `build`, a cold read of it is `review`,
> a glob over its file list and a hold on it are questions about a change already
> made, which is `proposed`.

`claim`, `admit` and `design` say their own version of the same thing — there is
no ticket, no worktree, or no diff yet, so a command has nothing to run in or
nothing to run against. `end` is the one that is different in kind: it *"fires on
every terminal outcome and produces no verdict, so the only actions it can carry
are the three that run for effect"*. That is also why `runPlugin.at` is four keys
written out rather than `"*"`: `end` runs no pipeline, and a cell the schema
accepts and the step throws out is `#61` with the throw in a different file.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. It is on the card, in `StepsResolved` and in the refusal when something about this entry is wrong, so it is worth writing as a sentence — `a red build is the agent's to fix` reads better on a board than `build`. |
| `run` | string | yes | The command. Run through a shell, in the worktree, so `&&`, pipes and quoting are yours. Its exit code is the verdict and there is no other channel: a command that exits 0 on failure has told the pass it passed. |
| `timeout` | duration string | no — `15m` | `30s`, `15m`, `2h`, which is `parseDuration`'s shape. Reaching it kills the command and refuses the step exactly as a non-zero exit would, and the evidence says which. **The schema takes it as a string and does not check the shape**: `parseDuration` is what reads it and throws `"soon" is not a duration like 30s, 15m or 2h` where the action is built, which is inside the pass. It is the one thing on this page a resolve does not refuse, and `lingtai doctor` catches it all the same — `stepPlan` parses every `run:`'s timeout on the way to the `recipe: resolves for every project` row, so a typo is a red row there rather than a throw in a pass somebody paid for. |
| `env` | list of strings | no — `[]` | The **names** of the variables this command's process is given — never the values, so the recipe stays safe to read. |

`env` is the field that makes this more than a shell line, and it is worth the
paragraph: **absent means nothing, not everything**
([0037](../decisions/0037-an-extension-is-a-command.md) §1). An action that
declares nothing gets only `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER` and
`LOGNAME` — `RUNNABLE` in `@lingtai/agent-env`, which is how a binary is found
rather than a credential. A name it does declare is looked up in
[0021](../decisions/0021-the-recipe-decides-the-environment.md)'s two files
merged, the project's `~/.lingtai/env/<project>.env` over the machine's own, and
**before** `env.allow` and `env.deny`: those decide what reaches the *agent*,
which is a different consumer, and answering one with the other is how a `deny`
written about an agent would quietly become a rule about a Telegram bot. A
declared name this machine holds no value for is reported as missing rather than
silently absent; a value whose host looks like production refuses the run before
it claims anything; and a `LINGTAI_*` name is refused where it is written.

## Examples

```yaml
# ~/.lingtai/lingtai/recipe.yml — the install, at `prepared`
prepared:
  - name: install
    run: pnpm install --frozen-lockfile
    timeout: 10m
    env: []
```

`git worktree add` copies no `node_modules`, so without this the agent is handed
a checkout where it cannot run the repository's own tests. It is at `prepared`
and not later because the later point fixed the gate and left the agent holding
an empty worktree.

```yaml
# ~/.lingtai/lingtai/recipe.yml — the build, at the step named after it
build:
  - name: build
    run: pnpm typecheck && pnpm test
    timeout: 20m
    env: []
```

The shape this page is arguing for. `pnpm test` is the unit half and not the
whole suite ([0060](../decisions/0060-the-gate-runs-unit-tests.md)), so a red
here is a claim about the diff rather than about the network; `env: []` is
written out rather than left to default, because this is the repository that has
to be able to read its own policy without opening its own source.

```yaml
# packages/recipe/src/presets.ts — the `pnpm-workspace` preset
proposed:
  - name: build
    run: pnpm typecheck && pnpm lint && pnpm test
    timeout: 15m
    env: []
```

What a repository nobody has thought about yet is handed. It is deliberately
*not* the entry above: where this repository puts its own build and what a preset
gives a project on its first day are separate decisions, and moving this one
would rewrite the first recipe of every project onboarded after it. A project
adopting the preset and then wanting the fix round buys it by moving these four
lines to `build:`.

```yaml
# packages/conductor/unit/pass.test.ts — the checks, then the thing that lands
merge:
  - name: verify
    run: pnpm typecheck
  - name: land it
    merge:
      strategy: merge-commit
```

The order is the rule and not the style: the lane is the last action a step
carries, so a check that must gate the merge goes above it. A written `merge:`
must contain a lane at all — `merge: []` is the omitted key and still merges, but
a step with one `run:` and nothing that lands is refused.

## What it refuses

Every one of these is refused when the recipe resolves — so `lingtai add` and
`lingtai doctor` say it without running anything, and a daemon restarted onto the
file takes no ticket at all.

```yaml
review:
  - name: build
    run: pnpm test
    env: []
```

> the "build" action is a "run" at the "review" step, and `run:` does not
> implement `review` — it serves `prepared`, `build`, `proposed`, `merge`:
> `review` returns findings and judges nothing (0058 §3b) — `pass.ts` makes its
> ending `passed` whatever the action said, so a verdict declared here is one the
> step throws away, and `agent:` is the only plugin that answers with findings
> rather than with a verdict. A command that decides whether the diff stands is a
> `run:` at `build`; a glob over it or a hold on it is `proposed`'s. Refusing
> rather than accepting it: an action that is silently absent is worse than a run
> that will not start.

```yaml
build:
  - name: build
    run: pnpm test
    model: opus
    env: []
```

> the "build" action is a "run" at the "build" step, and "run" declares no
> "model" field — what it declares is "name", "run", "timeout", "env". A plugin
> refuses a field it does not understand, rather than accepting it and ignoring
> it (0061 §9). Refused when the recipe resolves, before a worktree, before an
> agent, before any money.

```yaml
build:
  - name: build
    run: pnpm test
    env: [LINGTAI_DATABASE_URL]
```

> the "build" action is a "run" at the "build" step, and its "env" field is not
> what "run" accepts: "LINGTAI_DATABASE_URL" is one of Lingtai's own names and
> cannot be declared for an extension — every name Lingtai reads for itself
> begins "LINGTAI_" (#63), and an extension's code is not trusted with them (0037
> §1). A project's own variable keeps its own name.

```yaml
merge:
  - name: land it
    merge:
      strategy: merge-commit
  - name: smoke
    run: pnpm smoke
    env: []
```

> the "smoke" action is a "run" at the "merge" step, and the "merge" step lands
> the branch at entry 0, and the lane is the last action a step carries. This one
> is written after it, so it would run on a change already on the base branch —
> and a verdict it gave there would report the step refused while the merge
> stood, leaving the diff landed and the ticket blocked. Write it before the
> lane.

## Related

- [0037](../decisions/0037-an-extension-is-a-command.md) — *there is no plugin
  system; an extension is a command*, which is why this is the one key that
  declares an `env:` and the one whose code is not trusted.
- [0021](../decisions/0021-the-recipe-decides-the-environment.md) — the recipe
  decides the environment, in layers with different owners. `env:` here is its
  second consumer rather than a second mechanism.
- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §2, §3b — the
  ten steps, which four of them may refuse, and the drawing that sends a refusal
  to `proposed`. It is what makes the cost table above true.
- [0060](../decisions/0060-the-gate-runs-unit-tests.md) — the gate runs the unit
  tests and the integration half runs after the merge, which is why
  `pnpm test` at `build` is the example everybody copies.
- [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §9 — a plugin owns its
  schema and refuses a field it does not understand.
- [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 —
  legality is `runPlugin.at` and there is no table beside it.
- [0065](../decisions/0065-the-default-is-a-plugin.md) §8 — the lane is the last
  action at `merge:`, which is what refuses a `run:` written after it (`#270`).
- `#256` — the conductor runs the ten steps, deleting `run-once.ts`'s five gate
  points; `build:` opened on 2026-09-27 (`a417908`) because a red command at
  `proposed` had stopped buying a round.
- [`plugins/index.md`](index.md) — the twelve, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
