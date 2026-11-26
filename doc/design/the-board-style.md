# The board's style

**Status** decided 2026-11-25 · being built (the style-unification tickets) ·
the colours are `apps/board/src/app/globals.css` `:root` and its dark block

Every page of the board draws its text, headings, cards, links, buttons and
titles one way. This is that way. A page that needs something not here argues
for it here first; it does not add a sixth button or a ninth font size in its
own corner of `globals.css`. The PR pages were built from their own mocks and
carried their own sizes, colours and radii for a release (#1319, #1320): that
is the failure this document exists to stop.

## Colour

Colours are the variables in `:root` and nothing else (#1444). A rule never
names a hex, `rgb()` or `hsl()` value; a new colour is a new variable with a
light and a dark value. Teal (`--accent`) is structure, amber (`--signal`) is
*a person is waited on*, and `--pass`, `--fail`, `--held` are verdicts.

Dark mode separates three layers, as light mode does: the page
(`--ground #0c1316`), a column or lane (`--surface-2 #0e181b`), and a card or
panel on it (`--surface #18262b`, border `--rule #2e434b`, a control's border
`--rule-2 #3a525b`).

## Type

Seven sizes for text, and one for display figures, each a variable in `:root`:

| variable | size | for |
|---|---|---|
| `--fs-2xs` | 10px | metadata in mono: ids, times, costs, hashes |
| `--fs-xs` | 11px | section headings, small buttons, tags |
| `--fs-sm` | 12px | card titles, buttons, secondary text |
| `--fs-md` | 13.5px | body text (the `body` default) |
| `--fs-lg` | 16px | a card's own large title |
| `--fs-xl` | 20px | an object page's title |
| `--fs-2xl` | 28px | a large figure inside a panel |
| `--fs-display` | 56px | a display figure only: `/landed`'s day, the report's hero numbers, an empty *Waiting on you* |

No `rem`, `em` or fractional size, and nothing under 10px. A size between
steps rounds to the nearest, and a tie goes up. Sans
(`--sans`, IBM Plex Sans) for words; mono (`--mono`, IBM Plex Mono) for things a
machine wrote: ids, hashes, commands, counts, times.

## Section headings

One rule for the heading over a lane, a block or a panel, on every page:
11px, weight 600, upper case, `letter-spacing: 0.08em`, `--muted`. Two
headings take a colour, and only for what the colour already means: the
heading of what waits on a person (*Waiting on you*) is `--signal`, and a
heading whose subject is a verdict takes that verdict's colour (*Triage ·
failed* is `--fail`). A warning such as *Watch out* is muted. A count beside a
heading is mono, normal weight.

## Cards and panels

One radius, `--radius: 3px`, for every card, panel, input and button. Pills
(`999px`) and dots (`50%`) are not boxes and keep theirs. A card or panel's
neutral border is `1px solid var(--rule)`, never a shadow; a border that says
a state (a card's state stripe, a blocked or broken box) keeps its state's
colour.

## Links

A link inside text — a sentence, a panel, a metadata line, *+ 8 more*,
*runs ↗* — is `--accent` with an underline always on (1px, offset 2px).
Navigation (the bar, the place line, view tabs, menus, ⌘K) and a link that is a
whole card or a whole row are not underlined; their shape says they are
clickable. A card's own issue number (`#1435` on a home card) is part of the
card and stays muted and plain: a second coloured link on every card would
compete with its title. A link somebody else wrote, inside a ticket body,
keeps its dotted ink underline so it does not read as the board's own. A link
that leaves the board ends with ` ↗`.

## Buttons

Two kinds, two sizes:

| | primary | secondary |
|---|---|---|
| ground | `--accent` | `--surface` |
| text | `--surface` | `--accent-ink` |
| border | `--accent` | `--rule-2`, `--accent` on hover |

Regular is 12px weight 600, padding 6px 12px; small is 11px, padding 4px 9px;
both `--radius`. A decision block — a card, a row, a panel — has at most one
primary button: the one thing it asks a person to do (*Approve*, *Accept*,
*Submit PR*). A list of waiting cards has one on each card. Teal is the action;
amber stays the recommendation's sentence the action answers.

## Page titles

The place line (`Lingtai / <project ▾> / <views>`, [the-bar.md](the-bar.md))
already says where a person is, so **a page that is a view of a project has no
title**: `/`, `/p/<project>/ticket`, `/p/<project>/backlog`, `/p/<project>/ticket/landed`, `/p/<project>/pr`, `/p/<project>/recipe`,
`/report`. A page's own facts (the recipe's hash and branch) are its first line,
10px mono `--muted`.

**A page about one object has a title**: `/p/<project>/pr/<n>`, `/p/<project>/ticket/<n>` and
its sub-pages, and each `/setup` step. A state tag first (11px mono 600,
`--radius`, coloured by state), then the title (20px sans 700), then one 10px
mono `--muted` line of facts.

**The task page is the one exception**: its state word is the reason most
people open the page (#80, #87, #89, #94), so it is not a small tag. It leads
the title line at 20px weight 700 in its state's colour, followed by the
title.

## The bar's icons

The right rail carries icons without words, each with its sentence as tooltip
and accessible name: the sandbox's shield (#1183), the project's mode, and
health's dot, in that order. The mode is a 16px glyph in `--muted` — a mode is
not a state and has no good or bad: *team* is a branch leaving a line, *solo*
is one line. With all projects chosen the bar shows no mode; each row of the
project menu carries its own, after its shield.

## Gutter

Content under the bar starts 16px from each edge, in line with the bar's own
padding (#1445).

## Checking a change

A UI ticket is checked on the production build at 1440 px, in light and dark
mode, against this page. Where a rule can be held by a test that reads
`globals.css` (no colour literal, no literal font size, no radius but the
variable), the ticket that makes it true adds the test.
