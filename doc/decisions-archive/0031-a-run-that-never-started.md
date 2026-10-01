# 0031 — A run that never started is its own outcome, and a quota stops the conductor

**Status** accepted · 2026-09-09 · applies
[0025](0025-a-failure-buys-one-agent.md) §1's classification to a case it did
not have; declines a lane, per [0016](0016-the-settled-model.md) §8

## Context

Six runs, ninety-two seconds:

```
03:44:14  wi-lingtai-80   crash   You've hit your session limit · resets 11pm (America/Chicago)
03:44:39  wi-lingtai-81   crash   …
03:45:03  wi-lingtai-83   crash   …
03:45:27  wi-lingtai-85   crash   …
03:45:52  wi-lingtai-86   crash   …
03:46:16  wi-lingtai-97   crash   …
```

Eighty events, six claims, six worktrees, six branches. `costUsd` on every one
of them: **nothing**. No agent ever started.

Three things are wrong and each is its own decision.

**It is not a crash.** Under 0025 §1 this is `lingtai`'s own failure, and
`repair.ts:34` already describes the class exactly: *"An agent pointed at one of
these has no access to the thing that is broken and nothing it could change; it
would spend money to report that it cannot see anything."* A quota is the
strongest case in that class — the agent cannot start at all. No repair was
bought, but by luck: nothing in `decideRepair` says a crash is not the
repository's.

**The granularity is wrong.** An account-wide limit was met with per-item
backoff. Every item in the queue would have failed identically, and six of them
proved it in a minute and a half.

**The reset time was discarded.** The message said `resets 11pm
(America/Chicago)`. At 23:12 the limit had lifted; the six items sat until
~23:45, because a flat hour outranked a fact the system had been handed.

### Neither runtime offers a structured signal

Claude Code 2.1.263's result subtypes, read out of the shipped bundle rather
than out of documentation:

```
success · error_during_execution · error_max_turns
error_max_budget_usd · error_max_structured_output_retries
```

**No quota member.** The bundle does carry `rate_limit_error`, `resets_at` and
`rate_limit_type` (`five_hour` / `seven_day`) — but that schema describes itself
as *"Quota-429 headers surfaced by the retry banner"*: the interactive UI, not
`--print`.

And the sentence is assembled, not fixed —
`` `You've hit your ${e}${t}${d}` `` over a table of prefixes: *"You've hit
your"*, *"You've reached your"*, *"You're out of usage credits"*, *"Your org is
out of usage · add funds to continue"*, *"…contact your admin"* — with further
branches for `org_spend_cap_reached`, `org_level_disabled_until` and
`out_of_credits`.

Codex is worse: `rate_limits` is always `null` in exec mode
([openai/codex#14728](https://github.com/openai/codex/issues/14728)) — the
source handles `RateLimitsUpdated` and the field is never populated.

**So the classification cannot rest on the message.** That is the constraint the
rest of this decision is shaped by.

## Decision

### 1. The outcome is `never-started`, named for what is true

The six runs share something no wording can take away:

> zero turns · zero cost · `is_error`

A run that spent nothing and took no turns did not fail at its task. **It failed
to begin.** That is checkable, language-independent, runtime-independent, and it
covers the whole family: a quota, a signed-out runtime, a missing binary, an
expired credential.

**Not `quota`.** Naming the outcome for a cause we inferred from prose would be
a claim the evidence does not support, and the first re-worded message would
turn the name into a lie. The prose is kept as `detail`, whole; it is evidence,
not a verdict.

### 2. It is Lingtai's failure, so it buys no agent

Written into `decideRepair` rather than left to luck. An agent dispatched at a
quota cannot start either, and would be a second charge for a report addressed
to the one person who did not need it.

### 3. The conductor stops — the item does not back off

The first `never-started` pauses the conductor, through `ctl-conductor`, the
same mechanism `pause` uses and the same one `lingtai shutdown` will
([0030](0030-shutting-down-safely.md) §2).

Per-item backoff is the wrong instrument for an account-wide condition, and
`80` events in `92` seconds is what using it looks like. The items keep their
place; nothing is taken from anybody.

### 4. The message is read for a time, and never for a verdict

Where the detail carries a reset (`resets 11pm (America/Chicago)`), it sets when
the pause lifts. Where it does not, or cannot be parsed, the recipe's backoff
does ([0028](0028-the-backoff-is-the-recipes.md)).

**A parse that misses costs efficiency and never correctness.** That asymmetry
is the whole reason §1 refuses to classify on text: the same brittle string is
safe to read for a hint and unsafe to read for a decision.

### 5. Resume is automatic, and visible while it lasts

At the reset time, without anybody watching. The alternative is what happened:
the limit lifted at 23:00 and the queue was still idle at 23:12, waiting out a
guess.

The pause is on the board while it holds — the chip `#77` added, which already
names who paused and why and carries a Resume. A quota pause is exactly that
shape and needs no new UI.

### 6. The card carries the detail, not only the kind

```ts
release: `run failed: ${outcome.failure.kind}`,   // run-once.ts:800
```

Kind only. `history.ts:130` renders `${kind}: ${clip(detail)}`, so the reason is
in the history and never on the card — a person sees `run failed: crash` and
cannot learn it was a quota without opening the detail page and reading the log.
That single interpolation is why tonight's incident was unreadable from the
board.

## What this does not add: a lane

**No `blocked` lane.** `waiting` already means *will not be taken again* — `#89`
sits in it, and `lingtai status` reports `0 runnable — 1 waiting on you`. A
second column for one meaning is what 0016 §8 declined: it makes the board wider
without making it say more.

What actually reads the same is three states inside **Queued**:

| the card is | the card says |
|---|---|
| never tried | — |
| failed, returns at 23:45 | `run failed: crash` |
| the conductor is stopped, so nothing here moves | `run failed: crash` |

`board.ts:112` already admits the first pair:

> A card whose last attempt failed sits in Queued **looking exactly like one**
> [that has not been tried]

and `lingtai status` has said `[backing off — runnable in 32m]` since 0028 §4.
**The board has not caught up with the CLI.** That is rendering debt against
states that already exist, not a missing state — and §3 gives the third one an
owner it did not have.

## Consequences

- `RunFailed.kind` gains `never-started`; `RunOutcome.failure.kind` with it.
  Additive, so no event is rewritten.
- `decideRepair` names it Lingtai's, with a test.
- `ControlState` folds a pause that carries an expiry — the first control state
  that ends by itself. `pause` by a person does not, and must not start.
- A drain (0030) and a quota pause can hold at once. They compose: one stops
  taking work and exits, the other stops taking work and resumes.
- The board renders the detail, and says which of the three a Queued card is.
