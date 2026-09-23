# 012 — Where the turns go

**Measured** 2026-09-21, over the 14 days to that date · **Source** this
repository's own log, `events`, plus `~/.lingtai/runs/lingtai/*.log` ·
**Result** cost is linear in turns at ~$0.10 each, half the turns are the fix
loop, and the fix loop is fed almost entirely by one gate

## Why

*Every ticket seems to take 100+ turns and the tokens go fast.* That is a
question about where the loop actually spends, and this repository keeps the
only record that can answer it. Nothing below is an estimate: every number is a
fold over `events`, and the queries are reproducible from the shapes named in
each section.

**Kept as a baseline.** These are the numbers *before* anything was changed in
response to them. A later measurement that wants to claim an improvement has
something to compare against, and the three corrections in *What we had wrong*
are here so the same mistakes are not made twice on the same data.

## 1. A turn is the runtime's word, not Lingtai's

Lingtai does not count turns. `claude --output-format stream-json` prints a
`type: "result"` object carrying `num_turns`, and `claude-code.ts:382` reads it.
The bound is delegated the same way: `--max-turns` is passed to the binary
(`:203`), which stops by *ending the session* so the run still prints a receipt
with its cost — a SIGTERM from Lingtai "would record exactly the runs that
overspent as costing nothing".

An *agentic turn* is one step of the agent loop: the model responds, any tools
it called run, their results come back. In principle one turn can carry several
parallel tool calls. **In this repository it does not.** #215's implementing
agent, receipt `100 turns`:

```
45 Bash + 39 Edit + 11 Read + 1 Write = 96 tool calls     receipt: 100 turns
```

Its fix round: 19 logged lines against a receipt of 15. The work here is
sequential — edit, run, read, edit — so **a turn is a tool call**, near enough.

## 2. Cost is linear in turns, at about $0.10 each

`RunFinished` and `FixApplied` both carry `turns` and `costUsd`. Bucketed by
turn count, medians:

| turns | n | median turns | median $ | $/turn |
|---|---|---|---|---|
| 1–15 | 69 | 11 | $1.18 | $0.107 |
| 16–30 | 92 | 22 | $2.12 | $0.096 |
| 31–50 | 74 | 38 | $3.79 | $0.100 |
| 51–80 | 87 | 65 | $6.47 | $0.100 |
| 81–120 | 36 | 100 | $11.49 | $0.115 |
| 121–250 | 19 | 148 | $17.21 | $0.116 |

**The rate is flat, and that is the finding.** The obvious guess is that a long
run gets dearer per turn because turn 100 re-reads the first 99. It does not:
$0.100 at 38 turns, $0.116 at 148. Prompt caching is carrying the history, so a
turn's marginal cost is roughly its own uncached tail — the new tool output and
the new response — whatever came before.

The spread at a fixed turn count is narrow, which is the same claim from the
other side:

```
turns 31–50   n=74   $/turn  min .056  p25 .085  med .098  p75 .115  max .157
turns 51–80   n=87   $/turn  min .066  p25 .086  med .100  p75 .119  max .193
all           n=377  $/turn  p10 .071  med .104  p90 .152
implementer med $0.102        fix round med $0.107
```

**So tokens ≈ turns × $0.10, and nothing else is a lever of comparable size.**

The whole period checks out against that model: 21,126 turns, $2,303.

## 3. Half the turns are the fix loop

```
implementer runs   123 × mean 52 turns  ≈  6,400 turns
fix rounds         198 × mean 31 turns  ≈  6,140 turns
```

Medians: an implementing run is 44 turns (p90 99, max 224); a fix round is 24
(p90 68, max 151). **The fix loop is 49% of everything spent.**

## 4. One gate feeds it

Every gate action's `GatePassed` / `GateFailed`, counted:

| action | failed | passed |
|---|---|---|
| `install` | 3 | 260 |
| `build` | 34 | 357 |
| **`review`** | **231** | **74** |

`build` refuses 9% of the time. **`review` refuses about three times for every
time it accepts** — and each refusal is what buys a fix round. That ratio *is*
the fix loop; there is no second source.

### What the refusals are made of

