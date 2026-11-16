# Acceptance: the task page's Sandbox tab leads with what was blocked and lists what the runs could reach once

Ticket: `TICKET.md` (taken as **#1196**: the body says #1197 is blocked by it, and `TICKET.md` carries no number.
If the number is different, rename the two `acceptance-1196.*` files; nothing inside them depends on it).

Written before the change. Every test below **fails on this checkout** (57 of 57, see the end).

## Files

| File | Project | What it holds |
|---|---|---|
| `apps/board/unit/acceptance-1196.test.tsx` | unit | Render tests of `SandboxTab` (summary, Blocked, Runs, reach, legend, notes, order) and the pure short-name tests |
| `packages/sandbox/unit/acceptance-1196.test.ts` | unit | The vendor of every host in `BUILT_IN_DOMAINS` |

Run: `npx vitest run apps/board/unit/acceptance-1196.test.tsx packages/sandbox/unit/acceptance-1196.test.ts`

## The interface these tests assume

The ticket names the three pure functions and the constant but not what they are called. The tests settle that
with as few names as possible. Most of the behaviour is checked through `SandboxTab` as it is called today, so
the implementer is free to choose the rest.

1. **`SandboxTab({ detail })`** with a `SandboxTabDetail` of today's shape (`taskId`, `project`, `attempts`,
   `selected`, `view = sandboxViewOf(state, project, superseded)`). Nothing new is passed in. The attempt number
   in the summary is `detail.selected`. `~` and `<lingtai home>` are the board process's own `homedir()` and
   `stateDir()`, which the ticket's *Short names* paragraph calls "the board's". `<mirror>` and `<cache>` are
   built from `detail.project`.
2. **Each part carries an `aria-label`**, as `Allowed`, `Limited`, `Blocked` and `Runs` do today: `Summary`,
   `Blocked`, `Runs`, `What the runs could reach` (which contains *Where the policies differ*), `Legend`,
   `How Claude Code signs in here`, `Not covered`. The switcher keeps `aria-label="Attempt"`.
3. **Tables are `<tr>` rows** in Blocked and Runs. The Runs header row includes the word `Kind`.
4. **Every path chip** is an element whose `title` holds the full path (both spellings for a `/private` twin) and
   whose text is the short name.
5. **`shortNameOf(path, { home, lingtaiHome, project, runId }) → string`**, exported from
   `apps/board/src/lib/sandbox-view.ts`. `runId` is the worktree's last segment. An implementation that matches
   any `<lingtai home>/worktrees/<project>/<one segment>` and ignores `runId` passes as well.
6. **`BUILT_IN_VENDORS`**, exported from `packages/sandbox/src/policy.ts` beside `BUILT_IN_DOMAINS`, mapping host →
   `'Anthropic' | 'OpenAI' | 'npm' | 'GitHub'`. It may be a plain object or a `Map`.
   *Watch:* `apps/board/package.json` does not list `@lingtai/sandbox` today, so the board needs the dependency
   added before it can import the constant.

## Style table

The values come from the mock's CSS (`doc/milestone/0.15.0/sandbox-ui/index.html:8-115`, design A). Where the
ticket names a token, the token wins. Where the mock uses a hex that the board already has as a token, the token
is given. **Note:** the mock's `--rule-2` (`#e9eeee`) is the board's `--surface-2`. The board's own `--rule-2` is
`#c3cfd1`, a darker colour, so a row that copies the mock's `var(--rule-2)` literally gets the wrong colour.

