# Acceptance — the home page's sandbox section is a dark band

Ticket: `TICKET.md` (*feat(site): the home page's sandbox section is a dark band that says every run is sandboxed, beside a drawing of the Sandbox tab*). TICKET.md gives no issue number, so the test file is named `acceptance-sandbox-band.test.tsx`. Rename it to `acceptance-<issue>.test.tsx` once the number is known.

Tests: `apps/site/unit/acceptance-sandbox-band.test.tsx`, which has 25 tests. It renders `HomePage` with `renderToStaticMarkup` and reads `home.css`, `site.css` and the board's `globals.css` with a small CSS reader that resolves `var()` chains to hex values. Run it with:

    npx vitest run apps/site/unit/acceptance-sandbox-band.test.tsx

On this checkout all 25 fail (see *How they fail today* at the end).

**There is no mock CSS to take values from.** The operator holds the mock as a screenshot, and the ticket links no file. So every value below comes from the ticket's *agreed design* and from the palette it names (`apps/board/src/app/globals.css:50-66`). A row says so where the ticket gives only an adjective.

---

## Style table

Find each element on the page rendered at `/`, inside `section.sandbox-pitch`. Values are what `getComputedStyle` returns, given as the resolved value and the board token it comes from.

| # | Element (how to find it) | Property | Expected |
|---|---|---|---|
| S1 | The band: `section.sandbox-pitch`, `aria-labelledby="sandbox-title"` | `background-color` | `#0c1316` (board dark `--ground`) or `#131e22` (dark `--surface`). It is dark in **both** colour schemes and comes from a site token in `home.css`. |
| S2 | The band | `width` | Equal to the viewport's width (`100vw` less any scrollbar). It is full width and breaks out of `.wrap`, whose `max-width` is `80rem`. |
| S3 | The band, under `prefers-color-scheme: dark` | `border-top` / `border-bottom`, or `background-color` | Distinct from the page's `#0c1316`: either a 1px border in `#2e434b` (`--rule-2`) or `#22333a` (`--rule`), or a ground of `#131e22`/`#0f1a1e`. *The ticket says "distinct"; the colour is the dark palette's.* |
| S4 | Kicker text `Security · from v0.14.0` | `color` | `#b4c4c8` (dark `--ink-2`) or `#87999f`. The contrast must be ≥ 4.5:1 on S1. *The ticket gives no colour for the kicker; this is the palette's muted ink.* |
| S5 | The shield `svg` above the heading (`aria-hidden="true"`) | `color` / `stroke` | `#54c6cc` (dark `--accent`) |
| S6 | `h2#sandbox-title`, the first line *Every run is sandboxed.* | `color` | `#dde6e8` (dark `--ink`) |
| S7 | `h2#sandbox-title`, the second line *Your keys stay yours.* | `color`; `display` | `#54c6cc` (dark `--accent`) or `#7fdade` (dark `--accent-ink`). It sits on its own line (`display: block`, or after a `<br>`). |
| S8 | The sentence *Claude Code, Codex and your checks run…* | `color` | `#b4c4c8` (dark `--ink-2`), ≥ 4.5:1 on S1 |
| S9 | The labels list: `ul` holding *No keys*, *Allowlisted network*, *Refusals on the ticket* | `display`; `flex-wrap` | `flex` (or `grid` with three columns) at 1360px, so all three sit on one row. Under ~860px they may wrap. |
| S10 | Each label `li` | `border-color` or `background-color`; `color` | Border `#22333a`/`#2e434b` (dark `--rule`/`--rule-2`), or a ground of `#131e22`. Text `#dde6e8`/`#b4c4c8`. *The ticket says only "labels"; these are palette values.* |
| S11 | The line *On for new projects · one `sandbox` block in the recipe.* | `font-size`; `color` | Smaller than S8 (the ticket says "small"). Colour ≥ 4.5:1 on S1. |
| S12 | The link *What an agent can touch →* (`href="/docs/safety/"`) | `color` | `#7fdade` (dark `--accent-ink`) or `#54c6cc` |
| S13 | The card: `figure` in the band whose accessible name says *illustration … Sandbox tab* | `background-color`; `border` | `#131e22` (dark `--surface`); a 1px border in `#22333a` (dark `--rule`) |
| S14 | Card section headings *Blocked*, *Allowed*, *Limited* | `color` | `#dde6e8` (dark `--ink`) |
| S15 | Card sub-heads *Reachable*, *Cannot be read* | `color` | `#b4c4c8` or `#87999f`, ≥ 4.5:1 on S13 |
| S16 | Card entries: hosts, paths and counts | `font-family` | `var(--mono)` (IBM Plex Mono) |
| S17 | The ✗ glyph beside a Blocked host | `color` | `#e2776e` (dark `--fail`) |
| S18 | The ✓ glyph beside a Reachable host, if one is drawn | `color` | `#61be86` (dark `--pass`) |
| S19 | `span.tag.ill` *ILLUSTRATION* on the card | all | The same rule as the receipt's tag (`page.tsx:81`). It adds no new style. |
| S20 | The line under the card, *Telemetry hosts such as `sentry.io` are refused but not listed.* | `font-size`; `color` | Small (the ticket's word), ≥ 4.5:1 on S1 |
| S21 | The band's columns at ≥ 860px | `display`; `grid-template-columns` | Two columns: text on the left, the card on the right |
| S22 | The band's columns under ~860px | `grid-template-columns` / `flex-direction` | One column, text first and the card second |
| S23 | Any element in the band | `color`, `background-color`, `border-color` | Never `#fd5d3f`/`#ff7256` (`--way-in`, coral). No hex outside the board's palette. |

S1, S2 (in CSS), S3, S7, S21–S22 (in CSS), S23, and the 4.5:1 floor for every text colour the band's CSS sets are also asserted in code. The rest are for a person or a vision model to check against a screenshot.

## Visual checklist

Take screenshots at **1360px** and **390px** wide, in **light** and **dark** schemes, and put each beside the mock. Each item is yes/no.

1. Between the receipt (*The agent got it wrong. Twice.*) and *Why not just give the agent the issue?*, is there exactly one dark band that runs edge to edge across the window?
2. Is the band visibly distinct from the sections above and below it, in the light scheme **and** in the dark scheme?
3. At 1360px, does the whole band (heading, labels and card) fit in one screen without scrolling?
4. At 1360px, is the text on the left and the Sandbox-tab card on the right?
5. On the left, top to bottom, do you see: the kicker *Security · from v0.14.0*, a shield icon, the two-line heading, one sentence, three labels in one row, the small *On for new projects* line, and the *What an agent can touch →* link?
6. Is *Your keys stay yours.* on its own line and in the teal accent, while *Every run is sandboxed.* is in the light ink?
7. Is there no coral anywhere in the band?
8. Does the card read as the board's Sandbox tab, with a ticket title such as `#42 · add reading time to chapters`, an `Attempt 1` switcher, and the sections *Blocked*, *Allowed → Reachable* and *Limited → Cannot be read*?
9. Does *Blocked* list only hosts with ports and counts (for example `pastebin.com:443 1×`), with no file path?
10. Is there no role label (*writer*, *build*, *reviewer*, …) anywhere on the card?
11. Does the card carry the same *ILLUSTRATION* tag as the receipt?
12. Is the line *Telemetry hosts such as `sentry.io` are refused but not listed.* directly under the card?
13. At 390px, do the columns stack with the text first and the card second, with nothing scrolling sideways and no text clipped or overflowing its box?
14. At 390px, are the three labels still readable, whether on one row or wrapped onto two?
15. Is the old 400px diagram gone from the home page, and are the four light cards gone?
16. Does `/docs/safety/` still show the sandbox diagram?
17. Does the footer line under *Three steps to your first receipt.* read *runs on one machine · not yet 1.0 —* with no *Not a sandbox*?
18. Is every muted text in the band (kicker, small lines, sub-heads) still comfortably readable on the dark ground in both schemes?

## Mapping

### Want

| Clause | Proved by |
|---|---|
| *One full-width … band* | Test `Want/band: the band is full width, breaking out of .wrap`; S2; checklist 1 |
| *… dark band* | Tests `Want/band: the band's ground is dark …` and `Agreed design/band: the board's dark tokens are named as site tokens …`; S1, S23; checklist 1, 7 |
| *headed **Every run is sandboxed. / Your keys stay yours.*** | Tests `Want/heading: h2#sandbox-title says …`, `Want/heading: … is in the accent colour`, `Want/heading: the heading sits between the receipt and …`; S6, S7; checklist 6 |
| *three short labels on the left* | Tests `Want: three short labels …` and `Done when 1 / agreed design: the left column runs …`; S9, S10; checklist 4, 5 |
| *a small drawing of the board's real Sandbox tab on the right* | Tests in `Want: a small drawing of the board's real Sandbox tab` (headings, hosts, paths, Blocked, roles, ILLUSTRATION tag, accessible name); S13–S19, S21; checklist 4, 8–11 |
| *readable in one screen* | Checklist 3 (and 18 for legibility). Not provable in code; see *What has no check in code*. |
| *The page no longer contradicts itself* | Tests `Done when 4: the home-edges line no longer says "Not a sandbox", and nothing on the page does` and `Watch out: … "On for new projects" sits directly under the labels`; checklist 17 |

### Done when

| Line | Proved by |
|---|---|
| 1. One dark full-width band; heading, sentence, three labels, *On for new projects*, safety link on the left; card with telemetry line on the right | Tests `Done when 1 / agreed design: the left column runs …`, `Done when 1: under the card, one small line says telemetry …`, `Want/band: …` (×2); S1, S2, S21; checklist 1, 4, 5, 12 |
| 2. The card's headings are the panel's own; no file refusal; no per-role labels | Tests `Done when 2 / Watch out: the card's headings are the panel's own …`, `… Blocked shows refused connections with counts and no file refusal`, `… no per-role host labels …`; checklist 8–10 |
| 3. The four cards and the diagram are gone from the home page; `/docs/safety` still shows the diagram | Tests `Done when 3: the four cards and the diagram are gone …` and `Done when 3: /docs/safety still shows the diagram …`; checklist 15, 16 |
| 4. `home-edges` no longer says *Not a sandbox* | Test `Done when 4: …`; checklist 17 |
| 5. `page.test.tsx` updated as in Edges, and passes | Test `Done when 5: page.test.tsx is moved to the new heading …` (that it is updated). That it **passes** is `npx vitest run apps/site/unit/page.test.tsx`, run by the build gate's `pnpm test`. |
| 6. A person checks 1360px and 390px, light and dark, against the mock | The whole visual checklist, run four times (two widths × two schemes) |
| 7. `pnpm typecheck` and `HOME=/nonexistent pnpm test` green | The commands themselves. The build gate runs `pnpm test`. |

### Edges, Watch out and agreed-design lines also covered

| Line | Proved by |
|---|---|
| Watch out: Blocked, Allowed → Reachable, Limited → Cannot be read | Test `Done when 2 / Watch out: the card's headings …` |
| Watch out: refused connections only; *reachable by policy*, not hosts reached | Tests `… no file refusal` and `… nothing claims a run actually reached a host` |
| Watch out: the heading must not overclaim | Test `Watch out: the heading does not overclaim — "On for new projects" sits directly under the labels` |
| Design: kicker, aria-hidden shield, sentence, link to `/docs/safety/` | Tests `Done when 1 / agreed design …` and `Agreed design: the shield above the heading is aria-hidden` |
| Design: Reachable hosts and Cannot-be-read paths | Test `Agreed design: Reachable lists the three allowlisted hosts; Cannot be read lists the five paths` |
| Design: ILLUSTRATION tag | Test `Agreed design: the card carries the receipt's ILLUSTRATION tag`; S19 |
| Design: board dark palette only, named as site tokens, no new hue, no coral | Test `Agreed design/band: …`; S23 |
| Edges/dark scheme: the band reads as a band | Test `Edges/dark scheme: …`; S3; checklist 2 |
| Edges/narrow: stack under ~860px, text first, nothing scrolls sideways | Test `Edges/narrow widths: …` (the CSS stacks); source order is held by the `Done when 1` order test (text before `<figure>`); S22; checklist 13, 14 |
| Edges/accessibility: the figure's accessible name says illustration of the Sandbox tab | Test `Edges/accessibility: the card is a figure whose accessible name …` |
| Edges/accessibility: ✗/✓ aria-hidden with text beside | Test `Edges/accessibility: every ✗ and ✓ in the band is aria-hidden, with text beside it` |
| Edges/accessibility: muted text ≥ 4.5:1 on the dark ground | Test `Edges/accessibility: every text colour the band sets clears 4.5:1 …`; S4, S8, S11, S15, S20; checklist 18 |
| Edges/tests: SVG `aria-label` equals `doc/safety.md`'s alt | Test `Done when 3: /docs/safety still shows the diagram, with the SVG's own aria-label as its alt` |

## What has no check in code, and why

- **"Readable in one screen."** Whether the band fits in a viewport depends on fonts, line lengths and rendered height, and a unit test with `renderToStaticMarkup` has no layout. A browser test would be integration, and the Next build is out of reach of a ticket (CLAUDE.md). This is checklist 3.
- **"Three labels on one row at desktop width" and "nothing scrolls sideways."** These are also layout. The CSS that stacks below ~860px is asserted; the row at 1360px and the absence of horizontal scroll are checklist 13 and S9.
- **Done when 6** is by definition a person's check.
- **Done when 7, and the *passes* half of 5,** are the repository's own commands, not acceptance tests. A test cannot usefully run `pnpm test` from inside `pnpm test`.
- **Contrast of colours set outside `home.css`'s sandbox rules** (for example the shared `.kicker` or `.tag.ill` rules, if the band inherits them unchanged) is not computed. The test only sees `color` declarations on selectors that mention `sandbox`. S4, S19 and checklist 18 cover the rest.
- **"Pixel-matching the mock"** is out of scope by the ticket's own words.

## How they fail today

Command: `npx vitest run apps/site/unit/acceptance-sandbox-band.test.tsx`. Result: **25 failed / 25**.

| Test | Failure on this checkout |
|---|---|
| Want/heading: h2#sandbox-title says … | `expected 'The agent runs inside a sandbox.' to be 'Every run is sandboxed. Your keys stay yours.'` |
| Want/heading: … between the receipt and *Why not …* | `expected -1 to be greater than 5338` (the heading is absent) |
| Done when 1 / agreed design: the left column runs … | `expected 'Sandbox · from v0.14.0 The agent runs…' to contain 'Security · from v0.14.0'` |
| Agreed design: the shield … is aria-hidden | No `<svg aria-hidden>` before the heading |
| Want: three short labels … | `the labels are a list: expected undefined to be defined` |
| Watch out: … *On for new projects* directly under the labels | `expected false to be true` (no labels list) |
| The 8 card tests (accessible name, ILLUSTRATION, headings, hosts and paths, Blocked, roles, glyphs) | `the card is a <figure> inside the band: expected null not to be null` |
| Done when 1: telemetry line under the card | No telemetry sentence after a `</figure>` |
| Done when 3: cards and diagram gone | The page still contains `sandbox-facts` |
| Done when 3: /docs/safety still shows the diagram … | The home page still carries the diagram's alt text |
| Done when 4: home-edges | `expected 'Not a sandbox · runs on one machine ·…' not to match /not a sandbox/i` |
| Done when 5: page.test.tsx moved | `page.test.tsx` does not contain `Every run is sandboxed.` |
| Agreed design/band: dark tokens as site tokens … | `home.css names the board's dark ground #0c1316 as a token: expected false to be true` |
| Want/band: the band's ground is dark | `.sandbox-pitch sets a background: expected 0 to be greater than 0` |
| Want/band: full width | `the band is outside .wrap, or its CSS breaks out of it: expected false to be true` |
| Want/heading: accent colour | `the second line is its own element: expected null not to be null` |
| Edges/accessibility: 4.5:1 | `.sandbox-head .sub { color: var(--ink-2) } → #3a4a50 on #0c1316: expected 2.03 to be ≥ 4.5` |
| Edges/dark scheme: distinct | `.sandbox-pitch sets a ground: expected 0 to be greater than 0` |
| Edges/narrow widths | `a sandbox rule under an @media (max-width: 760–960px): expected 0 to be greater than 0` |
