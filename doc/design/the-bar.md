# The board's bar, weighted

**Status** built · 2026-09-10 · `#134` · a picture at
`claude.ai/code/artifact/f57ced9e-f1a4-4405-8d55-01e76ee7c562`

Eleven objects, nine of them boxed, wrapping to a second line at 1440.

## Every one of them earned its place, and nobody looked at the row

`#81` split a sum nobody could act on into its parts. `#84` separated a repair's
spend from the work's. `#86` made an empty board say *whose* emptiness it is.
`0025 §2` put the spending default on screen because a default that spends money
invisibly is one nobody can audit. `#64` and `#98` each added a health chip.

Every argument is sound. **The row is the thing none of them was about** — and a
bar where everything is emphasised is a bar where nothing is.

This is the shape `actions.ts:29` has too: a set that is only countable from one
side, added to one element at a time from the other.

## And one chip breaks a rule stated 23 lines above it

```tsx
// apps/board/src/app/page.tsx:648
{/* Amber for the same reason the lane is amber: it is reserved
    for "a human is the thing being waited on". */}
<span className={`chip ${waiting > 0 ? "sig" : "idle"}`}>
```

```tsx
// apps/board/src/app/page.tsx:672
<span className="chip sig">${cost.repair.toFixed(2)} answering</span>
```

Amber, for money. A second amber dilutes the first, which is the entire reason
the palette carries the rule.

## What a bar is for

**It carries what changes what you do next.** Read in a glance, repeatedly,
while working on something else. Two questions, and no third:

- *Is anything waiting on me?*
- *Is the system doing what the code says?*

| | | |
|---|---|---|
| `1 waiting on you` | **stays, as the headline** | the only reason to look up, and the only amber left |
| `daemon N behind` + `current` | **merge into one health** | one dot, and a sentence only when it is red — two chips for two independent facts is two things to learn to read |
| `10 queued · 1 running · 45 landed` | **stays, unboxed** | a box says *this is a thing*; this is a reading. Kept as parts — `#81` stands |
| `$488.52` · `$81.83 answering` | **to a page** | neither changes what you do in the next minute, and a running total you cannot act on is a number you learn to stop seeing — after which it is not there when you do want it |
| `<project>: rounds ×N` | **to the recipe view** (`/recipe/<project>`, built by `#218`) | 0025 §2 wants it visible and is right; **visible is not permanently on screen**. It is a setting that changes about once a quarter, it is already in `lingtai status`, and it is a chip per project on a rail meant to be read in a glance |

Eleven to four: filters left, reading and health right, the headline last where
the eye lands. Nothing new in the palette — amber returns to meaning one thing,
and the health dot uses pass/fail, which are separate from the accent and always
have been.

## The rule to keep

**A chip is not free, and the row is the unit.** Anything added here has to be
argued against the four that are left, not against the empty space beside them —
which is the argument none of the six tickets above was asked to make.

It is in the code, at the end of `.bar` in `apps/board/src/app/page.tsx` — where
the next chip would be added, and so where the argument has to be made.

### Which half of the row does it govern? Both

The four are filter, reading, health, headline, and only three of them are on
`.rail`: the filter sits left of the second separator, and it is counted. So
*it is on the other side of the separator* is not an argument this rule
accepts, and `paused` and `draining` are not two of the four either — they are
chips, absent whenever there is nothing to say, which is the property that
makes a chip affordable at all (below).

`#216` is the first ticket asked to make this argument, and it makes it by
adding nothing to the count. The board offered a way to onboard a repository
only while it had none: with one project the slot was a caption and with two a
filter, and the only routes left were `lingtai add <owner>/<repo>` and typing
`/setup/repository` from memory. What closed that is a `+` at the end of the
project list — a `.tab` inside `.filter` (`apps/board/src/app/projects.tsx`).
The filter has been a list of projects since `#81` and grew a tab when a third
repository was registered; *a tab is not a chip* is already said below. The
fourth object gained the affordance a list of things has, and the row still
carries four.

**None of which loosens anything**, and what it did cost is named rather than
left to be found: a single-project board used to carry a bare caption and now
carries a caption and one small tab. A list gaining its own action is not the
same act as a fifth object arriving on a row that is glanced at while you work
on something else — and that one still has to be argued for here.
`apps/board/test/projects.test.tsx` holds both halves of it: *is mounted left
of the rail*, and *leaves the four what they were* — because the way this
ticket could have gone wrong was to make the `+` fit by redefining the set.

## What #141 and #142 changed under this

Two of the chips were renamed when
[0039](../decisions/0039-the-worktree-is-the-whole-of-a-pass.md) landed, and the
quotes above say the new names: `$N repair` became `$N answering` — the column
behind it is still `repair_costs` and holds every round a pass buys — and
`<project>: repairs ×1` became `<project>: rounds ×2`, with `passCeiling`'s
sentence as its title. Neither rename touched the argument.

## What it looks like now

```
灵 Lingtai │ [all] lingtai nextloom-ai-admin  +     10 queued · 1 running · 45 landed  ●  [1 waiting on you]
```

One line at 1440, and one line with a third project: the filter grows a tab, and
a tab is not a chip. Nothing waiting and nothing wrong is quieter still — the
headline loses its box and its colour and stays the same words, the dot is green
and says nothing, and the row is the reading and the dot.

Where the five that left went:

| | |
|---|---|
| `$488.52` · `$81.83 answering` | `/spend`, off the reading. Split per repository, which is the first thing anybody asks after the total and which a chip could never have carried |
| `<project>: rounds ×N` | `/spend`, under the bill it explains, in `passCeiling`'s sentence. The reading links there on every board — an empty one too, since before anything has run is exactly when 0025 §2 wants the default seen. **And `/recipe/<project>`, which is the view the row above named and which nothing built for a fortnight** (`#218`): the whole recipe as `lingtai status` reads it, every value beside the file it came from, reached from the filter |
| `current` + `daemon N behind` | one dot (`health.tsx`, folded by `lib/bearing.ts`). Green and silent when both are true; the sentence and the action when either is not, and whichever fact is not the headline stays in the title |

`paused` and `draining` are still chips and still amber-free, because both are
already absent when there is nothing to say — which is the property that makes a
chip affordable at all. `recipe` in the filter is the same property, and `#218`
is the second ticket asked to make `#216`'s argument: one control, naming the
project in view, absent on `all` where there is no single recipe to name.

**A destination that is not built is a fact deleted.** The row above was right
that `rounds ×N` does not belong on a rail glanced at every few seconds, and for
a fortnight the consequence was that 0025 §2's *visible* meant a terminal —
worse, since `0046` §3 had by then moved the recipe to `~/.lingtai/` where a
clone does not show it either. **Moving a fact off the bar is only finished when
somewhere else is showing it.**

**The claim is about the bar, and only the bar.** A card still wears the accent
where a card has earned it — the `waiting` lane's own heading, an answering
round's `pill sig` (`#84`), an open question. Cards are read one at a time and on
purpose; the bar is glanced at while you are doing something else, and it is
that difference, not the palette, that makes a second amber cost something here
and nothing there. `apps/board/test/bar.test.ts` asserts the scoped version:
of everything that can render inside `.bar`, exactly one selector paints with
`--signal`, and it is the headline's.
