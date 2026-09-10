# The board's bar, weighted

**Status** built · 2026-09-10 · `#134` · a picture at
`claude.ai/code/artifact/f57ced9e-f1a4-4405-8d55-01e76ee7c562`

Eleven objects, nine of them boxed, wrapping to a second line at 1440.

## Every one of them earned its place, and nobody looked at the row

`#81` split a sum nobody could act on into its parts. `#84` separated a repair's
spend from the work's. `#86` made an empty board say *whose* emptiness it is.
`0025 §2` put the repair default on screen because a default that spends money
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
<span className="chip sig">${cost.repair.toFixed(2)} repair</span>
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
| `$488.52` · `$81.83 repair` | **to a page** | neither changes what you do in the next minute, and a running total you cannot act on is a number you learn to stop seeing — after which it is not there when you do want it |
| `<project>: repairs ×N` | **to the recipe view** | 0025 §2 wants it visible and is right; **visible is not permanently on screen**. It is a setting that changes about once a quarter, it is already in `lingtai status`, and it is a chip per project on a rail meant to be read in a glance |

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

## What it looks like now

```
灵 Lingtai │ [all] lingtai nextloom-ai-admin        10 queued · 1 running · 45 landed  ●  [1 waiting on you]
```

One line at 1440, and one line with a third project: the filter grows a tab, and
a tab is not a chip. Nothing waiting and nothing wrong is quieter still — the
headline loses its box and its colour and stays the same words, the dot is green
and says nothing, and the row is the reading and the dot.

Where the five that left went:

| | |
|---|---|
| `$488.52` · `$81.83 repair` | `/spend`, off the reading. Split per repository, which is the first thing anybody asks after the total and which a chip could never have carried |
| `<project>: repairs ×N` | `/spend`, under the bill it explains. 0025 §2 asks that a repository see whether it repairs without reading Lingtai's source; a page one click from the board is seeing it |
| `current` + `daemon N behind` | one dot (`health.tsx`, folded by `lib/bearing.ts`). Green and silent when both are true; the sentence and the action when either is not, and whichever fact is not the headline stays in the title |

`paused` and `draining` are still chips and still amber-free, because both are
already absent when there is nothing to say — which is the property that makes a
chip affordable at all.

**The claim is about the bar, and only the bar.** A card still wears the accent
where a card has earned it — the `waiting` lane's own heading, a repair's
`pill sig` (`#84`), an open question. Cards are read one at a time and on
purpose; the bar is glanced at while you are doing something else, and it is
that difference, not the palette, that makes a second amber cost something here
and nothing there. `apps/board/test/bar.test.ts` asserts the scoped version:
exactly one selector paints the bar with `--signal`, and it is the headline's.
