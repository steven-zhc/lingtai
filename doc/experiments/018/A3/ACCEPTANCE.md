# Acceptance — the events page lists every event once under the pass's spine

Ticket: `TICKET.md` (no issue number in it; the files are named `acceptance-events-page*` for that reason — rename to `acceptance-<issue>*` once it has one).
Reference: `doc/design/events-page.html`, the **A+C** layout (its last two CSS blocks, `/* ===== A+C ===== */` from line 168, and `draw()`/`entry()` at lines 1198–1216). The mock's tokens have the same names as `apps/board/src/app/globals.css`'s, which `site.css` builds on, so every value below is a site token.

## Tests

| File | Project | What it holds |
|---|---|---|
| `apps/site/unit/acceptance-events-page.test.tsx` | unit | `EventsBody` and `EventsPage` rendered with `renderToStaticMarkup` — **no client JS**, which is the ticket's *JS off* edge made into the harness; the `"use client"` import graph; the `/docs/events/` block of `site.css` |
| `apps/site/unit/acceptance-events-page-filter.test.ts` | unit | the filter as a pure module |

Run: `npx vitest run apps/site/unit/acceptance-events-page.test.tsx apps/site/unit/acceptance-events-page-filter.test.ts`

### The seams these tests fix

The unit project has no DOM (no jsdom/happy-dom in the workspace), so a click cannot be simulated. The tests therefore name two seams the implementation must have; everything else is free:

1. **`EventsBody({ doc })`** stays the server export of `apps/site/src/app/docs/events/events-body.tsx`, and its static markup is the whole page body with no filter applied.
2. **`apps/site/src/lib/event-filter.ts`**, client-safe (no `node:`, no `@/lib/events` value import), exporting:
   - `stepFromSearch(search: string): string | null` — `?step=<step>|outside|none` → that value; anything else → `null`.
   - `filterGroups(events, step): { group; total; events }[]` — every group in first-appearance order, `events` filtered, `total` unfiltered. A group with `events.length === 0` is the one the page hides; `n of N` is `events.length of total`.
   - `stepAfterHash(events, step, hash): string | null` — `null` when `#Name` names an event `step` hides.

And three markup conventions, taken from the mock: spine nodes and step chips carry **`data-step="<step>|outside|none"`**; a zero-count spine node carries **`disabled`** or **`aria-disabled="true"`**; the right rail is the element with **`aria-label="Contents"`** (as `docs/contents.tsx` already uses).

### How each fails on this checkout — 31 of 31 red

| Test | Fails because |
|---|---|
| *filter file*, all 7 | `Cannot find module …/src/lib/event-filter` / `ENOENT …/event-filter.ts` — the module does not exist |
| Done when 1: each event exactly once with `id` = name | `id="TicketDiscovered": expected 0 to be 1` — today's entries have no id |
| Want: nothing behind a click | markup contains `<details` |
| Want "grouped by group" | `no <h2> names group "work item" with 15` — headings are steps |
| What to build "Entries" (and the per-entry Done when 5) | `no element has id="TicketDiscovered"` |
| footer line after the last entry | `an entry has no id` |
| Done when 2: spine order / counts | `expected [] to deeply equal [claim, admit, …]` — no `data-step` controls |
| Edge: zero-count node disabled | same — no spine nodes |
| step chip filters the same way | `no element has id="RunSpent"` |
| old drawing gone | markup contains `ev-drawing` |
| Done when 4: code / bold / link; null; unclosed; real-data link | `no element has id="MarkdownCase"` (etc.) — summary is plain text in a `<p>` inside `<details>` |
| right rail as group contents | `no element with aria-label="Contents"` on the events page |
| Done when 5: sidebar, bar, and the new page under them | `expected 0 to be 1` — the sidebar and bar pass, the entry id does not |
| Watch out: a `"use client"` file exists / its graph is server-free / no event named in source | `no "use client" file in …/docs/events` |
| site.css: sticky / `scroll-margin-top` / spine scrolls / `:target` rules gone | none of the three in the `/docs/events/` block; `.ev-section:target` still there |

## Style table

