# 0039 — The worktree is the whole of a pass, and a refusal never costs it

**Status** accepted · 2026-09-11 · supersedes
[0025](0025-a-failure-buys-one-agent.md) §2–§3 and
[0038](0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §4;
collapses three ceilings into one

## Context

0038 gave a refused review its own purse, on the argument that a shared ceiling
is a race: whichever failure happens first decides whether the other gets an
attempt at all. That argument was right and it did not go far enough — it drew
the line between *kinds of failure* when the line that matters is somewhere
else.

Three refusals, three destinations, all on 2026-09-11:

| what refused | where the work goes | what it costs |
|---|---|---|
| `review`, with findings | back to the agent, **same worktree** | one round |
| `build`, red | on to the merge lane, refused `gate-failed`, `decideRepair` | **a whole new run** |
| the lane, on a conflict | `decideRepair` | **a whole new run** |

The first is cheap because the work is still there. The other two are expensive
**for one reason and it is not a reason about failures**:

```ts
// packages/conductor/src/run-once.ts:53
// The scopes also encode an ordering that used to be a comment beside an
// explicit call: *the worktree is gone before the integrator runs*, because
// the integrator is outside its scope.
```

**That "because" is circular** — the worktree goes first because the integrator
is outside its scope, and nothing says why the integrator is outside its scope.
An ordering nobody wrote a reason for is deciding that two of the three
refusals throw away a working branch and re-implement it.

### What was argued and did not survive

`fix.ts` refuses to buy an agent for a refusal carrying no findings:

> **No failure scenario, no fixer.** … asking a fixer to "address" a typecheck
> failure with no scenario to hold it to would be exactly the unbounded
> rewriting 0038 §2 is about.

**It mistakes "no `findings` field" for "no acceptance criterion."** A red build
has one, and a stronger one than a finding's:

| | who wrote the evidence | the criterion | can the fixer fake it |
|---|---|---|---|
| a finding | **an agent, in prose** | another agent judges whether the scenario still happens | yes — delete the line, rename the symbol |
| a red build | the compiler, the test | **run it again; green is green** | only by deleting the test |
| a conflict | git, naming the files | the merge succeeds and the build stays green | no |

*Make it green again* is free, machine-checked, and **cannot be authored by the
thing being checked** — which is precisely what 0038 §2's guard was reaching for.

Four objections were raised against extending the loop and three did not hold:

- **"A first red build is the original task under a new budget."** Nearly: today
  that costs two runs (the implementer, then a bought repair); this costs up to
  `rounds + 1` in one worktree. The difference is one run, and the rounds are
  cheaper because nothing is re-implemented.
- **"The fixer can silence a build by deleting a test."** The pipeline re-runs
  **whole** — `build` then `review` — so the reviewer reads that diff, and its
  checklist already asks about *tests that assert less than they appear to*. A
  project with no reviewer has no reader; `watch:` over the test configuration
  is the guard there, and that is `tamper`'s existing purpose.
- **"A fixer cannot decline a failure that is not the diff's."** It can, and the
  code already handles it:
  ```ts
  // run-once.ts:1414
  if (!committed) { disagreement = { …, why: "the fixing agent committed nothing" }; break; }
  ```
  Committing nothing *is* the decline, and it becomes a disagreement a person
  sees. **What is missing is telling the fixer it may.** 0038's Open §2 claimed
  there was no move; that claim was wrong and is withdrawn.
- **"An agent inside the merge lane holds the lane's lock."** It would, and
  nothing proposes that. The lane aborts, refuses with the conflicting paths,
  and `integrate()` returns — **releasing the lock and its own worktree, which
  are one scope.** The agent then works in the *run's* worktree, outside the
  lane entirely, and the lane is re-entered afterwards.

## Decision

### 1. The worktree lives as long as the pass

`Effect.scoped` moves out to enclose the merge lane. Everything a refusal could
be answered by is then still on disk when the refusal happens, and **"a new run"
stops being the answer to anything except a run that ended.**

### 2. Any refusal returns to the agent, carrying its own evidence

```
a point refuses  →  the agent, in the same worktree, given what refused it
                      findings · the build's output · the conflicting paths
                 →  the whole point runs again
```

No kind of refusal is special. The three prompts differ in what evidence they
carry, which is a difference in one argument, not in the flow.

### 3. One ceiling, beside the two that bound a single run

```yaml
runtime:
  limits:
    turns: 150   # inside one agent run
    wall: 1h     # inside one agent run
    rounds: 2    # how many times a pass sends the agent back
```

`round` is the word the code already speaks — `FixRequested.round`,
`roundsSpent`, *round 1 of 2*. It is not `attempts`, which already means two
other things: `budget.attempts` is how much history a prompt carries, and an
*attempt* on the board is a claim.

**Putting it beside `turns` and `wall` is the point, not tidiness.** What one
pass may spend is then one block: `(rounds + 1) × wall`. On 2026-09-10 the drain
told an operator it would wait at most one `wall`, which the fix loop had
already made false — a sentence had to be rewritten to chase a number kept
somewhere else. Three numbers in one place cannot drift apart like that.

### 4. `repair` goes, all of it

`repair.maxAttempts` and `repair.fix` are what `rounds` now counts.
`repair.on` is **`rounds: 0`**, said in the block where the other limits are —
a boolean beside a count whose zero means the same thing is a redundant pair.

0025 §2 wanted the default's spend to be auditable, *shown when it is off as
well as when it is on*. That is better served here: `rounds` is in the block
anyone reading limits already reads, rather than a switch in a section of its
own.

### 5. The fixer is told it may decline

`fixBrief` says, in as many words: **if this failure was not caused by this
diff, change nothing and commit nothing.** The mechanism exists (§Context); an
escape hatch nobody is told about is not one.

## Consequences

- **`decideRepair` loses most of its work.** What is left is *whose* failure it
  is — `RUN_OWNER`, `source: "project"` — which is a question about blame, not
  about spending, and needs no recipe key.
- **A conflict is answered where it happened.** The base may move again while
  the agent resolves one; the lane is re-entered and may refuse again. That is
  ordinary optimistic retry, bounded by `rounds`, and each retry is seconds.
- **`(rounds + 1) × wall` is the real bound on a pass**, and the drain must say
  so from the numbers rather than from prose.
- **The board's cost columns change meaning.** `repair_costs` was *what
  diagnosing a failure cost, apart from the work*. Every round is now that, and
  the reading beside it needs a name that is true of all of them.

## Open

- **Why the integrator was outside the worktree's scope.** Nothing records it,
  and §1 overturns it. **The risk of this decision lives entirely in that
  unwritten reason** — whoever implements §1 has to look for what breaks when a
  worktree outlives the lane, rather than trusting that silence meant nothing.
- **What bounds re-claiming after a run that ended.** `rounds` bounds a pass; a
  crashed or quota-stopped run ends one, the item is released, and
  `source.backoff` holds it an hour before it is claimed again — for ever. That
  was true before this decision and is more visible after it, because `rounds`
  is now the only other number and plainly does not cover it.
