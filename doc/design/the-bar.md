# The board's bar, weighted

**Status** built · 2026-09-10 · `#134` · revised 2026-11-06 · `#953` · a picture at
`claude.ai/code/artifact/f57ced9e-f1a4-4405-8d55-01e76ee7c562`

## The bar is a frame and a row; the reading is in a footer

The bar answers two questions, *is anything waiting on me?* and *is the system
doing what the code says?*, and carries only what a person acts on. It is a
**frame** that is the same on every page and a **row** that is the page's own.

- **The frame** is `Lingtai` at the left, which is the way home (it carries
  `?project=`), and `Report` at the right (`apps/board/src/app/bar.tsx`), marked
  current on `/report`. The frame does not grow either: a second destination
  beside `Report` has to be argued here the way a fourth object is.
- **The row** is three objects: **the filter, health, the headline.** The rule
  below, *a chip is not free and the row is the unit*, governs the row.

The row's objects:

- **The filter** is one control: the project in view, with a row per
  repository in its menu, each carrying its own `recipe` (#948), and *add a repository* last (#972).
  `recipe` is not an object of its own.
- **Health** is silent when well: a green dot and nothing else. When it is
  not, one sentence names the fault and the command that fixes it
  (*daemon 17 commits behind · `lingtai restart`*, written bare as every
  other health sentence writes its command). Today's spend joins it
  only when it passes 80 % of the day's ceiling (*today $120 + ~$45 of $200*,
  in the fail colour, never amber), because that is the one reading a person
  then acts on. Reported and estimated stay two figures, never one sum
  (`packages/conductor/src/day-ceiling.ts`).
- **The headline** is the count waiting on you, in amber, linking to the
  column, and nothing when the count is zero. Amber stays the headline's alone.
- **The counts are not on the bar**: each column carries its own, so *2 queued
  · 3 running · 65 landed* was the same numbers twice. *nothing waiting on you*
  goes for the same reason.

**The footer** holds the reading, which is looked at and not acted on
(`apps/board/src/app/footer.tsx`): today's spend against the ceiling as a meter
of two segments, reported and estimated, written as two figures
(*$26.15 + ~$22.03 of $200*, unknown said and never $0, the whole sentence on
hover); on `/`, how many landed, as plain text; the projections' currency in
faint type; and the home, last. **It carries no links.** `/landed` is reached
from the Landed column's count on the board, the report from the bar, a card
from its title, a repository's recipe from its row in the filter. Spend is a
part of `/report`, and the recipe's pass limits are on the recipe page.

**Why `Report` is on the bar.** The operator's choice of 2026-11-06: the report
is the one page a person goes to on purpose. Everything else is glanced at (the
bar, the footer) or reached from the thing it is about. A link to a page you
visit on purpose is not a reading, so it does not belong in the footer, and a
frame destination is not a fourth object in the row.

**Why the home is in the footer.** Two boards on two homes were told apart by
remembering which terminal was which, so the home is shown and never assumed
(#767). Once `Lingtai` is the link home on every bar, the brand is a control.
The home is a fact that never changes while the page is open, which is the
definition of a reading, so it goes where the reading is: the footer's last
item, whose prop is required so no page can drop it.

**⌘K** opens one search over projects, recipes, tickets and pages. It is a
key, not an object on the bar.

The mock agreed with the operator is
`https://claude.ai/artifact/4YVX98CsnwU8MSTcKZ3pTw` (`bar.html`).


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


## The rule to keep

**A chip is not free, and the row is the unit.** Anything added here has to be
argued against the three objects that are there, not against the empty space
beside them, which is the argument none of the six tickets above was asked to
make. The frame is held to the same rule.

It is in the code, at the end of `.bar` in `apps/board/src/app/page.tsx`, where
the next chip would be added, and so where the argument has to be made.
`apps/board/unit/projects.test.tsx` holds the code to the set *filter, health,
headline*.

### An affordance inside an object is not a new object

`paused` and `draining` are not objects either: they are chips, absent whenever
there is nothing to say, which is the property that makes a chip affordable at
all (below).

`#216` made the argument by adding nothing to the count: a way to act on a list
of things belongs to the list. The filter has been a list of projects since
`#81`, and the `recipe` link on each repository's row in its menu is the living
example. It is the same act, a list gaining its own action, and it is not the
same as a fourth object arriving on a row that is glanced at while you work on
something else. That one still has to be argued for here.

## What it looks like now

```
◆ Lingtai │ [lingtai ▾]   ●  [1 waiting on you]                 Report
Today ▮▮▯ $26.15 + ~$22.03 of $200 · 65 landed · projections current · home ~/.lingtai
```

One line at 1440. Nothing waiting and nothing wrong is quieter still: there is
no headline at all (the Waiting column's own empty line says so), and the dot is
green and says nothing.

Where the facts that left the bar went:

| | |
|---|---|
| `$488.52` · `$81.83 answering` | `/report`, off the bar: the window's spend by purpose, which a chip could never have carried. Today's figure stays in the footer |
| `<project>: rounds ×N` | `/recipe/<project>`, the view the row above named (`#218`): the whole recipe as `lingtai status` reads it, every value beside the file it came from, reached from the filter |
| `current` + `daemon N behind` | one dot (`health.tsx`, reduced by `lib/bearing.ts`). Green and silent when both are true; the sentence and the action when either is not, and whichever fact is not the headline stays in the title |

`paused` and `draining` are still chips and still amber-free, because both are
already absent when there is nothing to say. `recipe` in the filter is the same
property, and `#218` is the second ticket asked to make `#216`'s argument.

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
and nothing there. `apps/board/unit/bar.test.ts` asserts the scoped version:
of everything that can render inside `.bar`, exactly one selector paints with
`--signal`, and it is the headline's.