Rendered page at `/docs/events/`, light scheme, ≥1241px wide unless the row says otherwise. "Mock" = `doc/design/events-page.html`, A+C rules (which override the A-only and C-only rules above them for `.spine`, `.grp`, `.entry`).

| # | Element (how to find it) | Property | Expected |
|---|---|---|---|
| S1 | Spine — the container of the twelve `data-step` controls, above the first entry | `position` / `top` | `sticky` / `0` (sticks under the bar, whose own height the bar decides) |
| S2 | Spine | `background` | `var(--ground)` — opaque, so entries scrolling under it are hidden |
| S3 | Spine | `border-bottom` | `1px solid var(--rule)` |
| S4 | Spine | `z-index` | above entries (mock: `5`) |
| S5 | Spine step node circle (the count inside each of the ten) | `width`/`height`, `border-radius` | `24px`, `50%` |
| S6 | Spine step node circle | `border` | `2px solid var(--accent)`; colour `var(--accent-ink)`; font `600 11px var(--mono)` |
| S7 | Spine node with count 0 | `border-color` / `color` | `var(--rule-2)` / `var(--muted)` |
| S8 | Spine node, pressed (`aria-pressed="true"`) | `background` / `color` | `var(--accent)` / `var(--surface)` |
| S9 | Spine node, not pressed, while a filter is on | `opacity` | `.6` |
| S10 | Spine connector between adjacent step nodes | `height`, `background` | `2px`, `var(--rule-2)` |
| S11 | `outside` and `no step` nodes (set apart, right of `end`) | circle `border-style`; group `border-left` | `dashed`; `2px dashed var(--rule-2)` with `margin-left: 14px; padding-left: 14px` — **"dashed" is the ticket's word; the values are the mock's** |
| S12 | Spine step label (`claim`…`end`) | `font` | `500 11px var(--mono)` |
| S13 | Spine at ≤1080px | `overflow-x` | `auto` on the spine's own box; the page itself never scrolls sideways |
| S14 | State line ("Showing **n** of 66 events appended at …" / "show all") | `font-size`, `color` | `13px`, `var(--ink-2)`; its button `font: 500 12px var(--mono)`, `border: 1px solid var(--rule-2)`, `color: var(--accent-ink)` |
| S15 | Group heading `<h2>` (e.g. text "work item") | `font-size`, `border-bottom`, `padding-bottom` | `20px`, `2px solid var(--ink)`, `6px` |
| S16 | Group heading count (`15 events` / `n of N events`) | `font`, `color` | `400 12.5px var(--mono)`, `var(--muted)` |
| S17 | Group section | `margin-bottom` | `28px` |
| S18 | Entry (the element with `id` = an event name) | `padding`, `border-bottom` | `10px 0 11px`, `1px solid var(--rule)` |
| S19 | Entry | `scroll-margin-top` | at least the spine's height (the mock does it with `scroll-padding-top: 96px` on `html`; the ticket asks for `scroll-margin-top` on entries) |
| S20 | Entry name (line one) | `font` | `500 14.5px/1.3 var(--mono)` |
| S21 | Entry `:target` | `background` | `linear-gradient(90deg, var(--accent-soft), transparent 70%)` |
| S22 | *retired* badge | `font`, `text-transform`, `background`, `color` | `600 10px var(--mono)`, `uppercase`, `var(--signal-soft)`, `var(--signal)` |
| S23 | Step chip (e.g. `claim`) on an entry | `font`, `background`, `color`, `border-radius` | `500 11px/1 var(--mono)`, `var(--accent-soft)`, `var(--accent-ink)`, `3px` |
| S24 | `outside` chip | `background`, `border` | `transparent`, `1px dashed var(--rule-2)`; colour `var(--muted)` |
| S25 | Step chip matching the active filter | `background` / `color` | `var(--accent)` / `var(--surface)` |
| S26 | Summary (line two) | `font-size`, `line-height`, `max-width` | `14.5px`, `1.5`, `var(--measure)` (68ch) |
| S27 | *no description in the source* | `color`, `font-style` | `var(--muted)`, `italic` |
| S28 | Meta line (line three) | `font`, `color` | `11.5px/1.55 var(--mono)`, `var(--muted)`; `overflow-wrap: anywhere` |
| S29 | Subscribe snippet `<code>` in the meta line | `background`, `padding`, `border-radius` | `var(--surface-2)`, `1px 5px`, `3px` |
| S30 | Right rail heading "Groups" | `font`, `text-transform`, `color` | `600 11px/1.2 var(--mono)`, `uppercase`, `var(--muted)` |
| S31 | Right rail count | `font`, `color` | `12px var(--mono)`, `var(--muted)` |
| S32 | Right rail entry for a group with 0 matching | `color`, `opacity` | `var(--muted)`, `.55` |
| S33 | Footer line ("… `doc/events.json` … sha") | `border-top`, `font-size`, `color` | `1px solid var(--rule)`, `12.5px`, `var(--muted)` |
| S34 | Dark mode, every row above | — | the same tokens resolve to the site's existing dark values; no hex literal in the new CSS (*the site's existing dark tokens; nothing new*) |

