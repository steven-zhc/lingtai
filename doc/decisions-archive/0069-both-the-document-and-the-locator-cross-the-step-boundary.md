# 0069 — Both the document and the locator cross the step boundary, and nothing above the plugin reads the locator

**Status** accepted · **Date** 2026-09-29 · **Decides** what
[0066](0066-a-large-answer-is-a-locator-on-the-log.md) §3 and §9 left open —
*what `WroteTheDesign` carries and what an `implement` plugin is handed* ·
**Depends on** [0066](0066-a-large-answer-is-a-locator-on-the-log.md) §4, *the
locator is a string and only the plugin that wrote it reads it*, which is what
makes the answer below cost nothing · **Changes nothing that runs**
([0065](0065-the-default-is-a-plugin.md) §4 — `design`'s default is nothing)

## 1. The question, and why it could not be left to the first plugin

0066 §3 says an action that makes something large returns **two things**: the
thing, and a locator. §1's table says the document reaches `implement`'s prompt.
Put together they are ambiguous in exactly one place — *what does `implement`
get?* — and the code decided nothing, because nothing has ever returned a
locator.

Two readings, both defensible:

| | what `implement` gets | what it costs |
|---|---|---|
| **both travel** | the document, and the locator beside it | two copies of one text, and nothing that notices when they differ |
| **only the locator** | a string it must resolve | a network call inside a step that needed none, and a locator the plugin cannot read is a pass with no design at all |

`#295`'s four remaining tickets are all downstream of this, so an assumption
made in the first plugin would have become four tickets' worth of shape without
anybody writing it down. That is the whole reason this was its own ticket
(`#297`).

## 2. The decision: both travel

`TheDesign` in `packages/actions/src/action.ts`:

```ts
export interface TheDesign {
  readonly document: string;
  readonly locator?: string;
}
```

It is on `WroteTheDesign.design` (the `design` step's ending),
`ActionContext.design` (what every plugin at `implement` is handed) and
`Brief.design` (what the built-in dispatch assembles). One type, three places,
and it is the same object the `design` plugin returned.

**The document travels because 0066 §2 depends on it.** The thesis this whole
line of work exists to test is *a smaller `implement` job can be done by a
cheaper model*, and the document is what makes the job smaller. A shape that
made `implement` fetch it before it could start would put a failure between the
thesis and the measurement.

**The locator travels beside it because §3 buys one.** A fact the pass drops one
step before the only step that could use it is a fact worth nothing.

## 3. The failure, which is the half that decides it

*A `confluence:` locator handed to a file-reading `implement`.*

**It is not a failure.** The plugin does not recognise the string, ignores it,
and works from `document` — which is there either way. The pass lands.

So there is **no pairing rule**: no table of which `design` plugin may sit with
which `implement` plugin, and nothing for the recipe to refuse when it resolves.
The two halves are independent by construction rather than by a list somebody
keeps current.

This is 0066 §4 doing the work. Because the locator is a string only its writer
reads, a plugin that does not recognise one is in the ordinary case and not an
error case. The moment anything above the plugin tried to *validate* a locator
it would have to know the kinds, and the fourth destination would be a change to
the core.

**The other reading is the one that needs the refusal.** Carry only the locator
and a plugin that cannot read it is a pass with no design at all, at run time,
after the money — which then needs the resolve-time pairing check this one does
not, and that check is the core learning the kinds. That is the trade, and it is
why the ambiguity resolves in one direction rather than being a taste.

## 4. What it gives up, stated rather than designed against

**Two copies of one document, and nothing notices when they differ.** The pass
holds the text and the destination holds a copy; a plugin that reformatted what
it kept, or a page edited between `design` and `implement`, makes them disagree.
The rule is that **the document wins** — it is what the pass made, and the
locator is where a plugin put it — and it costs nothing today because the only
reader is `renderPrompt`, which fetches nothing.

If a plugin at `implement` ever does resolve a locator and work from what comes
back, that plugin owns the disagreement. Nothing here will tell it.

## 5. Three facts and they stay three

| | what it means |
|---|---|
| `design` key absent on the ending | nothing at this step drafted — the nine other steps, and every recipe with no `design:` |
| `{ document: "" }` | the agent answered that this change needs none |
| `{ document, locator }` | and here is where it was kept |

The key carries the first distinction and the value carries the second, which is
the rule `ActionResult.document` already had (`#265`); this widens it rather than
changing it. `NO_DESIGN` is the shared empty — *drafted nothing* and *never ran*
are one brief to `implement`, because the ticket is what it works from either
way (0058 §3), and the distinction survives where it is read: the absent key, and
`evidence`, where a person sees it.

**A locator is read off the result its document came from**, and off no other
one. One action makes both (0066 §3), so pairing the last locator anybody said
with the last document anybody wrote would be `pass.ts` deciding which document
a location belongs to — the pipeline understanding locators, one step before §4
says it must not. An action that returns a locator and no document is silent.

## 6. What did not change

Nothing runs differently. No plugin returns a locator, `design`'s default is
still nothing (0065 §4), and a recipe that declares no `design:` walks the same
ten steps, runs the same nothing at the fourth, and hands `implement` the same
empty brief — asserted in `conductor/unit/pass.test.ts`'s *hands implement
NO_DESIGN where no design is declared*.

`renderPrompt` still takes a string and still renders the document alone. A
prompt carrying *your design is at `https://…`* would be either a URL the agent
cannot open or an instruction to fetch what it was already given.

And this is still in memory: `WroteTheDesign` is the visit's ending, not an
event. What reaches the log is `evidence`, which is the whole of 0066 §3's point
about what a replay pays for.

## What this does not decide

- **What the first destination plugin is.** `file:` or `confluence:`, its fields
  and its failures, are `#295`'s remaining tickets. This decides only what such
  a plugin returns.
- **Whether an `implement` plugin should ever read a locator.** It may; nothing
  stops it and nothing helps it. §4 says who then owns the disagreement.
- **Whether `agent:`'s evidence is clipped** (0066 §8). Independent, still true,
  still unfixed.

## Related

- [0066](0066-a-large-answer-is-a-locator-on-the-log.md) §3, §4, §9 — the
  decision this completes; §9 names *a wider contract at the step boundary* as
  one of the costs and says it has to be decided rather than assumed.
- [0065](0065-the-default-is-a-plugin.md) §4 — `design`'s default is nothing,
  which is why this could be built with no recipe changing.
- [0031](0031-a-run-that-never-started.md) §1 — a classification lives where it
  is known. §3 above is the reason a locator is not classified anywhere.
- [0058](0058-lingtai-is-a-development-pipeline.md) §3 — *or nothing, which is
  an answer*, which is the rule `NO_DESIGN` carries.
