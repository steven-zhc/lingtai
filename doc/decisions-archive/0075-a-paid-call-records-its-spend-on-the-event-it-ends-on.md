# 0075 — A paid call records its spend on the event it ends on, and a reviewer's ends on a step

**Status** accepted · **Date** 2026-09-30 · **Supersedes**
[0073](0073-tokens-go-on-the-event-and-money-never-does.md) §4, which named four
events and assumed a reviewer's spend was already on one of them · **Leaves 0073
§5 alone** — money is still computed where it is displayed, never inside a fold,
and the rate card is still a file a person edits

## 1. Four events, and none of them is a reviewer's

0073 §4 decided the token group goes *"on each of the four events that carry
[`costUsd`]"* — `RunFinished`, `FixApplied`, `DiscussionAnswered`,
`DiscussionHeld`. That list came from grepping `events.ts` for `costUsd`. It is
a correct grep and it produced a wrong conclusion:

| event | who appends it |
|---|---|
| `RunFinished` | the implementer only — `conduct.ts:2653`, `:2686` |
| `FixApplied` | the fixer only — `:2827` |
| `DiscussionAnswered`, `DiscussionHeld` | `discuss.ts` only |

**A reviewer appends none of them.** It runs through `agent-action.ts`, whose
`ActionResult` (`packages/actions/src/action.ts:91`) carries `verdict`,
`evidence`, `findings` and `leftTheTreeAt` — and no field for what the call
spent. So the turns and the dollars are interpolated into prose
(`agent-action.ts:558-561`):

```ts
const cost = outcome.costUsd === null ? "" : ` · $${outcome.costUsd.toFixed(2)}`;
return {
  verdict,
  evidence: boundedEvidence(`${summarise(findings)}\n\n(${outcome.turns} turns${cost})`),
```

`StepFailed` then carries that string and nothing else — `evidence: z.string()`.
For Codex, whose `costUsd` is always `null`, the ternary yields the empty string,
so **the entire durable trace of a cold review is `(4 turns)` inside an evidence
blob**. A judge's spend does not even reach that far: it is a run-log line
(`conduct.ts:1844`), and the run log is deleted when a ticket lands (0034).

**So 0073 built as written would not have moved its own motivating example.** §1
of that document opens on *"a Codex review costs nothing on the board"*. Adding
the group to those four events leaves it costing nothing.

## 2. How it was found, and what it cost to find

A `design` step, `run-9fcfebed`, **14 turns and $0.98**, asked instead of
building:

> None of the four events #316 names is written by a `review:` agent, so doing
> exactly what the ticket asks leaves its headline problem in place … That goes
> beyond 0073 §4's list of "the four events that carry it", which assumes a
> reviewer's spend is already on one of them, so it would need a superseding ADR.

It was right, and 0073 was four hours old. **This is the cheapest thing that
happened that night** — against passes costing $8 to $36 — and it is the
argument for the `design` step that experiment 015 did not set out to make:
its other return is refusing to build the wrong thing.

## 3. `#208` said it first, and 0073 did not listen

That ticket's implementation contract, item 5:

> **Facts and money remain in durable events, not only in evidence strings.**

It has been open since before 0073 was written, and it is the same sentence this
decision reaches by a longer road.

## 4. The evidence that it is not hypothetical

`#275` landed on 2026-09-30 at about 00:33. Its run log was deleted the moment it
did, because *a run that landed has no log* (0034). Its `implement` and `fix`
spend survive on `RunFinished` and `FixApplied`. **Its two `claude-opus-5` cold
reviews — one of them 40 turns and $5.42 — exist nowhere.** Three more passes
the same night (`#243`, `#308`, `#317`) are in the same state, and their logs
survive only because those tickets did not land.

The shape of the loss is worth naming: **the number is legible for exactly as
long as nobody needs it, and gone at the moment a person asks what the reviewer
cost.**

## 5. The decision

**A paid call records its spend on the event that call ends on.** Concretely, in
addition to 0073 §4's four:

- the **step** events a reviewer or a design agent ends on — `StepPassed`,
  `StepFailed`, `StepDidNotFinish`, `StepNeverRan`;
- the judge's record, which today is a log line and must become an event or an
  event's field.

Two consequences follow and are part of this decision:

- **`ActionResult` grows a spend field.** The conductor cannot append what the
  action never handed it, and today the action hands it a sentence. This is the
  mechanical half; without it the step events have nothing to carry.
- **`costUsd` stops being interpolated into `evidence` prose** once it is on an
  event. The same number in two places, one of them unparseable, is how the
  first version of this was missed.

**0073's other rules are unchanged and carry over to the new fields**: every
field optional, absent meaning *this runtime did not say* and never zero; the
five counts rather than a sum, accumulated across turns; the model and the mode
beside them, because a rate is a function of (model, mode, when); and money
computed where it is displayed, never inside a fold.

## 6. What this costs

More events to widen, and a field on a type that four kinds of action construct.
0073 §4's own argument for `optional` is what keeps that safe: a constructor
that misses the field still compiles, still parses, and reads as *not said* —
which is what it is. The alternative, a required field on a shared type, is
`#89`'s failure and is refused for the same reason it was there.

## What this does not decide

- **Where money is displayed**, or by whom. 0073 §5 stands: not inside a fold,
  and `doc/rate-card.md` is where the rates live.
- **Whether a runtime can be constrained to emit valid JSON** at the command
  line. That is its own question, raised by `#318`, and is unrelated to where a
  number is recorded once it exists.
- **What the board does with three kinds of number** — reported, estimated and
  unknown. `#208` owns that and this only makes the second one possible for a
  reviewer.

## Related

- [0073](0073-tokens-go-on-the-event-and-money-never-does.md) — superseded in §4
  only. Its §1 problem statement, §3 mapping table, §5 fold rule and §6
  staleness obligation all stand as written.
- [0034](0034-the-run-log.md) — *a trace is a bounded explanation, not the
  durable record*, and a run that landed has no log. That is why §4's loss is
  permanent rather than merely inconvenient.
- [#208](https://github.com/steven-zhc/lingtai/issues/208) — said it first, in
  its own contract, and is blocked on the ticket this decision corrects.
- [#316](https://github.com/steven-zhc/lingtai/issues/316) — the ticket whose
  `design` step found this, and which this decision re-specifies.
