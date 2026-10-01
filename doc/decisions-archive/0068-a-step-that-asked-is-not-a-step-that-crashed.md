# 0068 — A step that asked and a step that crashed are two endings, not one ending and a string

**Status** accepted · **Date** 2026-09-29 · **Refines**
[0057](0057-a-gate-that-did-not-finish.md), whose grouping is by *cost* and stays
true of both halves · **Builds**
[0058](0058-lingtai-is-a-development-pipeline.md) §3c, which gave `admit`,
`design` and `implement` a destination this type could not express · **Spends**
[0061](0061-the-recipe-is-the-pipeline.md) §7 for the fourth time
([014](../experiments/014-the-log-before-the-fourth-reset.md))

## 1. What was one thing

`StepDidNotFinish` covered two outcomes that go to different places:

| | where it goes | what a person does |
|---|---|---|
| the step's agent **stopped and asked something** | `proposed`, and a judge or a person | answer it |
| the step's agent **crashed, timed out, spent its turns** | nowhere — the pass stops | look at it |

What separated them was `because`, a plain `string`:

```ts
function goesToTheRouter(ending: StepEnding): ending is StepRefused | StepDidNotFinish {
  if (ending.ending === "refused") return true;
  return ending.ending === "did-not-finish" && ending.because === NEEDS_INPUT;
}
```

**So a control-flow decision was taken on a free-form field**, and four call
sites took it: `endingOf`, `goesToTheRouter`, `onOffer` and `sentBackTo` in
`pass.ts`, `directionOf` in `pass-steps.ts`, and the card's `needs` in
`conduct.ts`. Every one of them compiles if the token is spelled `"needs input"`,
if a plugin sets no `because` at all, or if an action that can ask forgets — and
each of those silently *loses the destination*: a pass with a question in it stops
for an acknowledgement instead of reaching a judge.

Nothing had gone wrong. That is the argument for doing it now rather than against
it: `#279` is the same class caught afterwards, where *the reviewer had no
opinion* and *nobody could read the answer* shared `findings: []` and a $8.97
review was discarded under a sentence that read like an ordinary result.

## 2. The decision

**`asked` is its own ending, with its own event type, and `did-not-finish` keeps
`because`.**

```ts
{ ending: "asked", at, detail }                    // detail is the question
{ ending: "did-not-finish", because, at, detail }  // because is for a person
```

- **`asked` has a destination and no `because`.** *It asked* is the whole of the
  reason, and a field that can hold one value is the free-form string this exists
  to be rid of. `detail` is the question, in the agent's own words
  ([0043](0043-evidence-is-plain-text.md)).
- **`did-not-finish` has no destination and keeps `because`**, because the field
  is not the problem. It still carries `conflict` and `verify-failed` from the
  merge lane, `claim-unconfirmed`, `passed-over` and `not-claimed` from `claim`,
  `END_UNRESOLVED` from `end`, `threw`, and `action-refused` at a step the
  workflow does not let refuse. Removing it would break the lane's own reason
  travelling to `proposed`, which is 0058 §3c's other half.
- **`StepAsked` is the event**, beside `StepDidNotFinish`. Same payload, different
  name, and the name is the whole of the split to anything reading the log.
- **`NEEDS_INPUT` is compared exactly once**, in `runActionPipeline` — the file
  that defines the token — which answers `askedAt` beside `didNotFinishAt`. Above
  the pipeline nothing spells the token to decide where a pass goes. What survives
  of it is the `when:` a `judge:` is declared at, which is a name in a closed
  vocabulary rather than a branch on a string.

## 3. What this does not change

**0057's grouping is by cost and it still holds.** Neither ending buys a fix
round, neither stands the conductor down, and both leave the item where it is.
This splits them by *destination*, which is a different axis: 0057 §1–3 reads
correctly over both halves and needs no amendment.

**The five directions a judge answers are the same five.** `needs-input` is still
one of them, still has two producers — `design`'s question and `implement`'s hook
— and is still answered by a person where no `judge:` is declared, because
`BUILT_IN_FOR["needs-input"]` is null.

**No step gained or lost the ability to ask.** `admit`, `design` and `implement`
are the three, as 0058 §3c says; what changed is the type they say it with.

## 4. The board draws them apart

They shared `t-never` — hatched, in the fail colour, the one mark on the bar that
means *this is Lingtai's bug* — so a step waiting for an answer wore it. `asked`
is the same hatch in the held colour, which is `waived`'s, because what stands in
for a verdict is a person either way; the step's name beside it is `--held` and
not `--fail`.

The sentence changes with the mark. `did not finish — nothing judged this diff`
over a design agent's question asks an operator to acknowledge a failure that did
not happen, and the card's `needs` field said `acknowledgement` where the thing
the pass was waiting for was a judgement. `the-card.md` carries the table row.

## 5. The log is changed, not upcast — and this is the last time that is free

**No upcaster.** This is pre-1.0 and 0061 §7 allows none for a reset, which is the
precedent `#247` set for the eight `Gate*` renames: they moved with a reset rather
than through a chain.

**And here an upcaster could not have been honest anyway.** `because` was the
*pass's* field and was never on the event, so no stored `StepDidNotFinish` can be
told which half it was. A chain would have had to guess, and a guess that
relabels a crash as a question is worse than a log that starts empty.

The current log was opened on 2026-09-27 when the database moved to its own host,
so it holds about two days: this epic's own passes and nothing older.
[014](../experiments/014-the-log-before-the-fourth-reset.md) is written before the
cut for the reason 007, 010 and 013 were — not because two days is precious, but
because the habit is what makes a reset a decision rather than a loss.

**After 1.0 this is no longer free and the answer becomes an upcaster.** A split
of this shape then needs the discriminant on the event *before* the split lands —
put `because` on the payload, ship it, and the chain has something to read. That
sentence is here so the next person knows which side of the line they are on.

## Consequences

- A plugin author writes `{ ending: "asked", at, detail }` and cannot spell it
  wrongly; `doc/writing-a-plugin.md` carries the five endings.
- `StepVerdict` and the board's `StepState` gain `asked`; `refusingOn`
  (`approve.ts`) counts it unpassed, because a question nobody answered is not a
  judgement of the diff.
- `attempts.ts` clears it from `unfinished` and puts nothing in `evidence`: a
  question has nothing to say to a fresh attempt, which is `StepNeverRan`'s and
  `StepDidNotFinish`'s argument used a third time.
- The log is reset when this lands. Anything that cites a `seq` from before it
  cites nothing ([1.0](../design/1.0.md)).

## Related

- [0057](0057-a-gate-that-did-not-finish.md) — a step that did not finish buys no
  fix round. Refined, not superseded: that grouping is by cost and stays true of
  both endings.
- [0058](0058-lingtai-is-a-development-pipeline.md) §3c — `admit`, `design` and
  `implement` may reach `proposed` carrying a question, and *only one of them is
  charged for*. This is the type that says which.
- [0061](0061-the-recipe-is-the-pipeline.md) §7 — no migration for a reset, which
  is what makes this affordable and what stops being true at 1.0.
- [0031](0031-a-run-that-never-started.md) §1 — *a caller reads a field rather
  than a sentence*, which is the rule this applies to the one field it was still
  being broken in.
- `#279` — the same class, caught after it cost $8.97. The difference is that
  nothing had gone wrong here yet.
- `#247` — event types renamed with a reset rather than through an upcaster.
