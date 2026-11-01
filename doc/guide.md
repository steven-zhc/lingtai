# Best practices

The habits that make Lingtai cheap and predictable, each with the receipt it
came from. Every section opens with the rule and a short *do this* list; the
evidence follows. The settings themselves are in
[`reference.md`](reference.md#policy--every-number-that-decides-behaviour).

## Write the ticket as the prompt

**The rule.** The issue body *is* the agent's prompt, pasted whole:
`prompts/ticket.md:5` is `{{body}}`. Since #643 the fix rounds and the cold
reviewer read it too (`packages/conductor/src/conduct.ts:3929` puts the body
into the fix brief). What the body leaves undecided, the agent guesses and the
reviewer refuses — one paid round at a time. A ticket written to be filed is a
prompt written by accident.

**Do this.**

- Open with a four-row table: **Problem**, **Want**, **Fix**, **Watch out**.
  The table is for the person choosing what to work next. **Watch out** is the
  row that earns it: the trap, meaning what costs money, fails silently, or has
  been got wrong before. Leave the row out when there is no trap; never leave
  the trap in the prose.
- Under a rule, **Evidence**: the log excerpt, the exact output, and
  `file.ts:line` for every claim about the code. A claim nobody found the line
  for does not go in the ticket. Say why the problem stayed hidden, when it did.
- **Edges**: one line per case and its rule — a read that fails, a process that
  dies halfway, a retry, a null value.
- **Out of scope**: what a reviewer must not hold the ticket to.
- **Done when**, as checkboxes that a person or a test can check.
- **Related**, saying what the other ticket *decided*, not only its number.
  There is no `gh` inside a run.

A short template:

```
| | |
|---|---|
| **Problem** | one sentence: the failure, not the area |
| **Want** | what is true when this is done |
| **Fix** | the shape of it, not the diff |
| **Watch out** | the trap |

---

## Evidence
The output, and file.ts:line for each claim.

## Edges
- a read that fails: what happens
- a retry: what happens

## Out of scope
- what a reviewer must not hold this ticket to

## Done when
- [ ] a check a person or a test can make

## Related
- #123 — what it decided
```

**Receipts.**

*A ticket that prescribes the wrong method.* One ticket called a
missing-browser-title fix a refactor that needed each page's data fetching
moved into a server wrapper. It was not: a sibling `layout.tsx` is a server
component and its `metadata` applies to the page it wraps. The ticket that
replaced it said what was true and landed in one short run
([experiment 006](experiments/006-the-loop-closes-unattended.md)). A method
stated in a ticket is not a hint; it is an instruction, and a wrong one spends
the run's judgement before the run starts.

*A ticket nobody wrote.* An item sat in **Waiting on you** for four days
holding one line, a git conflict message with a colon in it: no diagnosis, no
proposal, no button ([0025](decisions-archive/0025-a-failure-buys-one-agent.md)).

*An Out of scope line that was missing.* On 2026-11-01 two passes of #811
failed because the reviewer chased a race with a projection rebuild. The
ticket's purpose did not need that race fixed; one line under *Out of scope*
would have said so. Out of scope is not politeness. It is what stops a
reviewer from finding work you did not want.

**Where a durable instruction goes.** An instruction meant to outlive one
attempt goes in the issue body, where it is visible to everyone and read by
every later attempt. The board's editable prompt (`PromptEdited`) applies to
the *next run only*: it says *this attempt needs an extra sentence*, and the
ticket says *the instruction itself is wrong*
([0032](decisions-archive/0032-the-page-is-organised-by-attempt.md) §6). A
permanent override that lives only inside Lingtai is a shadow ticket body that
nobody outside can see.

**One label decides whether any of it is read.** `packages/conductor/src/discover.ts:205`
skips an issue with `skip: "no-kind"` when no label matches the recipe's
`source.kinds`. That is deliberate: guessing a kind would put unclassified
issues at the front of the queue. A well-written ticket with no kind label is
invisible.

## Size it for one pass

**The rule.** One ticket, one pass, and a result you can check in one sitting.
Before you file, ask: *can I name the shape of the diff that would close
this?* If the honest answer is *it depends what the agent finds*, it is
research wearing a ticket's clothes, and a run is the most expensive way to do
research.

**Do this.**

- Split along seams. A ticket that makes four decisions is four tickets.
- Give documentation its own ticket. A documentation requirement added to a
  code ticket grows it every round.
- If a ticket touches the same files as another, make it wait for the other.
- If the ticket turns on a fact about a dependency, say how to check that fact.
  If you cannot say how, that uncertainty is the item: file it as one.

**Receipts.** Lingtai's own records for 2026-10-02 to 10-31, measured
2026-11-01:

- 291 tickets finished; 283 landed and 8 were closed without landing.
- Cost per landed ticket: median $3.55, mean $6.32, p90 $11.96.
- 75% landed with 0 or 1 fix round; 6% needed 5 or more.
- Median machine time: 10 minutes.

And, on 2026-09-29 with the same configuration, `implement` cost $0.92 for a
27-turn ticket (#317) and $17.24 for a 239-turn one (#308). Switching the model
from Opus to Sonnet was worth about 2.19× per turn. Ticket size is the bigger
lever.

Two older failures in this repository show what an oversized ticket looks like.
#84 was four decisions in one item: it landed, but once it did, what the run was
thinking was gone, because a large item that succeeds leaves you less able to
explain it than a small one
([0034](decisions-archive/0034-the-run-log.md) §4). #89 rested on whether the
runtime binary accepts `--max-turns`; the flag is absent from `claude --help`
and present in the binary, two agents in a row concluded the opposite, and the
ticket never named the experiment that would settle it.

The recipe's limits say the same from the other side: the turn limit is a scope
alarm, not a budget, and a diff too big to review is a ticket too big. Both are
in [`reference.md`](reference.md#policy--every-number-that-decides-behaviour).

## Order and release

**The rule.** The kind label decides priority, a chain goes in GitHub's own
*blocked by*, and nothing is released that you have not read. These rules are
about GitHub issues.

**Do this.**

- Give every issue a kind label. The recipe's `source.kinds` is the vocabulary,
  the filter and the priority order at once; currently `bug`, `tech-debt`,
  `feature`, `documentation`, in that order, and the earlier kind wins when an
  issue carries two.
- Put a chain in *blocked by*, never in the body. The queue passes over a ticket
  with an open blocker and takes it again on its own once the last blocker
  closes (`packages/conductor/src/discover.ts:219`, `blocked-by`; its comment at
  `:212-214` says it counts *open* blockers, not total).
- Hold by default with `agent:hold`, and remove it from what you have read. An
  unheld ticket is one you are asking the next queue pass to claim, not one you
  are considering.
- For the first runs against a repository, use
  `lingtai run <project> --issue <n> --no-merge`: discovery, claim, worktree,
  agent and gates, and then it stops and asks. `lingtai run` also takes `--max`.

`agent:hold` is a label in `source.exclude`, and that list is the only one the
queue passes over: *"Every reason an issue is passed over is the recipe's — there
is no built-in list."* A label you have not put in `source.exclude` excludes
nothing, however much it looks like it should.

**When a ticket needs your decision first, ask it on the log.**
`lingtai ask <project> --issue <n> "<question>"` holds the ticket before
anything is claimed, and `lingtai answer <project> --issue <n> "<choice>"`
hands it back with the answer on the record, where every attempt's prompt is
told it. Do not edit the issue body to carry a decision to the agent.

**When you want one thing now, say so.** `lingtai now <project> --issue <n>`
jumps the backoff, because *"the person who types it has read the ticket and is
the input the failing attempt lacked"*
([0028](decisions-archive/0028-the-backoff-is-the-recipes.md) §3). A request for
something claimed, blocked or landed still matches nothing.

## Choose a model for each role

**The rule.** A recipe names a runtime and a model per action, not once:
`agent:` and `model:` sit beside each step's action
(`packages/recipe/src/recipe.ts:225-234`, *"0063 §2 settled that `model:` and
`prompt:` sit beside the key"*), and `runtime.agent` is only the default a
step's `agent:` overrides. So the question is asked once per role, and the roles
are not equally worth paying for. This section says what **we** run, why, and as
of when; models change faster than this page, so it is a record of one
repository's choices and not a recommendation.

**Do this.**

- Write down, per role, which runtime and model you run and the reason in one
  line. The recipe's comments are where ours live.
- Decide per role whether its work is worth the model's price; the table below
  is what this repository decided, not what yours must.
- Decide whether your reviewer should share the writer's blind spots; ours does
  not (the table gives the recipe's reason).
- Write the review prompt yourself, from your own repository's history (below).
- Check that every runtime any role names is installed and signed in, before the
  first pass.

**What we use, as of 2026-11-01**, from
[`examples/lingtai-recipe.yml`](examples/lingtai-recipe.yml) (committed that day,
one host value redacted):

| Role | Lines | Runtime, model | Why |
|---|---|---|---|
| shape (`design:`) | `:60-63` | Claude Code, Opus | The expensive model, once, to decide the approach with `file:line` evidence. |
| implement | `:84-89` | Claude Code, Sonnet | The recipe's own comment: *"on the cheaper model; the reviewer below is Codex, so the review is a second opinion"*. |
| review | `:117-132` | Codex | *"another model family than the writer's, so its blind spots are not the writer's"* (`:117-118`), with this repository's known defect shapes in its prompt. |
| judges at `proposed:` | `:180-201` | Sonnet at `findings` and at `conflict`; `same-worktree` at `red`, `verify-failed` and `budget-exhausted` | A judgement is paid for only where one is needed; a red build, a failed re-verify and a run stopped by a ceiling are answered for nothing. |
| triage | `:235-237` | Claude Code, no `model:` | Its own small limits (`turns: 100, wall: 15m, usd: 10.0`). With no `model:` the runtime's own default applies (`recipe.ts:229`). |

**The review prompt is the one to write yourself.** Ours
(`examples/lingtai-recipe.yml`, `review:`) reads strangely to an outsider on
purpose: it lists six defects *this* repository has shipped, each with the issue
it came from, and the `# [published]` comment above it (`:121-128`) says so. It
is not advice for another repository. The generic checklist is already in
Lingtai's built-in review brief (`packages/actions/src/agent-action.ts:182`,
`CHECKLIST`); what a reviewer lacks is what *your* codebase keeps getting wrong.
Fill this in from your own history:

```yaml
review:
  - name: review
    agent: codex          # another vendor than the writer
    prompt: |
      <one line: what this codebase is>
      These mistakes have shipped here more than once. Look for them.

      1. **<the mistake, as a name>.** <one real example, with its issue>.
         Ask: <the question that catches the next one>.
      2. ...
```

**Where the money goes.** Over tickets that landed in October 2026 (measured
2026-11-01), work was 56% of spend, answering refusals 35%, triage 6%, judging 3%
and discussion 0.1%. The fix rounds are a third of the spend, which is why the
ticket and the review prompt matter more than the model. The per-turn difference
between the two writer models is in *Size it for one pass*, above.

Two things to check before a role goes live: every runtime a role names must be
installed and signed in (`discuss.agent` defaults to `claude-code`), and a role
on Codex without tools needs a separately billed `codex_text` key — both are on
the [requirements page](requirements.md).

## Gate what has failed

**The rule.** A gate runs once per attempt, not once per item, so its cost is its
runtime multiplied by how often your items fail — the number nobody estimates.
Keep the gates that refuse and delete the ones that never do. A gate nobody reads
is not a gate; it is a delay with a signature on it.

**Do this.**

- Put what makes the worktree usable at `prepared`, the cheapest place to fail.
- Put the checks you would not merge without at `build`, and nothing else.
- Keep the cold reviewer at `review`; it is the one action that costs agent money,
  so put the cost question to it first.
- Use `watch:` to stop for a person on a path, with no process and no agent.
- Declare a hold for a person at `proposed:`, never at `merge:`: `human:` and
  `watch:` are refused at `merge`, and the lane is the last action there.
- Add a new gate only on a green base, or every ticket parks on drift that is not
  its own.
- For every gate, check that it runs and that you have seen it fail.

Ten steps, closed forever — `claim`, `admit`, `prepared`, `design`,
`implement`, `build`, `review`, `proposed`, `merge`, `end`
([reference](reference.md#step--10-closed-forever)). Fourteen action kinds, of
which four produce a verdict, two run for effect, one keeps what a step made,
one reads it back, and six are names for code the pass calls itself and no step
yet reads
([reference](reference.md#gate-action--14-keys-of-which-4-produce-a-verdict)).
Which plugin serves which step is each plugin's own `at` in
`packages/recipe/src/recipe.ts`; a plugin written at a step it does not serve is
refused by name before a worktree is cut.

**A gate runs once per attempt.** `wi-lingtai-87` was claimed three times and
`wi-lingtai-89` twice
([0032](decisions-archive/0032-the-page-is-organised-by-attempt.md)); every one of
those attempts paid for `install` and for `pnpm typecheck && pnpm test` again.

**`prepared` is the cheapest place to fail.** `git worktree add` copies no
`node_modules`, so this repository runs `pnpm install --frozen-lockfile` there.
The refusal reads `stopped at prepare: the install action refused` — *"Nothing
expensive ran; that is the point of failing here."* Anything you can discover
before the agent starts, discover before the agent starts.

**`build` is the check you would not merge without, and nothing else.** Here it
is four actions (`examples/lingtai-recipe.yml:99-115`): `install`, `format`
(`pnpm fmt:check`), `lint` and `build` (`pnpm typecheck && pnpm test`). The
format and lint actions are separate so a refusal names which one, and they run
first because they take seconds. It sat at `proposed:` until 2026-09-27, because
`proposed` was the only step a `run:` could legally be declared at — never a
judgement that a build belongs with the routing. This repository holds nothing
for a person before the landing, so those actions and the cold reviewer below
are **all that is between an agent and `main`**. Every action is something every
attempt pays for; if one of them has never refused, find out whether it is even
running before you keep it.

**A new gate needs a green base.** A gate added while the base already fails it
refuses every ticket, each for drift that is not its own, and each refusal buys
a fix round for a failure no ticket can fix. Make the base pass first, then add
the gate.

**`review` earns its cost when self-review does not.** The claim tested in
[experiment 001](experiments/001-cold-review-issue-58.md) was that self-review
after ~89 turns of committed reasoning is not a second opinion.
`nextloom-ai-admin#58` had passed self-review, `verify.sh`, CI and a human read,
and merged; hours later the agent filed three issues against its own merged
code. A cold reviewer given only the diff and the issue found **all four known
defects in a single finding, plus two nobody had found** — both verified by hand,
both still on `develop`, neither covered by any of ~300 issues.

**`watch:` is the cheapest gate there is.** Globs against the diff's file list,
then `request-approval` or `fail`. It is how a migration stops for a person
without anything having to run.

**`merge` holds the landing, and no hold for a person.** This repository's
`merge:` has one action, the merge itself (`examples/lingtai-recipe.yml:202-207`,
whose comment says nothing holds before the landing). A hold that a person
should read belongs at `proposed:`, one step earlier: `human:` and `watch:` serve
only `proposed`, so a recipe that writes one at `merge` is refused by name when
it resolves. A gate nobody reads is a delay with a signature on it; declare one
only where somebody will read it.

**`end` cannot refuse.** It runs on every terminal outcome, and its actions are
effects: `close:`, `labels:` and `refs:`. The first two carry `when:` (`landed`
/ `blocked` / `failed` / `closed` / `any`); `refs:`, which deletes a landed
ticket's `agent/<n>-attempt-<k>` refs, carries the same key narrowed to `landed`
alone. Putting any of them at a gating point is refused by name.

### The gate you have never seen fail

Check that it runs. A configured point that silently does not execute is
indistinguishable from one that always passes, and this project has had exactly
that: `#58` was a `merge` point that **did not execute**, so a run without
`--no-merge` merged itself into `main` unapproved. A point that never refuses and
a point that never runs look identical from outside. `lingtai doctor` carries
`steps: end ran on what landed`, the board's bar has a `never-ran` mark of its
own for a step that was configured and did not run, and `StepsResolved` is an
event rather than a convention so that an unconfigured point renders as
`skipped` on the board and in `lingtai status` — **never omitted**. A check you
cannot see is a check you will forget you never had.

The gating half of that comparison was a `doctor` row too and is gone (`#257`):
a plugin declares the steps it serves, and a plugin written at any other step is
refused by name and before a worktree, so *configured and never called* is now
something the recipe cannot say. What a person can still act on stays — an `end`
effect that failed at runtime, which `lingtai end replay` resolves.

## Read a failure in this order

**The rule.** Read a failure from the narrowest view outward: the receipt, then
the run log, then triage's recommendation, then the events. The order matters
because the instinctive one is wrong: on 2026-09-08 the question *"why is this
not moving?"* was asked of `#80`, `#87`, `#89` and `#94` in a single day and
**answered wrongly four times**, including once where the item was not stuck at
all and would have returned by itself
([0032](decisions-archive/0032-the-page-is-organised-by-attempt.md)). A
disagreement is not a failure.

**Do this.**

- Open the attempts ledger on `/task/<id>` first: one row per attempt, with its
  prompt, files, gates and outcome.
- Read the outcome word on the failing row before anything else; `never-started`
  is Lingtai's own failure, not the ticket's.
- Open the refusing gate's evidence through the pointer on the row.
- If the item has not landed, tail the run log: `pnpm lingtai attach <runId>`.
- Read triage's recommendation for a waiting ticket as a recommendation, not a
  verdict.
- When you must settle a behavioural claim, read `events` and cite the seq.
- When a card says `disagreement`, treat it as a judgement to make, not a repair.

Diagnosing `#89` took an hour, most of it spent rebuilding by hand a division the
log had already made.

**1. The attempts ledger, on `/task/<id>`.** One row per attempt, opening into
that attempt's prompt, its files, its gates and its outcome. Start here because
a gate runs once *per attempt*, and the thing that made `#89` take an hour was a
page that flattened what the log had been careful to divide. Two attempts and no
diff is a different illness from one attempt and 150 turns.

**2. The outcome word on the failing row.** In particular, `never-started` is
not a failure at the task — zero turns, zero cost, `is_error`. It is Lingtai's
own failure, it buys no repair agent, and it stops the conductor rather than
backing the item off ([0031](decisions-archive/0031-a-run-that-never-started.md)). It
looks exactly like a run of broken tickets if you do not know the shape:

```
03:44:14  wi-lingtai-80   crash   You've hit your session limit · resets 11pm (America/Chicago)
03:44:39  wi-lingtai-81   crash   …
03:45:03  wi-lingtai-83   crash   …
```

Six runs, ninety-two seconds, eighty events, six worktrees, `costUsd` on every
one of them: **nothing.** No agent ever started. The prose is kept as `detail`
because it is evidence, not a verdict — the outcome is named for what is
checkable.

**3. The refusing gate's evidence.** It is a pointer that names the attempt it
came from, and that attempt holds the whole of it — *"printing the failing gate
twice is how two copies of one fact come to disagree."* What a failed command
keeps is 60 lines / 8,000 bytes (`packages/actions/src/command.ts:32-33`), written
into `StepFailed.evidence`, which is an event payload and therefore never
rewritten.

**4. The run log, if the item has not landed.** `pnpm lingtai attach <runId>`,
or the run log inside that attempt's row. Both start at the beginning however
late you arrive; neither asks the daemon or the database anything, so they
answer on a stopped system. **A run that landed has no log** — the file is kept
only while something is still owed an explanation
([0034](decisions-archive/0034-the-run-log.md) §4). It is a trace and never a record.

**5. Triage's recommendation.** For a ticket that is waiting, triage explains the
wait once, without tools, and recommends; it is bounded by its own small limits
(`examples/lingtai-recipe.yml:235-237`). Read it as a pointer to the evidence
above, not as a replacement for it.

**6. The events.** *"Behavioural claims are settled by reading `events`, not by
reasoning about the code. A finding that cites a seq number is worth more than
one that argues."* This is last in the order and first in authority: everything
above is a view of it.

### A disagreement is not a failure, and a decline is not a crash

Two outcomes in this family read like breakage and are not.

**`disagreement`** is what a card says when a reviewer refused, an agent was
bought to fix it, and the reviewer still refuses what came back. Nothing is
broken: two agents looked at one diff and did not agree, and the question in
front of you is a judgement rather than a repair. The card carries every finding
verbatim, including each failure scenario, because the sentence above them is a
reading of evidence and a reading that hides what it was made from is worse than
the output.

**A fixer that committed nothing** may have declined. That is a move it is told
it has ([0039](decisions-archive/0039-the-worktree-is-the-whole-of-a-pass.md) §5): when
a finding is wrong — the sequence it describes cannot happen, or the failure was
not this diff's — the fixer is asked to change nothing, commit nothing, and say
why, because that is what stops the loop and puts the findings in front of you.
So read which one you have:

```
the fixing agent declined — it committed nothing, which is how it says these
findings are not this diff's to answer. It said: …

the fixing agent did not finish (crash: …), so there is nothing new for the
review to read
```

The first is an argument you are being asked to settle, and the fixer's own
words are the most useful thing on the card — it is the only agent in the loop
that read both the findings and the code. The second is a process that died, and
the findings are untested against anything.

### Two inferences that have already cost money

Both are written into the discussion agent's own prompt
(`packages/conductor/src/discuss.ts:198`), as prohibitions, because *an
assistant that repeats them is worse than no assistant*. They are worth holding
to yourself:

1. **Absence from documentation is not absence from the program.** Reading a
   shipped bundle can show a string is present. It cannot show that a binary
   accepts a flag, that a flag does what its name suggests, or that a version
   behaves as its changelog says. `#89`, $13.04.
2. **A file you were not given is a file you have not read.** In particular:
   `worktree.ts:139` resets an attempt's branch with `-B` on every run, so an
   attempt that committed nothing never had one. Reading `main` and believing it
   is that attempt's work is precisely what killed the repair
   ([0033](decisions-archive/0033-the-third-kind-of-agent.md) §5).

## Set the limits

**The rule.** Every limit is in the recipe, so a repository can read its own
policy without opening Lingtai's source. Treat each as an alarm or a bound with
a reason, set it to the failure it protects against, and read one that fires as
information about the ticket before you raise it. The values and defaults are in
[`reference.md`](reference.md#policy--every-number-that-decides-behaviour); what
follows is what each is *for*, which is the part an ADR states once and a recipe
cannot.

**Do this.**

- Set `runtime.limits` (`turns`, `wall`, `rounds`, `restarts`) so that together
  they say what a ticket may spend in agent runs (not how long a drain waits,
  which also includes review and gates); this repository's comment says it in a
  sentence.
- Set the daily ceiling `limits.day_usd` in your installation config before you
  run unattended.
- Read `error_max_turns` as *the ticket was wrong*, not *the number was low*.
- Size `runtime.budget.evidence` to the capture your gate produces.
- Do not expect anything to cap the number of ordinary attempts; read the ledger
  early and use `agent:hold`.

**What this repository sets** (`examples/lingtai-recipe.yml:251-258`, as of
2026-11-01): the comment says a pass may spend five agent runs, the work and four
rounds, of up to `turns: 350` and `wall: 75m`, then up to `restarts: 2` fresh
starts from the base, with `rounds: 4`. Turns are priced per model.

**The daily ceiling.** `limits.day_usd` is dollars per local calendar day for the
whole installation (`config.example.yml:86-89`): *"When the day's recorded spend
reaches it the conductor pauses until local midnight or `lingtai resume`,
finishing every pass in flight."* Absent means no ceiling.

**`runtime.limits.turns`** is not a cost cap; it is a **scope alarm**. The
runtime stops the agent and the run ends `error_max_turns`, and the useful
reading of that is *the ticket was wrong*, not *the number was low*. If it never
fires, it is telling you nothing.

**`runtime.limits.wall`** bounds each agent run, and a shutdown waits on it too:
`pnpm lingtai shutdown "why"` appends, returns, and the daemon finishes the pass
in flight — the pass, not the agent, so the gates and the merge lane run too.
But `wall` bounds **one agent call**, not the pass: a draining pass may still
take further fix rounds, and the cold review and every gate run again with each,
so the wait is longer than `wall` and longer than the work's own ceiling. The
sentence the command prints, built from `runtime.limits`, counts only the
`implement` runs (`packages/conductor/src/ceiling.ts`); it leaves out review
time and process gates, so read it as a lower bound on a drain that goes through
every round and never as a promise. A restart is not part of the drain: it
happens after a pass has ended and the ticket has gone back through the queue.
Do not schedule around `wall` alone, or around that sentence either, and do not
read a long wait as a hang before you have run `pnpm lingtai attach <runId>`.
`pnpm lingtai restart "why"` waits out the same drain and then starts one
([0042](decisions-archive/0042-the-restart-is-a-command.md)).

**A process action's `timeout:`** applies **per action, not per point**
(`examples/lingtai-recipe.yml:99-115` gives each build action its own).
Multiply by attempts, per the arithmetic above.

**`source.backoff`** is flat. **It stops blind retries, and only blind
retries.** A failed run releases its task, a release is a completion event, and
a completion event starts the next pass — so without the guard the top of the
queue is the ticket that just failed, forever, at agent prices. 0028 records
what that used to cost: *"The old harness re-ran #58 and #59 five times for
roughly $29 exactly that way."*

Flat rather than growing, and the reason is the interesting one. A growing
backoff is a bet that the same failure gets likelier to resolve itself the
longer you leave it, and nothing supports that bet. What actually changes
between one attempt and the next is **what the next attempt is told** — since
`#82` a second attempt carries the first's release reason, its refusing gate and
that gate's output — so delaying it further would penalise the one mechanism
that makes a retry worth anything. An attempt that is told something the last
one was not is not blind, and does not wait: `lingtai now` jumps the backoff.

**`runtime.budget.*`** is what a run is **given**, not what it may spend, and it
is the setting most worth tuning to your own gates. `evidence` is how much of one
earlier failure's output the next prompt quotes verbatim. What fits is quoted
whole; what does not is quoted as **two ends**, with the middle elided and
counted (#171). The number to size against is not the failure but *the capture it
sits in*: a command gate stores the exit line and the last lines of its output,
and, when that is not all of it, a stretch of its start on top. `tsc` puts its
first error in the start, and vitest puts its ` FAIL ` and `AssertionError` near
the tail — but a longer diff or a second failing test pushes the first one into
the elided middle, where the prompt never names the test or the assertion. **A
failure in the middle of its output is the case two short ends cannot carry.**
This repository sets `evidence: 10200` (`examples/lingtai-recipe.yml:245`) —
sized to hold one build failure's whole capture (`:243-244`, #171) — because an
agent that cannot see the failure repeats it, and the ticket buys another agent.
`attempts`, `findings` and `diff` answer the same question at different scales.

### What nothing bounds

**The number of ordinary attempts.** With a short sweep and a backoff, a ticket
that fails every time costs a run per backoff interval, indefinitely.
`runQueue`'s in-memory `attempted` set caps one pass; nothing caps the
sequence, and
[0028](decisions-archive/0028-the-backoff-is-the-recipes.md) leaves it undecided on
purpose — a doubling backoff still spends forever, just on a longer timetable,
and the right instrument for that failure is a count rather than a curve.

Until there is one, **you are the count.** That is the strongest argument in this
guide for reading the attempts ledger early and reaching for `agent:hold` rather
than hoping: a ticket that has failed twice for the same reason will keep
failing, at agent prices, unless somebody changes what it is told.

## What to read next

- [`examples/lingtai-recipe.yml`](examples/lingtai-recipe.yml) — the recipe this
  repository runs, as of 2026-11-01; every role and limit above is a line in it.
- [`requirements.md`](requirements.md) — which runtimes and keys a recipe needs
  before its roles can run.
- [`operating.md`](operating.md#when-something-refuses) — what every refusal
  means, in a table, when one of the above turns into a message on your terminal.
- [`reference.md`](reference.md#policy--every-number-that-decides-behaviour) —
  every number that decides behaviour, with the column that says whether it is
  the recipe's or Lingtai's.
- [`doc/decisions/`](decisions/) — the arguments behind all of it. Where this
  guide gives advice, a decision gives the reasoning and the reversal condition;
  [0025](decisions-archive/0025-a-failure-buys-one-agent.md),
  [0028](decisions-archive/0028-the-backoff-is-the-recipes.md),
  [0031](decisions-archive/0031-a-run-that-never-started.md),
  [0032](decisions-archive/0032-the-page-is-organised-by-attempt.md),
  [0033](decisions-archive/0033-the-third-kind-of-agent.md) and
  [0034](decisions-archive/0034-the-run-log.md) are the six it draws on most.
- [`doc/experiments/`](experiments/) — things actually run against real data,
  with their results, including the ones that did not work.
  [001](experiments/001-cold-review-issue-58.md) and
  [006](experiments/006-the-loop-closes-unattended.md) are the two this guide
  quotes.
