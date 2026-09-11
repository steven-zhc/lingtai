# Guide — what a repository that gets good results does differently

[`tutorial.md`](tutorial.md) gets you to a first merge. [`operating.md`](operating.md)
says what every command does and what every refusal means. Neither answers the
question that arrives in week two, when the loop is working and the results are
mediocre and nothing is broken: **what does a repository that gets good results
out of this actually do differently?**

Six things, and every one of them was learned here by paying for it. This
project runs on itself and keeps a public log of its own failures, so each
claim below names the run, the ticket or the decision it came from. Where a
figure appears — `$26.53`, `15 turns`, `ninety-two seconds` — it is off
`RunFinished` or out of a decision that quotes it, never an illustration.

Nothing here is a setting. The settings are in
[`reference.md`](reference.md#policy--every-number-that-decides-behaviour), and
the last section says what each is protecting you from.

## The ticket is the prompt, and it is the prompt literally

`prompts/ticket.md:5` is `{{body}}`. The issue body is not summarised,
extracted from or reasoned about before it reaches the agent — it is pasted, in
full, between a two-line header and a description of the run. Everything the
agent knows about *what to do* is what you typed into GitHub.

That single fact is the whole of this section. A ticket written to be filed is
a prompt written by accident.

### What a ticket that works looks like

This repository's house style is in `CLAUDE.md`, and it was assembled from
failures rather than from taste:

- **Lead with the evidence** — the seq numbers, the log excerpt, the exact
  output. Not a description of the output.
- **Say why it stayed hidden**, when it did. That is usually the real finding,
  and it is the part an agent cannot reconstruct.
- **Cite `file.ts:line`**, and quote the comment or doc that makes the wrong
  claim. An agent given a path spends no turns finding one.
- **`## Done when`, as checkboxes** each of which a person or a test can check.
- **`## Related`**, saying what the related ticket *decided* — not just its
  number, which the agent cannot fetch. There is no `gh` inside a run.

### What it looks like when this is skipped

Two shapes, from opposite ends.

**A ticket that prescribes the wrong method.** `nextloom-ai-admin#155` called a
missing-browser-title fix *"a refactor needing each page's data fetching moved
into a server wrapper."* It is not — a sibling `layout.tsx` is a server
component and its `metadata` applies to the page it wraps. The ticket that
replaced it, `#156`, said what was true instead and landed in 15 turns and
$0.83 ([experiment 006](experiments/006-the-loop-closes-unattended.md)). A
method stated in a ticket is not a hint; it is an instruction, and a wrong one
spends the run's judgement before the run starts.

**A ticket nobody wrote at all.** `nextloom-ai-admin#112` sat in **Waiting on
you** for four days holding this and nothing else:

```
441 WorkItemBlocked  "conflict: agent/112 does not merge into develop:
                      apps/web/src/components/users/user-lookup-panel.tsx"
```

A git message with a colon in it. No diagnosis, no proposal, no button
([0025](decisions/0025-a-failure-buys-one-agent.md)). That is what the far end
of the loop looks like when the near end was not written for a reader.

### Where a durable instruction goes

An instruction meant to outlive one attempt goes **in the issue body**, where it
versions as `ticket@NNNN`, is visible to everyone, and is read by every
subsequent attempt. The board's editable prompt (`PromptEdited`) applies to the
*next run only*. The two have one job each:
`PromptEdited` says *this attempt needs an extra sentence*; the ticket says
*the instruction itself is wrong*
([0032](decisions/0032-the-page-is-organised-by-attempt.md) §6). A permanent
override living only inside Lingtai would be a shadow ticket body — a long-lived
instruction nobody outside can see.

### One label decides whether any of it is read

`discover.ts:115` skips an issue with `skip: "no-kind"` when no label matches
the recipe's `source.kinds`. That is not a defaulting opportunity — *"an issue
this recipe has no label for is not work the scheduler can prioritise, and
guessing the first kind would put unclassified issues at the front of the
queue."* Earlier in `kinds` wins when an issue carries two, so the list is the
vocabulary, the filter and the priority order at once.

A beautifully written ticket with no kind label is invisible.

## Size the item so its result can be checked in one sitting

Four items this project has receipts for:

| item | what it asked for | cost | how it ended |
|---|---|---|---|
| `nextloom-ai-admin#157` | the `end` point closes its own issue | 8 turns, $0.63 | landed, closed with its label intact |
| `nextloom-ai-admin#156` | six new `layout.tsx` files, no existing file touched | 15 turns, $0.83 | landed; `git diff --stat` was exactly the ticket |
| `#84` | the repair feature — and [0025](decisions/0025-a-failure-buys-one-agent.md)'s four decisions with it | one run, $26.53 | landed, and what it was thinking is gone ([0034](decisions/0034-the-run-log.md) §4) |
| `#89` | a change that turned on whether the runtime binary accepts `--max-turns` | two attempts, $13.04 | failed |

The spread is forty-to-one and none of it is luck.

**`#156` was checkable by construction.** Six files added, 42 insertions,
nothing modified — *"which makes the result trivial to check"*, as the
experiment says of the ticket before the run. The test to apply before you file
is: **can you name the shape of the diff that would close this?** If the honest
answer is *it depends what the agent finds*, you have written a piece of
research wearing a ticket's clothes, and a run is the most expensive way to do
research.

**`#84` was four decisions in one item.** It landed, so the cost bought
something — but it is also the item [0034](decisions/0034-the-run-log.md) §4
names when it accepts that a landed run's log is deleted: *"`#84` cost $26.53
and, once landed, what it was thinking is gone."* A large item that succeeds
leaves you less able to explain it than a small one that succeeds, because the
diff and the events are all that survive and neither says why.

**`#89` rested on a fact no attempt established.** `--max-turns` is absent from
`claude --help` and present in the binary, and two agents in a row concluded
absence from the help text meant absence from the CLI
(`packages/agent/test/claude-code.test.ts:358`). The ticket did not name the
experiment that would settle it, so both attempts picked the same wrong one. **A
ticket that turns on a fact about a dependency should say how to check it**, and
if you cannot say how, that uncertainty is the item — file it as one, and let
the implementation follow it.

There is a second signal in the recipe. This repository sets
`runtime.limits.turns: 150` against the default of 300, and says why in the file:
*"a run that needs hundreds of turns on this repository is a ticket that was
scoped wrong, and stopping is the more useful answer."* The turn limit is not a
budget. It is a scope alarm, and it should occasionally fire.

The review gate agrees from the other side. `runtime.budget.diff` truncates at
400,000 bytes, and the number was chosen against
[experiment 001](experiments/001-cold-review-issue-58.md), whose diff was 1,391
lines across 6 files and fitted comfortably: *"far past that is a work item
scoped too large — a megabyte produces a worse review, not a better one."*

## Gate what has failed here, and delete the gate that never fails

Five points, closed forever — `admit`, `prepared`, `proposed`, `merge`, `end`
([reference](reference.md#gate-point--5-closed-forever)). Six action kinds, of
which four produce a verdict
([reference](reference.md#gate-action--6-keys-of-which-4-produce-a-verdict)).
The design question a repository actually faces is not which points exist; it is
what to hang on them.

**A gate runs once per attempt, not once per item.** This is the arithmetic
nobody does. `wi-lingtai-87` was claimed three times and `wi-lingtai-89` twice
([0032](decisions/0032-the-page-is-organised-by-attempt.md)); every one of those
attempts paid for `install` and for `pnpm typecheck && pnpm test` again. A
gate's cost is its runtime multiplied by how often your items fail, and the
second number is the one you did not estimate.

So, in the order the loop runs them:

**`prepared` is for what makes the worktree usable, and it is the cheapest
place to fail.** `git worktree add` copies no `node_modules`, so this repository
runs `pnpm install --frozen-lockfile` with a 10-minute timeout there. The
refusal reads `stopped at prepare: the install action refused` — *"Nothing
expensive ran; that is the point of failing here."* Anything you can discover
before the agent starts, discover before the agent starts.

**`proposed` is the check you would not merge without, and nothing else.** Here
it is one action: `pnpm typecheck && pnpm test`, 20-minute timeout. And because
this repository's `merge` point is empty (below), that one action is **the only
thing between an agent and `main`** — which the recipe says in as many words, so
that nobody has to derive it. A `proposed` list that has grown to five actions
is five things every attempt pays for; if one of them has never refused, it is
not protecting you, and you should find out whether it is even running before
you keep it.

**An `agent:` reviewer earns its cost when self-review does not.** The claim
being tested in [experiment 001](experiments/001-cold-review-issue-58.md) was
that self-review after ~89 turns of committed reasoning is not a second opinion.
`nextloom-ai-admin#58` had passed self-review, `verify.sh`, CI and a human read,
and merged; hours later the agent filed three issues against its own merged
code. A cold reviewer given only the diff and the issue found **all four known
defects in a single finding, plus two nobody had found** — both verified by
hand, both still on `develop`, neither covered by any of ~300 issues. That is
what a gate that earns its cost looks like — and `agent:` is the only action of
the six that costs agent money, so it is the one to put this question to first.

**`watch:` is the cheapest gate there is.** Globs against the diff's file list,
then `request-approval` or `fail`. No process, no agent. It is how a migration
stops for a person without anything having to run.

**`merge` is where gates go to stop meaning anything.** This repository emptied
it on 2026-09-08, and wrote the reason into the recipe rather than into a commit
message:

> On 2026-09-08 seven changes landed and every one was approved
> unread-in-substance, which is an approval that has stopped meaning anything.

**A gate nobody reads is not a gate; it is a delay with a signature on it.** The
honest move is to delete it and say so, which is what `merge: []` and that
comment are. `#31`'s narrowing — a `watch:` list over `conductor`, `event-store`,
`hook` and `actions` — is named there as the thing to reach for if the deletion
turns out to be too far, along with the objection it has to answer: a path list
has to be kept correct, and the first thing it would miss is the file that
defines it. *"If it comes back it should be tried against that objection, not
around it."*

**`end` cannot refuse.** It runs on every terminal outcome, and its actions are
effects: `close:` and `labels:`, each carrying `when:` (`landed` / `blocked` /
`failed` / `any`). Putting either at a gating point is refused by name.

### The gate you have never seen fail

Check that it runs. A configured point that silently does not execute is
indistinguishable from one that always passes, and this project has had exactly
that: `CLAUDE.md`'s standing instruction — *"Pass `--no-merge`, by hand, every
time"* — exists because this repository's own `merge` point **does not execute**
(`#58`), so a run without the flag merges itself into `main` unapproved. A point
that never refuses and a point that never runs look identical from outside, and
this project has been on the wrong side of that for long enough to write the
workaround into its own instructions. `lingtai doctor` now
carries `gates: every point that was planned ran`, and `GatesResolved` is an
event rather than a convention so that an unconfigured point renders as
`skipped` on the board and in `lingtai status` — **never omitted**. A check you
cannot see is a check you will forget you never had.

## Hold by default, and unhold what you have read

`agent:hold` is a label in `source.exclude`. It has no other machinery behind it
and needs none. What it costs is one decision per ticket, and the decision is:
**is this the next thing I want an agent to take?**

Every open issue in this repository carries it, deliberately, and the recipe
says why:

> Self-hosting starts with nothing runnable and one ticket unheld at a time,
> because the backlog contains work no agent should take — `#29` needs seven
> unattended days, `#33` is the act of self-hosting itself.

The rule that follows: **an unheld ticket is one you are asking the next queue
pass to claim.** Not one you are considering. A backlog groomed with `agent:hold`
off by default is a queue you have not read, and *"a queue you have not read is a
bill you have not agreed to"* — which is also why `lingtai run` takes `--max`,
and why the first runs against a repository should be
`lingtai run <project> --issue <n> --no-merge`: discovery, claim, worktree,
agent, gates, and then it stops and asks.

Six more labels do the same job with different meanings, and the recipe names
every one of them rather than Lingtai keeping a built-in list: `blocked`,
`in-progress`, `agent:blocked`, `agent:needs-schema-approval`, `agent:review`,
`agent:wip`. *"Every reason an issue is passed over is the recipe's — there is
no built-in list."* Which means the corollary holds too: a label you have not
put in `source.exclude` excludes nothing, however much it looks like it should.

**When you want one thing now, say so.** `lingtai now <project> --issue <n>`
passes `backoffMs: 0` and jumps the backoff, because *"the person who types it
has read the ticket and is the input the failing attempt lacked"*
([0028](decisions/0028-the-backoff-is-the-recipes.md) §3). Everything else still
applies — a request for something claimed, blocked or landed still matches
nothing, because those are facts about the log and not about the clock.

## Read a failure in this order

On 2026-09-08 the question *"why is this not moving?"* was asked of `#80`,
`#87`, `#89` and `#94` in a single day and **answered wrongly four times** —
including once where the item was not stuck at all and would have returned by
itself ([0032](decisions/0032-the-page-is-organised-by-attempt.md)). Diagnosing
`#89` took an hour, most of it spent rebuilding by hand a division the log had
already made.

There is an order, and it is not the order instinct offers.

**1. The attempts ledger, on `/task/<id>`.** One row per attempt, opening into
that attempt's prompt, its files, its gates and its outcome. Start here because
a gate runs once *per attempt*, and the thing that made `#89` take an hour was a
page that flattened what the log had been careful to divide. Two attempts and no
diff is a different illness from one attempt and 150 turns.

**2. The outcome word on the failing row.** In particular, `never-started` is
not a failure at the task — zero turns, zero cost, `is_error`. It is Lingtai's
own failure, it buys no repair agent, and it stops the conductor rather than
backing the item off ([0031](decisions/0031-a-run-that-never-started.md)). It
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
into `GateFailed.evidence`, which is an event payload and therefore never
rewritten.

**4. The run log, if the item has not landed.** `pnpm lingtai attach <runId>`,
or the run log inside that attempt's row. Both tail
`~/.lingtai/runs/<project>/<runId>.log` and both start at the beginning however
late you arrive; neither asks the daemon or the database anything, so they
answer on a stopped system. **A run that landed has no log** — the file is kept
only while something is still owed an explanation
([0034](decisions/0034-the-run-log.md) §4). It is a trace and never a record.

**5. The events.** *"Behavioural claims are settled by reading `events`, not by
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
it has ([0039](decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §5): when
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
   ([0033](decisions/0033-the-third-kind-of-agent.md) §5).

## The limits, and what each one is protecting you from

Every number below is in the recipe, so a repository can read its own policy
without opening Lingtai's source. The values are in
[`reference.md`](reference.md#policy--every-number-that-decides-behaviour); what
follows is what each is *for*, which is the part an ADR states once and a
recipe cannot.

**`runtime.limits.turns`** — default `300`. Not a cost cap; a **scope alarm**.
The runtime stops the agent and the run ends `error_max_turns`, and the useful
reading of that is *the ticket was wrong*, not *the number was low*. This
repository runs `150` and says so in the recipe. If it never fires, it is
telling you nothing.

**`runtime.limits.wall`** — default `2h`, `1h` here. The second thing it decides
is how long a shutdown waits: `pnpm lingtai shutdown "why"` appends, returns,
and the daemon finishes the pass in flight — the pass, not the agent, so the
gates and the merge lane run too. That wait is `runtime.limits.wall`, and the
command says so rather than looking hung ([0030](decisions/0030-shutting-down-safely.md)).

**`gates.<point>[].timeout`** — default `15m`, **per process action, not per
point**. Multiply by attempts, per the arithmetic above.

**`repair.on` / `repair.maxAttempts`** — `true` / `1`. A failure of *this
repository's* buys one agent to understand it; **Lingtai's own never do** — an
agent pointed at a missing credential or an unreachable database *"would spend
money to report that it cannot see anything, and the report would be addressed
to the one person who did not need it."* Three bounds make "once" structural
rather than aspirational: one analysis per **distinct** failure, a ceiling in
the recipe, and an analysis that fails does not trigger an analysis of the
analysis. Drop any one and a single bad ticket spawns an agent per lap. **This
is the only part of the design where the failure mode is unbounded spend rather
than a wrong answer** ([0025](decisions/0025-a-failure-buys-one-agent.md) §3).

The reason for the ceiling changed on 2026-09-08, and the recipe records the
change rather than the conclusion: it used to bound only spend, because every
merge waited for a person. `merge` is empty now, so a repair that passes
`proposed` lands unread — one attempt is the whole of the limit on how far an
agent may go correcting itself.

**`source.backoff`** — `1h`, flat. **It stops blind retries, and only blind
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
one was not is not blind, and does not wait: a repair jumps the backoff, and so
does `lingtai now`.

**`runtime.budget.*`** — this is what a run is **given**, not what it may spend,
and it is the setting most worth tuning to your own gates. `evidence: 2000`
characters is the slice of one earlier failure's output the next prompt quotes
verbatim, and the recipe justifies the number by naming the gate it has to
carry: *"This repository's gate is `pnpm typecheck && pnpm test`, whose failures
are short and specific, so 2000 characters is a whole failure rather than a
fragment of one."* If your `proposed` gate emits a 5,000-character stack trace,
2000 gives the second attempt a fragment, and **an agent that cannot see the
failure repeats it, and the ticket buys another agent.** The other three —
`attempts: 5` rows, `findings: 5`, `diff: 400000` bytes — answer the same
question at different scales.

### What nothing bounds

**The number of ordinary attempts.** With a five-minute sweep and an hour's
backoff, a ticket that fails every time costs about twenty-four agent runs a
day, indefinitely. `repair.maxAttempts` caps repairs; `runQueue`'s in-memory
`attempted` set caps one pass; neither caps the sequence, and
[0028](decisions/0028-the-backoff-is-the-recipes.md) leaves it undecided on
purpose — a doubling backoff still spends forever, just on a longer timetable,
and the right instrument for that failure is a count rather than a curve.

Until there is one, **you are the count.** That is the strongest argument in this
guide for reading the attempts ledger early and reaching for `agent:hold` rather
than hoping: a ticket that has failed twice for the same reason will fail
twenty-four more times today unless somebody changes what it is told.

## What to read next

- [`operating.md`](operating.md#when-something-refuses) — what every refusal
  means, in a table, when one of the above turns into a message on your terminal.
- [`reference.md`](reference.md#policy--every-number-that-decides-behaviour) —
  every number that decides behaviour, with the column that says whether it is
  the recipe's or Lingtai's.
- [`doc/decisions/`](decisions/) — the arguments behind all of it. Where this
  guide gives advice, a decision gives the reasoning and the reversal condition;
  [0025](decisions/0025-a-failure-buys-one-agent.md),
  [0028](decisions/0028-the-backoff-is-the-recipes.md),
  [0031](decisions/0031-a-run-that-never-started.md),
  [0032](decisions/0032-the-page-is-organised-by-attempt.md),
  [0033](decisions/0033-the-third-kind-of-agent.md) and
  [0034](decisions/0034-the-run-log.md) are the six it draws on most.
- [`doc/experiments/`](experiments/) — things actually run against real data,
  with their results, including the ones that did not work.
  [001](experiments/001-cold-review-issue-58.md) and
  [006](experiments/006-the-loop-closes-unattended.md) are the two this guide
  quotes.
