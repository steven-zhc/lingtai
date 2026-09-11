# 0038 — A finding buys an agent before it buys your attention

**Status** accepted · 2026-09-10 · extends
[0025](0025-a-failure-buys-one-agent.md) with a second budget it deliberately
did not have; gives the third severity in `agent-gate.ts`'s rubric somewhere to
go

## Context

The cold reviewer started working on 2026-09-10, and by that evening three work
items were waiting on a person:

| | severity | what the reviewer said | is the fix in doubt |
|---|---|---|---|
| `#123` | `blocker` | `subscribers.ts:71` — a failed log read is swallowed and the delivery resolves as a success | **no** |
| `#132` | `major` | `discussion.tsx:152` — the trace's deletion races the board's re-render | barely |
| `#134` | `major` | `page.tsx:676` — with no cards the reading renders as text, not a link | **no** |

**The most serious of the three has the least doubtful fix.** All three were
sitting on a person because there is exactly one rule between a finding and a
queue position:

```ts
// packages/actions/src/agent-gate.ts:234
/** Blocker or major refuses. A minor is worth knowing and not worth stopping for. */
export function verdictFor(findings: readonly GateFinding[]): "passed" | "failed" {
  return findings.some((f) => f.severity === "blocker" || f.severity === "major")
    ? "failed" : "passed";
}
```

A gate refuses, the item blocks, a person decides. **There is nothing between
"refused" and "your problem".**

### Severity is the wrong axis

It measures how bad a defect is, not how hard the judgement is. A swallowed
error is a blocker with one obvious fix; "this abstraction is premature" is a
minor with three fixes that are not equivalent. The table above is that
inversion happening in one afternoon.

### The axis that works is already in the rubric

```
No failure scenario, no finding. An observation without one is an opinion.
```

**A finding with a concrete failure scenario determines its own fix**: make that
sequence stop producing that outcome. A finding without one was refused at the
door. So every finding this system admits is, by construction, one an agent can
be asked to address — and what is left for a person is not a category of
finding but a *disagreement about one*.

## Decision

### 1. A refusal buys an agent, then asks again

```
review refuses
  └── an agent fixes, given the findings
        └── review runs again
              ├── passes → it lands
              └── refuses → a person
```

No new mechanism: [0025](0025-a-failure-buys-one-agent.md) already says a
failure buys an agent. What was missing is that a gate's refusal is a failure
it did not count.

### 2. The re-review checks the scenario, not the sentence

**The reviewer and the fixer are both agents, and a fix that silences a finding
is not a fix.** Deleting the line, renaming the symbol, or adding a suppression
all make the text go away with the defect intact — Goodhart, with an LLM on each
end of the measure.

The guard is the rubric's own requirement, used a second way: the fixer is given
each finding's **`failureScenario` verbatim**, and the re-review is asked
whether those sequences still produce those outcomes. **The scenario is the
acceptance criterion, and it was written before anybody knew what the fix would
be** — which is what makes it one the fixer cannot author.

### 3. The fixer gets the findings and the diff, and not the reasoning

Not the implementer's plan, transcript or session. Experiment 001 is about
exactly this: *self-review after a long implementation is not a second opinion*,
and a fixer handed the reasoning that produced the defect inherits the reasoning
that produced the defect. The task is bounded — **make these scenarios stop
happening, and change nothing else** — and bounded is what makes it cheap.

### 4. Two budgets, because one purse was being spent by two kinds of failure

`repair.maxAttempts` is documented as

> The ceiling, per work item, **across every distinct failure**. — `recipe.ts:439`

and counts `integration | project | run` (`repair.ts:78`). Adding review
refusals to that counter produces this:

```
the build broke   → spends repair 1 of 1
review refuses    → nothing left → a person
```

**A bad build eats the review budget**, on an item whose finding might be one
line. And the two failures do not resemble each other:

| | the evidence | how determinate the fix is |
|---|---|---|
| the build broke | a compiler error | very |
| review refused | a failure scenario | high, and a judgement |

So `fix` is its own number beside `repair`:

```yaml
repair:
  maxAttempts: 1   # what a wall buys — 0025's
  fix: 2           # what a finding buys: rounds of fix-and-re-review
```

**0025 deliberately kept one number** and this adds a second, so the reason is
recorded rather than assumed: a single ceiling means the first kind of failure
to occur decides whether the second kind gets an attempt at all. That is not a
budget, it is a race.

The default for `fix` is 1 for 0025 §3's reason unchanged — the smallest number
that makes the feature exist, raising it is the repository's call.

### 5. `minor` goes to a backlog, and a person turns one into a ticket

`minor` passes today, and that is right — it is not worth stopping for. What is
wrong is what happens to it:

```ts
// packages/domain/src/events.ts:445
export const GatePassed = z.object({ ...gateBase, evidence: z.string() });
```

**`GatePassed` has no `findings`.** A minor finding on a passing gate is flattened
by `summarise()` into a line of prose — severity, file, line and failure scenario
all still there as text, and none of it as data. **The rubric's third tier is
write-only**: not unread, but recorded in a form nothing can read.

So: `GatePassed` carries findings, and they collect in a backlog a person
triages in batches. Accepting one opens an issue.

**Which is the store's job, not a new one.** A ticket is a fact the repository
has and Lingtai does not decide which issues exist
([0012](0012-one-task-view.md), [0036](0036-the-core-takes-a-ticket.md) §1), so
proposing one is a write through the same `TicketStore` that supplies them —
`propose`, beside `list`, `get` and `save`. **Lingtai proposes; a person decides
it exists**, which is 0016 §1's line held exactly where it was.

Deciding *in code* which minors deserve a ticket is refused: a minor is by
definition low-stakes, triage in batch is cheap, and any rule general enough to
write would be one nobody could predict the behaviour of.

## Consequences

- **`verdictFor` stops being the whole policy.** It says whether the diff is
  refused; it no longer decides who hears about it.
- **An item's cost grows by up to `fix` reviews.** A review measured at $2.34 on
  `#122`, so the default of 1 puts the ceiling near the price of a build.
- **A person sees disagreements, not findings.** The thing arriving at a queue
  is now *two agents looked at this and did not agree*, which is a judgement in
  a way a swallowed `readFile` is not.
- **`watch:` stays the other half, and is untouched.** A diff that reaches a
  reserved path wants a person whether or not anything is wrong with it, and
  that is a different question from this one — the recipe carries it, commented,
  above the review action.

## Open

- **What a minor's backlog entry is keyed by.** The same finding will be made
  again on the next attempt of the same item, and twice is one thing to triage,
  not two.
- **Whether the fixer may decline.** A finding it believes is wrong has no move
  today except to change the code anyway — which is the failure this decision is
  most likely to produce, and the one nothing here detects.