## Visual checklist

Screenshot `/docs/events/` beside the mock (A+C), light and dark, at 1440px and 390px. Each is yes/no.

1. The spine is the first thing under the intro paragraph, above every group.
2. It shows ten numbered circles left to right in the order claim, admit, prepared, design, implement, build, review, proposed, merge, end, each with its count inside, joined by a line.
3. `outside` and `no step` sit to the right of `end`, separated by a dashed rule, with dashed circles.
4. Below the spine, groups follow one another, each with a heading carrying its name and count and a heavy rule under it; there are 12.
5. Every entry shows its name, its step chips at the right of the name line, the summary underneath, and a muted meta line — with nothing collapsed and no ▸ to click.
6. Retired events show a *RETIRED* badge next to the name.
7. Summaries with backticks show code; `**…**` shows bold; `[0022](…)` shows a link — no literal `**`, backtick or `](` is visible except where a summary's markdown is unclosed.
8. The right rail is titled *Groups* and lists the 12 groups with counts; the doc tree is on the left with *Events* current.
9. The footer line with the short sha is the last thing in the article.
10. Scrolled halfway, the spine is still visible at the top, and entries pass *under* it (it is opaque).
11. Click `review`: its circle fills; others fade; the state line says *Showing n of 66 … review* with *show all*; groups with no review event are gone; rail counts drop and zero groups grey out; the URL reads `?step=review` and the page did not jump to the top.
12. Click `review` again: everything is back and `?step` is gone from the URL. Same for *show all*.
13. Click the `merge` chip on an entry: the list filters to `merge`, same as the spine node.
14. Load `/docs/events/?step=none`: it opens filtered to the 3 events with no step. Load `?step=bogus`: all 66 show.
15. With `?step=review` active, follow a link to `#TicketDiscovered` (not at review): the filter drops and the page lands on that entry, its heading **below** the spine, highlighted.
16. Load `/docs/events/#RunSpent` cold: the entry is just below the spine, not hidden under it.
17. With JavaScript disabled: all 66 entries and 12 groups are there, the spine is drawn, and `#RunSpent` lands on its entry.
18. At 390px: the spine scrolls sideways inside its own box; the page has no horizontal scrollbar; nothing overflows its box.
19. In dark mode the page uses the same palette as the rest of the docs — no light patch, no unreadable chip.

## Map: every Want clause and Done-when line