| # | Element: how to find it | Property | Expected |
|---|---|---|---|
| S1 | Summary: `[aria-label="Summary"]` | `border` | `1px solid var(--rule)` |
| S2 | Summary | `border-radius` · `padding` | `10px` · `16px 20px` |
| S3 | Summary | `display` · `grid-template-columns` · `align-items` | `grid` · `auto 1fr auto` · `center` |
| S4 | Shield: the first child of the summary (an svg in a box) | `width` × `height` · `border-radius` | `38px` × `38px` · `10px` |
| S5 | Shield, every run sandboxed | `background` · svg `stroke` | `var(--pass-soft)` · `var(--pass)` (the ticket says "shield in `--pass`") |
| S6 | Shield, a run degraded | svg `stroke` (background the matching soft tint) | `var(--signal)` · `var(--signal-soft)` |
| S7 | Shield, a run stopped | svg `stroke` · background | `var(--fail)` · `var(--fail-soft)` |
| S8 | The summary sentence (*Every run of attempt N…*) | `font-size` · `font-weight` | `15.5px` · `600` |
| S9 | The summary's mono line (*4 runs · srt…*) | `font-family` · `color` · `font-size` | `var(--mono)` (the ticket says "one mono line"; the mock's `.sub` is sans) · `var(--muted)` · `13px` |
| S10 | The figures (`4/4`, `4`): the bold number of each stat | `font-size` · `font-weight` · `text-align` | `20px` · `600` · `right` |
| S11 | The figure caption (*runs sandboxed*, *connections refused*) | `font-size` · `color` | `11.5px` · `var(--muted)` |
| S12 | *connections refused* figure, when above zero | `color` | `var(--signal)` |
| S13 | *connections refused* figure, when zero | `color` | `var(--ink)` (not `--signal`) |
| S14 | Part headings (`Blocked`, `Runs`, `What the runs could reach`) | `font-size` · `font-weight` · `text-transform` · `letter-spacing` · `color` | `12px` · `600` · `uppercase` · `.06em` · `var(--muted)` |
| S15 | Gap between parts | `margin-top` of each part after the summary | `22px` |
| S16 | Blocked box: the element wrapping the Blocked table | `background` | `var(--signal-soft)` (the ticket's word; the mock draws `#fffaf2`) |
| S17 | Blocked box | `border-radius` · `padding` | `10px` · `14px 16px 6px` |
| S18 | Blocked host cell (`mcp.postman.com`) | `font` | `500 13px var(--mono)` |
| S19 | Blocked *First* cell (`17:40:45 UTC`) | the `title` attribute | the full ISO time, `2026-11-16T17:40:45.681Z` (unit-tested) |
| S20 | *Allow on this project* | `border` · `color` · `border-radius` · `padding` · `font` · `background` | `1px solid var(--accent)` · `var(--accent)` · `7px` · `4px 11px` · `500 12.5px var(--sans)` · `var(--surface)` (a button-styled link, not an underlined one) |
| S21 | *Allow on this project* cell | `text-align` | `right` |
| S22 | The note under Blocked (*Telemetry hosts are not counted…*) | `font-size` · `color` · `margin-top` | `12.5px` · `var(--muted)` · `8px` |
| S23 | Table headers (`Host`, `Refused`, `By`, `First`; `Step`, `Kind`, …) | `font` · `color` · `border-bottom` | `600 11.5px var(--sans)` · `var(--muted)` · `1px solid var(--rule)` |
| S24 | Table cells | `padding` · `border-bottom` | `9px 10px` · `1px solid var(--surface-2)` (the mock's `--rule-2`); none on the last row |
| S25 | Runs step cell (`implement · write the change`) | `font` | `12.5px var(--mono)` |
| S26 | Kind tag, agent (`agent · claude-code`) | `background` · `border-radius` · `padding` · `font` | `var(--held-soft)` (the ticket's token; the mock draws `#ece8f7`) · `6px` · `1px 8px` · `500 11.5px var(--mono)` |
| S27 | Kind tag, agent | `color` | `var(--held)` (the mock's `#4b3f8a` is the closest token the board has) |
| S28 | Kind tag, command (`command`) | `color` · `border` · `background` | `var(--muted)` · `1px solid var(--rule)` · none ("muted outlined tag") |
| S29 | Policy letter glyph (`A`, `B`, `C`) | `width` × `height` · `border` · `border-radius` · `font` · `display` | `20px` × `20px` · `1px solid var(--rule)` · `5px` · `600 11px var(--mono)` · `inline-grid`, centred |
| S30 | Runs *Refused* column | `text-align` | `right` |
| S31 | Boundary mark pill (`sandboxed`) | `background` · `color` · `border-radius` · `font` | `var(--pass-soft)` · `var(--pass)` · `9px` · `500 11.5px var(--sans)` |
| S32 | Reach grid: the parent of the four boxes | `display` · `grid-template-columns` · `gap` | `grid` · `repeat(4, minmax(0, 1fr))` · `14px` |
| S33 | Each reach box (`Reachable`, `Writable`, `Cannot be read`, `Cannot be written`) | `border` · `border-radius` · `padding` · `background` | `1px solid var(--rule)` · `10px` · `13px 14px 8px` · `var(--surface)` |
| S34 | Box title | `font-size` · `font-weight` · `display` · `justify-content` | `13px` · `600` · `flex` · `space-between` (the count sits at the right) |
| S35 | Box count (`13 hosts`, `5`) | `font-size` · `font-weight` · `color` | `11.5px` · `400` · `var(--muted)` |
| S36 | Vendor group label (`Anthropic`, `This recipe`) | `font-size` · `color` · `margin` | `11.5px` · `var(--muted)` · `2px 0 4px` |
| S37 | Chip (`api.anthropic.com`, `~/.ssh`) | `font` · `background` · `border` · `border-radius` · `padding` · `color` · `white-space` | `12px var(--mono)` · `var(--ground)` · `1px solid var(--surface-2)` · `6px` · `1px 7px` · `var(--ink-2)` · `nowrap` |
| S38 | Short-name chip (`<worktree>`, `<mirror>/hooks`) | `background` · `border-style` | `var(--surface)` · `dashed` |
| S39 | *none added* under *This recipe* | `font-size` · `color` | `12px` · `var(--muted)` |
| S40 | The except line under *Cannot be read* | `font-size` · `color` | `12.5px` · `var(--muted)` |
| S41 | *Where the policies differ* box | `border` · `border-radius` · `padding` · `margin-top` | `1px solid var(--rule)` · `10px` · `12px 14px` · `14px` |
| S42 | Each difference row | `display` · `grid-template-columns` · `gap` | `grid` · `28px 230px 1fr` · `10px` |
| S43 | *the set above, nothing more* | `color` | `var(--muted)` |
| S44 | Legend: `[aria-label="Legend"]` | `display` · `grid-template-columns` · `background` · `border-radius` · `padding` · `font-size` | `grid` · `auto 1fr` · `var(--ground)` · `10px` · `12px 14px` · `12px` |
| S45 | Legend short name (`<lingtai home>`) | `font-family` · `color` | `var(--mono)` · `var(--accent-ink)` |
| S46 | Legend full path | `font-family` · `color` · `text-overflow` · `white-space` | `var(--mono)` · `var(--muted)` · `ellipsis` · `nowrap` |
| S47 | Foot: the parent of the two notes | `display` · `grid-template-columns` · `gap` · `margin-top` | `grid` · `1fr 1fr` · `14px` · `18px` |
| S48 | Each foot note box (*How Claude Code signs in here*, *Not covered*) | `background` · `border-color` | `var(--ground)` · `var(--surface-2)` (muted) |

## Visual checklist

Answer each item *yes* or *no* from a screenshot of the tab on a real four-run attempt, set beside design A in
`doc/milestone/0.15.0/sandbox-ui/index.html` (or `mock.png`). All must be *yes*.

1. The attempt switcher sits above everything else in the tab, looks as it does today, and the tab label has no count or badge.
2. The first thing under the switcher is one bordered row with a shield at the left, a sentence and a mono line in the middle, and two figures at the right.
3. With every run sandboxed, the shield is green and the sentence reads *Every run of attempt N ran inside the sandbox*.
4. The second figure (*connections refused*) is amber when above zero and ink-coloured at zero.
5. *Blocked* comes directly under the summary, before *Runs*, on an amber tint.
6. Each Blocked row reads host · `N×` · by · `HH:MM:SS UTC` · *Allow on this project*, and the Allow link looks like a button flush right, not a text link.
7. Hovering a Blocked time shows the full ISO time.
8. The muted sentence *Telemetry hosts are not counted. A refused file read is not listed: srt does not report one.* sits under the Blocked table.
9. *Runs* has the columns Step, Kind, Boundary, Policy, Refused, in that order. Refused is right-aligned.
10. The Kind tag for an agent is a lilac (`--held-soft`) tag reading `agent · <runtime>`; for a command, a muted outlined tag reading `command`.
11. Policy shows as a small boxed letter (A, B, C), not as *policy 1*.
12. No *The merge is Lingtai's own…* line appears under Runs; it is in the summary's mono line.
13. *What the runs could reach* shows four boxes side by side, in the order Reachable, Writable, Cannot be read, Cannot be written, each with its count at the right of its title.
14. Reachable lists hosts under Anthropic, OpenAI, npm, GitHub, then *This recipe*.
15. No chip, path or text overflows its box at a 1280px-wide window. Long paths wrap as whole chips and never run past the box edge.
16. Short names (`~`, `<lingtai home>`, `<worktree>`, `<mirror>`, `<cache>`) are drawn as dashed chips, and hovering one shows its full path.
17. `/tmp` appears once (no separate `/private/tmp` chip), and the temp directory is a path, not a `$TMPDIR` token.
18. Under the boxes, *Where the policies differ* has one row per policy: letter, its runs, and *also writes …* / *does not write …* / *the set above, nothing more*.
19. A muted legend follows, listing each short name used on the tab beside its full path. The full paths are cut with an ellipsis rather than overflowing.
20. Last, two muted boxes side by side: *How Claude Code signs in here* (only when a sandboxed Claude Code run is in the table) and *Not covered*.
21. There is no *Allowed* or *Limited* heading, and no list repeated per policy anywhere on the tab.
22. In dark mode, every tint (summary shield, Blocked, kind tag, chips, legend, foot) uses the dark palette. None is a light-mode hex left over.
23. On an attempt with a degraded run, the shield is amber, the sentence reads *3 of 4 runs of attempt N ran inside the sandbox*, and srt's reason is on the mono line.

## Map: every *Want* clause and *Done when* line

Test names are given as `describe › it` in `apps/board/unit/acceptance-1196.test.tsx` unless the sandbox file is
named.

### Want

| Clause | Proved by |
|---|---|
| *answers "did this attempt run inside the sandbox" in one line* | `Want: … in one line (the summary)` › *all runs sandboxed…*, *names the attempt it shows…*, *a degraded run…*, *a stopped run…*, *srt versions that differ…*, *the merge sentence moves…*; style S1–S13; checklist 2, 3, 4, 23 |
| *then shows what was blocked* | `Want: the tab leads…` › *Done when 1…* (order); `Want: then what was blocked` › all four; style S16–S22; checklist 5–8 |
| *then the runs* | `Want: then the runs` › all three; *Done when 1* (order); style S23–S31; checklist 9–12 |
| *then what the runs could reach listed once* | `Want: what the runs could reach…` › *lists the common entries once…*, *Cannot be read carries the except paths…*, *Edges, one policy…*; `Want: Reachable groups hosts by vendor…` › all three; style S32–S40; checklist 13, 14, 21 |
| *with only the differences per policy* | *lists the common entries once and names each extra path…*, *says what a policy lacks…*, *Edges, many policies…*; style S41–S43; checklist 18 |
| *in short path names* | `Want: short path names…` › *draws each path by its short name, longest prefix first…*, *the /private twins are one chip…*, *Watch out: no $TMPDIR token…*; `Done when 5 (pure)` › every case; checklist 16, 17 |
| *with the full path one hover away* | *draws each path by its short name…* (title = full path); *the /private twins…* (title = both); *the legend lists every short name used…*; checklist 16, 19 |
| Watch out: *an unknown is never a number* | `Watch out / Done when 3` › all five |
| Watch out: *no `$TMPDIR` token* | *Watch out: no $TMPDIR token…* |
| Watch out: *no badge on the tab* | checklist 1 (the label is `TaskTabs`', outside the tab's markup, so no render test of `SandboxTab` can see it) |

### Done when

| # | Line | Proved by |
|---|---|---|
| 1 | Renders, in order: summary, Blocked, Runs, the four reach boxes with the differences, the legend, the two notes; switcher above | *Done when 1: renders summary, Blocked, Runs…*; *Problem: the per-policy Allowed and Limited lists are gone…*; *How Claude Code signs in here only where it is shown today…*; checklist 1, 2, 5, 9, 13, 18–21 |
| 2 | Four runs, one common set, one path each different: common listed once, *Where the policies differ* names each extra path; unit test | *lists the common entries once and names each extra path under "Where the policies differ"* (the demo fixture is that exact attempt: install and build under A, implement + `/srv/runs/claude` under B, review + `/opt/codex-home` under C); *says what a policy lacks…* |
| 3 | `pending`, `lost` or `unreadable` makes the summary say so, never a plain total; unit test | *a pending run…*, *a unreadable run…*, *a lost run…*, *an incomplete read is a lower bound…*, *Edges: a row's own Refusals cell is unchanged…* |
| 4 | Runs has a Kind column: `agent · <runtime>` / `command` | *has a Kind column…*; *the step cell is "step · action", and the policy is a letter…*; *a run with no policy shows —…*; style S26–S28; checklist 10 |
| 5 | Short names; chip `title` is the full path; `/private` twins one chip; legend lists every short name used; unit tests of the naming incl. longest prefix | `Done when 5 (pure)` (16 path cases + Lingtai home outside home); `Want: short path names…` › all four |
| 6 | Every host in `BUILT_IN_DOMAINS` has a vendor; a unit test fails when one is added without | `packages/sandbox/unit/acceptance-1196.test.ts` › *names the same hosts as BUILT_IN_DOMAINS…*, *uses only the four vendor groups…*, *puts each host under the vendor the agreed mock shows*; *lists the recipe's own hosts under This recipe, and a built-in host with no vendor under Other* |
| 7 | Times in Blocked read `HH:MM:SS UTC` with the ISO time in `title` | *Done when 7: a host, its count, who, and the time as HH:MM:SS UTC…*; *keeps Allow on this project…*; style S19; checklist 7 |
| 8 | A person compares the tab on a real attempt with design A | The visual checklist above, items 1–23. This is a person's step; see below. |
| 9 | `pnpm typecheck` and `HOME=/nonexistent pnpm test` are green | Not a test here; see below. |

### Edges covered

| Edge | Proved by |
|---|---|
| A read that fails: no rows → *No wrapped run was recorded for this attempt.*, no figures | *Edges, a read that fails…* |
| Off by choice: the sentence, parts 4–5 not drawn | *Edges, off by choice…* |
| Degraded or stopped: parts 4–5 drawn for the policies that exist | *Edges, degraded: the reach is still drawn…*; *a stopped run…* |
| One policy: no *Where the policies differ* | *Edges, one policy…* |
| Many policies: each gets its row | *Edges, many policies…* (five policies, letters A–E) |
| `srtVersion` differs | *srt versions that differ…* |
| `source: 'not recorded'` → its vendor group, not *This recipe* | *Edges, source not recorded…* |
| A built-in host missing from the vendor map → *Other* | *lists the recipe's own hosts under This recipe, and a built-in host with no vendor under Other* |
| Two passes at once, restart, pause, retry, a stale page | Not applicable, as the ticket says (a read-only render of recorded events). Nothing to check. |

## Lines without an automated check, and why

- **Done when 8 (a person compares the tab with design A).** By its own wording this is a person's judgement.
  The visual checklist is what that person, or a vision model, answers. It needs a running board on a real
  attempt, which no unit test has.
- **Done when 9 (`pnpm typecheck`, `HOME=/nonexistent pnpm test` green).** This is a property of the finished
  change and of the whole repository, not a behaviour a test file can hold. It is checked by running those two
  commands after the implementation. These two acceptance files are part of what `pnpm test` runs, so it cannot be
  green until they pass. *I could not run `tsc` in this session (the command needed an approval I did not get), so
  that the two test files typecheck is unverified; they were written against `noUncheckedIndexedAccess`.*
- **Shield colour, figure colour, the Blocked tint, the Kind tag's tint, the button styling of Allow.** The
  ticket's *Edges: the cost to later tickets* says render tests "never pixels", so these are style rows S5–S7,
  S12, S16, S20 and S26–S28 and checklist items, not unit tests.
- **No badge on the tab label.** The label belongs to the task page's tab bar, outside `SandboxTab`. This is
  checklist 1. A render of the whole task page would need the loader's database reads, and those are integration.
- **The width of a page without overflow.** `renderToStaticMarkup` has no layout. This is checklist 15 and 19.

## How each test fails on this checkout

`npx vitest run apps/board/unit/acceptance-1196.test.tsx packages/sandbox/unit/acceptance-1196.test.ts` gives
**2 files failed, 57 tests failed, 0 passed**. Every failure is an assertion. None is a fixture or import error,
and in the unknown-refusal tests the fixture's own check (`refusals.kind` is `pending`/`unreadable`/`lost`)
passes before the summary assertion fails.

| Failure message (first failing assertion) | Tests that fail on it | Why it fails today |
|---|---|---|
| `a part labelled "Summary": expected null not to be null`, or `aria-label="Summary": expected -1…` | every summary test, the four unknown-refusal tests, *Done when 1* | There is no summary row. |
| `a part labelled "What the runs could reach": expected null…` | every reach, vendor-group and short-name render test, and *Edges, degraded* | Reach is drawn today as *Allowed*/*Limited*, once per policy. |
| `a part labelled "Legend"` / `"How Claude Code signs in here"` | the legend test, the foot-notes test | There is no legend. The auth sentence is a bare `<p>` inside *Limited*. |
| `…not to contain 'aria-label="Allowed"'` | *Problem: the per-policy Allowed and Limited lists are gone* | The per-policy lists are still drawn. |
| `…to match /Kind/`, `…to contain 'agent · codex'`, `…to include 'A'`, `…to include 'command'`, `…not to match /merge is Lingtai/` | the three Runs tests, *a row's own Refusals cell*, *the merge sentence moves* | There is no Kind column and no policy letter (it reads *policy 1*), and the merge sentence is under Runs. |
| the `title="…ISO…">17:40:45 UTC<` regex, `/17:40:45 UTC Allow on this project$/`, `…to contain 'Telemetry hosts are not counted.'` | the four Blocked tests | The time is drawn as the raw ISO string, and the note under Blocked does not exist. |
| `expected 'undefined' to be 'function'`, `expected undefined to be '<…>'` | the 18 `Done when 5 (pure)` tests | `shortNameOf` is not exported from `sandbox-view.ts`. |
| `BUILT_IN_VENDORS beside BUILT_IN_DOMAINS…: expected undefined to be defined` | the 3 tests in `packages/sandbox/unit/acceptance-1196.test.ts` | The constant does not exist. |

Five tests passed on the first draft because they only checked behaviour the ticket keeps unchanged: the Refusals
cell, the Allow link, the empty sentence, the `—` cell and the absence of a TMPDIR token. Each was rewritten to
also require the new layout it sits in: the Kind column, the UTC time in the same row, the note under Blocked, a
`—` in the Policy column as well as the Refused one, and a titled chip. Each now fails for that reason.