231 refusals, 660 findings, median 3 per refusal (max 8):

```
worst severity in the refusal     all findings
  blocker   56   24%                minor   316
  major    151   65%                major   281
  (none)    24   10%                blocker  63
```

Two things to take from it.

**65% of refusals are topped by a `major`, not a blocker.** Majors are
judgement, and judgement is what three rounds of re-reading produces more of.

**10% of refusals carry no findings at all.** That is
[#196](https://github.com/steven-zhc/lingtai/issues/196)'s class measured: a
reviewer that crashed, recorded as a refusal of the diff, buying a fix round to
answer a question nobody asked. **24 of them in 14 days** — call it 750 turns
and $75 spent on nothing, which is what
[0057](../decisions/0057-a-gate-that-did-not-finish.md) was written to stop.

## 5. The loop converges, but it keeps opening new ground

For runs where `review` refused at least twice, comparing each round's findings
against the one before it, by file:

```
61 runs with ≥2 review refusals, 113 adjacent pairs
  same file as last round   166   60%
  a file not flagged before 111   40%
```

**60% carried means the fix agent is working the right files.** **40% fresh
means each round the reviewer also opens somewhere it had already read and
passed over.** That is why three rounds is often not enough and why the ones
that fail look like enumeration: the set being read out is not the diff's
defects, it is the reviewer's attention, and re-reading redistributes it.

[#179](https://github.com/steven-zhc/lingtai/issues/179) is the pathological
case of exactly this — nine passes, its findings landing on a different file
each round until the ninth named the thing underneath all of them.

## 6. Rounds are not waste: they land tickets

Every distinct work item in the window, against the most fix rounds any of its
passes reached:

| fix rounds | landed | did not | landing rate |
|---|---|---|---|
| 0 | 60 | 3 | 95% |
| 1 | 20 | 2 | 91% |
| 2 | 15 | 2 | 88% |
| 3 | 22 | 4 | 85% |

**57 tickets landed only because a fix round ran, and 22 of those needed the
third.** Cutting `rounds: 3` to 2 would have cost landings, not just money —
which is the opposite of what this measurement was started to confirm.

And the turns are not going into failures:

```
tickets that landed      17,353 turns   $1,873
tickets that did not      3,773 turns   $  430   ← 18% of turns
```

**82% of everything spent is spent on work that landed.** The cost of this loop
is not waste on dead tickets; it is what landing costs — 117 landed items
against 21,126 turns is **~148 turns, ~$16 per landed ticket** in agent time
(the per-ticket figure over claims is higher; see below).

## A postscript the same afternoon: `build` has the same failure mode

§4's *10% of `review` refusals carry no findings* has a `build` counterpart, and
it turned up twice within an hour of this being written.

`apps/cli/integration/world.test.ts:100` spawns a child `node` that type-strips the
daemon's whole import graph, and asserts an exit status and two lines of stdout
— **nothing about time**. Its bound was vitest's 5000ms default, which nobody
chose: idle the probe takes ~0.5–1.9s. Under `pnpm -r`, beside `apps/release`'s
binary builds, the same pass reported `import 66.28s` against 25–32s idle, and
it timed out.

It refused [#215](https://github.com/steven-zhc/lingtai/issues/215), then
refused [#196](https://github.com/steven-zhc/lingtai/issues/196) at 5686ms — on
a branch cut from `main` **110 seconds before** the fix that raised the bound
was pushed. Neither diff went near that import graph.

**Three separate agents reached the same diagnosis independently**, each
measuring the probe itself rather than editing the test: 0.50–0.75s head
against base over three runs each; 507/553/655ms; and the gate's own command run
twice on the tree at `EXIT=0` across 18 packages. All three declined their fix
round and said why. That is the behaviour the loop is supposed to produce, and
it still cost two fix rounds ($1.81 and $1.41), two human decisions, and two
waived gates.

**The generalisation is the thing to keep**: a gate can go red for a reason the
diff cannot cause, and when it does, every mechanism downstream treats it as
evidence about the diff. `review`'s version is a crashed reviewer
([0057](../decisions/0057-a-gate-that-did-not-finish.md), 10% of refusals);
`build`'s version is a test whose bound is a clock on a shared machine rather
than a claim about the code. Neither is rare, and neither is visible as
anything but a refusal.

One more thing that made it worse and is worth knowing: **`pnpm -r` stops at the
first failing package**, so a refusal's evidence is silent about every package
after it. #196's refusal said nothing about `packages/actions` (125 passed),
`packages/conductor` (387) or `apps/board` (437) — the run never reached them.
A reader of that evidence cannot tell a one-test flake from a broken tree.

## Reconciling with 011, which found the opposite

[011](011-patching-versus-starting-over.md) put one ticket's two arms side by
side and concluded *the fresh start, decisively — and it needed none of the
rounds it was given*. §6 here says rounds landed 57 tickets. Both are right, and
together they say something neither says alone.

011's arm A is §5's 40% in a single anecdote. Its three refusals were
`health.ts:55`, then `lingtai.ts:303`, then `daemon.ts:124` — **a different file
every round**, which is the enumeration signature and not a patch converging.
And 011 already named why:

> a refused review is a different kind of thing — the reviewer may be saying
> *this line is wrong*, or it may be saying *this approach is wrong*, and
> `rounds` cannot tell those apart.

So the population view and the case study divide cleanly along that seam.
**Rounds work when the refusal is about a line — 60% carried, 57 tickets
landed.** They fail when it is about the approach, and then they fail
expensively, because each round re-reads the whole diff and finds somewhere new
to be unhappy. Neither `rounds` nor anything else currently reads which kind a
refusal is; **the 40% is the closest thing to a measurement of that mix**, and
a refusal whose findings are all in files the last round already passed is the
shape worth learning to detect.

## What we had wrong

Three claims made from the same data before it was folded properly. They are
kept because each was wrong in a way that would have changed a decision.

**"Turns bound actions, not tokens — two runs at 44 turns can differ 10× in
cost."** No. At a fixed turn count the spread is 2.8–2.9× from min to max and
±20% across the interquartile range. Cost tracks turns closely, so *fewer
steps* is the lever and *smaller tool outputs* is not.

**"The landing rate is 47%."** That divided `WorkItemLanded` events by
`WorkItemClaimed` events, and a ticket is claimed again on every restart,
requeue and backoff retry. Folded per work item the rate is **91%** (117 of
128). Claims are a measure of how many attempts a ticket takes, never of
whether it succeeded.

**"Cut `rounds` from 3 to 2; round 3 has never saved a pass."** The query
behind that joined `WorkItemLanded` to a `runId`, and `WorkItemLanded` carries
`base` and `mergeCommit` and no `runId` at all — so every bucket read zero
landed and the absence looked like evidence. Section 6 is the same question
asked through the work-item stream: round 3 landed 22 tickets.

## What this suggests, and what it does not

**It does not suggest lowering `turns`.** The median implementing run is 44
against a bound of 150; the bound is not what these runs are meeting. Lowering
it converts long runs into `error_max_turns` — #179 hit that once at 151 turns
and $47.22 with nothing committed.

**It does not suggest lowering `rounds`.** Section 6.

**It points at the `review` gate**, which is the only thing feeding the half of
all turns that the fix loop consumes, and at two properties of it that are
measurable and not yet decided:

- a refusal topped by a `major` is 65% of them, and whether a `major` should
  refuse — or go to `finding_backlog` as a `minor` does (#137) — is a
  calibration question with a checkable answer
- 40% of each later round's findings are in files the previous round read and
  did not flag, which is a reviewer re-spending its attention rather than the
  diff getting worse

## Related

- [0057](../decisions/0057-a-gate-that-did-not-finish.md) — a gate's agent that
  crashed is not a refusal, and buys no round. §4's 10% is what it costs today.
- [0025](../decisions/0025-a-failure-buys-one-agent.md) — a failure buys one
  agent. §6 is the first measurement of whether that purchase pays.
- [001](001-cold-review-issue-58.md) — why the `review` gate exists: four
  defects that had already survived self-review, CI and a human read. §4 is its
  cost, measured on the other side.
- [011](011-patching-versus-starting-over.md) — patching against starting over,
  the same question one level up.