| Ticket line | Proved by |
|---|---|
| **Want** — the page is `doc/design/events-page.html` | style table S1–S33; checklist 1–9 |
| **Want** — the pass's spine on top | `Done when 2: ten steps in pass order … before every entry`; checklist 1–3 |
| **Want** — sticky | `site.css … position: sticky`; S1–S2; checklist 10 |
| **Want** — filtering by step | filter file (all `Done when 3` cases); `a step chip … same filter`; checklist 11–14 |
| **Want** — every event exactly once | `Done when 1 …exactly once`; checklist 17 |
| **Want** — grouped by group | `Want "grouped by group"`; filter `What to build "Groups"`; checklist 4 |
| **Want** — each with its own anchor | `Done when 1` (id = name); `Edge "sticky spine and anchors"` (CSS); checklist 15–17 |
| **Want** — everything visible without a click | `Want: nothing … behind a click`; `What to build "Entries"`; checklist 5 |
| **Watch out** — every event in the HTML with JS off | the whole page file renders with no client JS; checklist 17 |
| **Watch out** — client component takes events as props, no server-only import | `there is a "use client" component`; `no "use client" graph … imports node:*, fs, or the module that reads events.json`; filter `client-safe` |
| What to build — spine counts; zero node disabled | `Done when 2: … count`; `Edge "a node with 0 is drawn disabled"` |
| What to build — `?step=` in URL, unknown ignored | filter: `?step=review`, `?step=none`, `?step=outside`, `an unknown value is ignored` |
| What to build — `history.replaceState`; loaded with it opens filtered | checklist 11, 14 (no test: needs a DOM, see below) |
| What to build — a hidden `#EventName` drops the filter | filter `a #EventName that the current filter hides drops the filter`; checklist 15 |
| What to build — entries' three lines | `What to build "Entries"` |
| What to build — groups `n of N`, empty group hidden | filter `?step=review … hides groups with none` and `"Groups": … total`; checklist 11 |
| What to build — right rail as group contents | `Want "the right rail as the group contents"`; S30–S32; checklist 8 |
| What to build — footer line with the sha stays | `What to build "footer line"`; checklist 9 |
| Edge — JS off | page file as a whole; checklist 17 |
| Edge — sticky spine and anchors | `scroll-margin-top` CSS test; S19; checklist 15–16 |
| Edge — ≤1080px | `Edge "≤1080px": the spine … scrolls`; S13; checklist 18 |
| Edge — dark mode | S34; checklist 19 |
| Edge — unclosed markdown | `Edge "unclosed markdown"` |
| Edge — `events.json` missing/invalid | not checked — unchanged behaviour (`readEvents` unchanged), see below |
| **Done when 1** — 66 events once, id = name | `Done when 1: the page contains each … exactly once` |
| **Done when 2** — ten steps in order + outside + no step, with counts | `Done when 2: ten steps in pass order …`; `Done when 2: each spine node carries the count` |
| **Done when 3** — filter unit test | filter file, first four cases |
| **Done when 4** — `<code>`, `<strong>`, `<a>` at sha; null | `` `code`, **bold** and a relative link … ``; `null renders …`; `on the real data: a relative link …` |
| **Done when 5** — links + subscribe on the page | `Done when 5 (existing case, now per entry)` |
| **Done when 5** — no event named in its own source | `Done when 5 (existing case, widened)` |
| **Done when 5** — sidebar Events current; bar links Events | `Done when 5 (existing cases): the sidebar … and the bar …` |
| **Done when 6** — `pnpm typecheck` and `HOME=/nonexistent pnpm test` green | not a test here — run them; see below |

## Lines with no automated check, and why

- **`history.replaceState`, a page loaded with `?step=` opening filtered, click-again-clears, *show all*** — these are the client component's effects on `location` and the DOM. The unit project has no DOM environment and adding one is a dependency change outside this acceptance. The decision logic they rest on is tested (`stepFromSearch`, `filterGroups`, `stepAfterHash`); the wiring is checklist 11–15.
- **Sticky actually sticking, `#Name` landing below the spine, the spine scrolling at ≤1080px** — layout, only visible in a browser. The CSS that causes them is tested to exist; the effect is checklist 10, 15, 16, 18.
- **Dark mode** — no colour assertions run in tests; S34 and checklist 19.
- **`events.json` missing or invalid throws at build** — unchanged by this ticket (`readEvents` is kept as is); nothing new to prove.
- **The Next build catching a server-only import in the client graph (#230)** — `apps/release/integration/build.test.ts` is the only thing that sees it and runs after the merge. The unit test `no "use client" graph … imports node:*` is the before-merge stand-in: it walks value imports from every `"use client"` file under `docs/events/` and refuses `node:*`, `fs`, `path` and `src/lib/events.ts`.
- **Done when 6** (`pnpm typecheck`, `HOME=/nonexistent pnpm test`) — whole-repo commands, not a property of this page. Note that `apps/site/unit/events.test.tsx` asserts the old `#at-<step>` sections and **will go red by design**; the ticket's Edges say its cases change with the structure. And `acceptance-events-page-filter.test.ts` imports `../src/lib/event-filter`, so until that module exists `tsc` reports it as missing.
