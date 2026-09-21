# 0057 — A gate's agent that started and did not finish gets one retry, then a person

**Status** accepted · 2026-09-21 · **extends
[0041](0041-a-gate-that-never-ran.md)** with the neighbouring case it did not
cover · governed by [0031 §1](0031-a-run-that-never-started.md), whose rule
about where a classification lives is what shapes §4

An `agent:` action that started, crashed and produced no receipt judged nothing.
It is not a refusal of the diff, it buys no fix round, and it does not stand the
conductor down. It is retried once, on the log, and then it is a person's.

## Context

A gate's agent has three ways to end and the code has two.

| what happened | today | consequence today |
|---|---|---|
| judged, and refused | `GateFailed` | buys a fix round |
| never started — an account-wide wall | `GateNeverRan` ([0041](0041-a-gate-that-never-ran.md)) | pushes, **stands the conductor down**, releases. No round |
| **started, crashed, no receipt** | `GateFailed` | **buys a fix round** |

The third row borrows the first row's event, and everything downstream believes
it. `packages/actions/src/agent-gate.ts:398` branches on
`failure.kind === "never-started"` and returns `verdict: "never-ran"`; a `crash`
falls through to `failed` at `:410` with `findings: []` and a sentence of
evidence. `gate.ts` appends `GateFailed`, `run-once.ts` calls `buyRound`, and
`decideFix` sees `on: "output"` with non-empty evidence and buys one.

**A fixing agent is then paid to answer a question nobody asked.** Measured, on
`#192`'s run `run-9e510ffc`:

```
09:54:21  proposed:review receipt  no receipt on the stream · exit 1
09:54:21  proposed:review failed · after 1s · round 2
09:54:22  fix     round 3 for review
09:54:36  fix:3   agent   I'm not fixing anything this round, and I committed nothing.
                          **Why:** the review never looked at the change. It crashed before starting…
```

The fixing agent worked out in fourteen seconds what the log could not say at
all. The item then ends at `lingtai:waiting` looking like a judgement about the
diff.

### Why it stayed hidden

A `run:` action that exits non-zero **is** a refusal, and `GateFailed` was
designed for exactly that. An `agent:` action's own failure borrowed the same
verdict because, until `#133`, no second agent in a pass had ever run —
`agent-gate.ts` existed and had never once executed (`d4fbd1a`). 0041 then
carved out the quota case and left the rest as `failed`, **with its evidence
sentence as the only place the difference is written** — and a sentence is not
something `decideFix` or the board reads.

## Decision

### 1. A third ending, told apart by the log and not by prose

`verdict: "did-not-finish"` beside `failed` and `never-ran`, and its own event
beside `GateFailed` and `GateNeverRan`. **An event or a field, never the
evidence text.** The whole defect above is a difference that existed only in a
sentence, and a second reader of that sentence is the thing 0031 §1 forbids.

The evidence still carries the runtime's own words, whole. They are about the
machinery, never about the diff, and the card must say so.

### 2. It buys no round

[0025](0025-a-failure-buys-one-agent.md) spends an agent on a failure **of the
diff**. Nothing was learned about the diff here, so there is nothing for a
fixing agent to carry. `buyRound` never sees this verdict.

### 3. It does not stand the conductor down, and that is the whole difference
from 0041

0041 stops everything because *never started* means an account-wide wall: a
quota, a signed-out runtime. Per-item backoff answering an account-wide
condition is what eighty events in ninety-two seconds looked like, and standing
down is right for it.

**A crash is local.** It is a bad settings path, a broken binary, a reused
session id (`#195`), a CLI that died after twenty turns and three dollars.
Stopping the machine for the rest of the queue would be the same category error
0041 fixed, pointed the other way.

### 4. One retry, recorded, and it belongs to the pipeline

The same action runs again, once. If it comes back with a verdict, the pass
continues exactly as though the first attempt had not happened — a refusal then
buys its round as it always did. If it crashes again, the pass stops and the
item is a person's.

**One, because of what these crashes are.** The observed causes either succeed
immediately on a second attempt or fail identically; a second retry buys
neither. The ceiling this adds to a pass is one review, and it is the cheapest
correct behaviour available: today's bug spends a *fix* round, which is a whole
agent run plus the re-review after it.

**In `gate.ts`'s pipeline, not inside `agent-gate.ts`.** Two reasons, and the
first is 0031 §1's: the adapter classifies, and what a classification *costs* is
decided where events are emitted. The second is that a retry nobody can see did
not happen — the pipeline is what appends, so a retry there is on the log by
construction, and one hidden inside the action would be a second attempt the
board cannot explain.

## Consequences

**`run-once.ts` gains no new ending.** A pass that stops here releases the item
the way every other non-landing pass does. What changes is which endings reach
`buyRound`, and that nothing about the conductor's own availability is inferred
from a local crash.

**The board gains a state it must not draw as a refusal.** A card saying *the
reviewer crashed and was retried* is a different sentence from *the reviewer
refused this diff*, and [0016 §4](0016-the-settled-model.md)'s rule applies: the
two must be distinguishable, not collapsed for tidiness.

**A crash that is really a wall stays 0041's.** Nothing here re-reads a message
to decide which it was; `failure.kind` is the adapter's answer and this ADR
consumes it. A runtime that misclassifies a quota wall as a crash is a bug in
that adapter, fixed there.

**What this does not decide.** Whether the implementing agent — not a gate's —
deserves the same treatment when it crashes without committing. That is the same
shape and a different budget, and it has not been measured.
