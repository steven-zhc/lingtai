# 0029: The prompt budget is the recipe's, and a limit is written down where a kind is

**Status**: accepted
**Date**: 2026-09-08
**Ticket**: [#96](https://github.com/steven-zhc/lingtai/issues/96)

## The finding

Six constants decided how much an agent is shown, and **not one of them appeared
in any document** — zero hits across `doc/`, `README.md` and `CLAUDE.md`:

| constant | value | what it decided |
|---|---|---|
| `EVIDENCE_CHARS` (`attempts.ts`) | 2 000 | how much of one earlier failure's output is quoted verbatim |
| `MAX_ROWS` (`attempts.ts`) | 5 | how many attempts the table names before "and N earlier" |
| `MAX_FINDINGS` (`attempts.ts`) | 5 | how many of a review gate's findings are listed |
| `EVIDENCE_LINES` (`command.ts`) | 60 | lines of command output kept as evidence |
| `EVIDENCE_BYTES` (`command.ts`) | 8 000 | bytes of it |
| `DIFF_LIMIT_BYTES` (`agent-gate.ts`) | 400 000 | past this the diff handed to a review agent is truncated |

Together they are the answer to *what does an agent know about why the last
attempt failed*, which is the whole premise of [#82](https://github.com/steven-zhc/lingtai/issues/82)
and of `repair` ([0025](0025-a-failure-buys-one-agent.md)). An agent that cannot
see the failure repeats it, and the ticket buys another agent.

**The defect was not the values.** They are well commented where they live —
`agent-gate.ts` cites [experiment 001](../experiments/001-cold-review-issue-58.md)'s
diff size as its evidence, which is better reasoning than most decisions get.
The defect is that they were never surfaced as a policy: prompt content is this
system's most expensive lever, and it was set in three files nobody reviewed
together.

## Why it stayed hidden

`doc/reference.md`'s sections were all enumerations — event types, gate points,
doctor checks — so **there was no section shaped like a rule**, and no budget,
limit or threshold had anywhere to be written down. That is the same structural
gap that hid the lease ([0027](0027-the-lease-is-deleted.md)) and the backoff
([0028](0028-the-backoff-is-the-recipes.md)); this is the third finding of the
same audit and the second to end in a recipe key.

## The decision

**1. Four of them are the recipe's, under `runtime.budget`.**

```yaml
runtime:
  budget:
    evidence: 2000    # chars of the last failure's output quoted into the next prompt
    attempts: 5       # rows the attempt table names before "and N earlier"
    findings: 5       # review findings carried into the next attempt
    diff: 400000      # bytes of diff a review agent sees
```

Here rather than compiled in for the reason 0016 §7 deleted the hardcoded skip
and 0028 moved the backoff: how much of a failure is worth quoting depends on
what this repository's failures look like. A build that prints one line and a
suite that prints two hundred do not want the same evidence budget; a repository
whose diffs carry generated files does not want the same diff bound. Those are
facts a repository knows and the core cannot see.

`runtime.limits` bounds what a run may **spend**; `runtime.budget` bounds what it
is **given**. They are the same kind of decision and they sit together.

**The defaults are the constants they replaced, unchanged.** A recipe that says
nothing renders exactly the prompt it rendered before, byte for byte.

**2. The numbers are passed in, never defaulted at the point of use.**
`attemptBrief`, `attemptOutcome` and `buildReviewPrompt` take the bound as an
argument, so the value has exactly one home — the schema. A second default
beside the call site would be a second place the answer lives, which is how
these got lost in the first place.

**3. `EVIDENCE_LINES` and `EVIDENCE_BYTES` stay constants, on purpose.** They
bound `runCommand`'s log tail, which is written into `GateFailed.evidence` — an
**event payload**. A recipe may decide what a run is told; it may not decide how
much a project writes into a log that is never rewritten and never deleted.
The recipe's `evidence` budget then clips that tail again on the way into a
prompt, which is the bound that is actually about cost.

`DEFAULT_RETENTION_DAYS` (2) stays a constant for a different reason: it is how
long a landed task stays on **the board**, one board across every project, so no
single project's recipe is the place to decide it. [0012](0012-one-task-view.md)
already decided the concept — *"Retention must not be in the projection, and this
is the part that is easy to get wrong"* — and only its value was unrecorded.

**4. `doc/reference.md` gains a `policy` section**, and it is the general form of
what 0028 opened: every number that decides behaviour rather than naming a kind,
with its value and where it is decided. A repository must be able to see what
governs its runs without reading Lingtai's source — the same rule that keeps an
empty gate point rendered as `skipped` rather than omitted (0016 §4).

## What this does not decide

Nothing bounds the *number* of attempts, and nothing here changes that. That is
a ceiling rather than a budget, and 0028 left it undecided on purpose.

Neither does this make `budget` visible in `lingtai add` or on the board.
`runtime.limits` is not rendered there either, and rendering one without the
other would be the asymmetry rather than the fix.
