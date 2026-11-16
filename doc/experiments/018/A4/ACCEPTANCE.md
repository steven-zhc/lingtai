# Acceptance — the task page's record is one tab per subject

Ticket: `TICKET.md`. The issue number is not in the ticket. **885** is inferred: the ticket calls itself #882's child 3, and the documents and tickets beside it are #883, #884, #886 and #887. Rename the test file if the number is different.

Tests: **`apps/board/unit/acceptance-885.test.tsx`**, 33 tests, unit half. GitHub, the event store, spend, the recipe read and `next/navigation` are stubbed, so it runs under `HOME=/nonexistent pnpm test`.

## What the tests assume of the new code

These are the only names the tests use, and the ticket names each of them.

- `apps/board/src/app/task/[id]/layout.tsx`:
  - The default export is the layout, `({ params, children })`. It renders `<Follow>` around `<TaskBody task={…}>{children}</TaskBody>`, with `loadTask` called inside `measure(…, { label: '/task' })`.
  - The named export is `TaskBody({ task, now?, children? })`. It draws the bar, `Standing`, the tab row and `children`.
- `app/task/[id]/page.tsx`, `app/task/[id]/attempt/[n]/page.tsx` and `app/task/[id]/ticket/page.tsx`:
  - Each default export is `({ params })` and resolves to the element it renders.
  - Each loads inside `measure(…, { label: '/task tab' })`.
- `loadAttemptTab(taskId, n)` and `loadTicketTab(taskId)`, exported from `apps/board/src/lib/task.ts`.
- The tab row:
  - Tabs are `<a href="/task/<id>/attempt/N">` or `<a href="/task/<id>/ticket">`, labelled with text that starts `Attempt N` or `Ticket`.
  - The selected tab carries `aria-current="page"` or `aria-selected="true"`.
  - Attempts that get no tab are links inside one element whose text contains *earlier attempts*.
  - The tests stub `useSelectedLayoutSegments` (and `usePathname`) to set the path.
- Section names in an attempt tab: each `<summary>` starts with `Changes`, `Prompt`, `Recipe`, `Run log` or `Events`. Case is ignored, so `RunLog`'s own `run log` summary counts.

## How each test fails on this checkout

| Count | Failure | Why |
|---|---|---|
| 23 | `Cannot find module …/layout.tsx`, `…/attempt/[n]/page.tsx` or `…/ticket/page.tsx` | The layout split (Fix 1) has not been made. |
| 2 | `No "loadAttemptTab"` / `No "loadTicketTab" export` | The loaders (Fix 3) do not exist. |
| 3 | The default page's markup contains `3333bad`, `2222bad` or `PROMPT-OF-ATTEMPT-1` | Today `/task/<id>` renders every attempt, with four panels hidden, so another attempt's content is present. |
| 1 | `loadTask` was called once | Today's default route calls `loadTask`. The new child must not. |
| 1 | `expected [Function Reveal] to be undefined` | `Reveal`, `openTo`, `panelOf` and `Latch` have not been deleted (Fix 6). |
| 3 | `notFound` cases: module not found | The `attempt/[n]` route does not exist. |

I checked the fixtures against today's code with a throwaway assertion, then removed it:

- The scenario `{ n: 3, refused: 2, waiting: true }` reduces to `standing.deciding.attempt === 2`, state `blocked`, three `finished` attempts, and `diagnosis.raw` equal to the wait's evidence.
- The six-attempt scenario decides on attempt 1.
- The HTML reader finds today's `run log` `<details>` nested inside the attempt's `Latch` (class `attempt`). That nesting is exactly what Fix 6's test refuses.

## Want → proof

| Want clause | Proved by |
|---|---|
| The record is one tab per subject: **Ticket**, then **Attempt N** for each attempt, newest first | `Want + Edge "Tab facts": the tab row is links — Ticket first, then Attempt 3, 2, 1 …`; `Want: none of the five old tabs …`; style rows S1–S4; checklist 2–4 |
| … as 0118 §2 now says | Checklist 4 and 5 (the attempt tab's order) |
| Each tab is its own URL | `Want "each tab is its own URL" + Edge "The selected tab" …`; all `Done when 1` tests render each route on its own path |
| Opening the page renders the top of the page and one tab | `Done when 1` (three tests); `Edge "The default tab": rendered in place, not a redirect` |
| Another tab is read only when it is opened | `Done when 5` (four tests): `loadAttemptTab` reads one attempt's recipe and no GitHub; `loadTicketTab` reads no attempt; an attempt tab and the default tab never call `loadTask` or `readProjectTicket`, and run in a `/task tab` measure with no `github.issue`. When it really runs: Done when 7 (a person, Jaeger). |

## Done when → proof

| # | Done when | Proved by |
|---|---|---|
| 1 | `/task/<id>`, `/attempt/<n>` and `/ticket` render the bar, `Standing` and one tab; other tabs' content is absent | `Done when 1` ×3, and `Want "each tab is its own URL"` |
| 2 | Default tab is deciding, else newest, else Ticket | `Done when 2` ×4, and `Edge "The selected tab": at /task/<id> the default tab is marked …` |
| 3 | Attempt tab order, with the reasoning only on the deciding attempt, and the five sections closed | `Done when 3`: `summary line, base/head line, Steps …`; `the wait's reasoning is only on the attempt the page is deciding on` |
| 4 | One attempt is labelled `Attempt 1`; no `pass-` and no `the run` in labels, the summary line or the meta line | `Done when 4` ×3 |
| 5 | `loadAttemptTab` never calls `readProjectTicket`, `readControl`, `outgoingFor` or `queuedFor`, and runs `recipesFor` for one attempt | `loadAttemptTab never calls …` (one `recipeOfAttempt` call, for attempt 2) |
| 6 | More than three attempts: three newest, plus deciding and open, then *earlier attempts* | `Done when 6` ×2 |
| 7 | (a person) #603 under 1 MB after a restart; Jaeger shows a tab switch as one `page` span with no `github.issue`; the page matches the mock | **Not testable here.** It needs the live board, #603's real log and Jaeger. Its code-level half is the `/task tab` measure test. The rest is checklist 1–12. |
| 8 | `pnpm typecheck` and `HOME=/nonexistent pnpm test` are green | Run by the build gate. Several existing tests are expected to be rewritten or deleted (ticket, Edges, "The cost to later tickets"). |

## Edges → proof

| Edge | Proved by |
|---|---|
| The default tab is in place, not a redirect | `Edge "The default tab"` |
| `Follow` moves into the layout; `TaskBody` is the layout's | `Edge "Follow": the layout mounts Follow around TaskBody …` |
| The selected tab at `/task/<id>` | `Edge "The selected tab": at /task/<id> …` |
| Pointers become absolute links | `Edge "The pointers" …` (no `href="#attempt-`, no `href="#record-`, and `href="/task/<id>/attempt/2"` is present) |
| No attempts yet | `Edge "No attempts yet"` |
| `attempt/[n]` is not an attempt (0, beyond the last, not a number) | `Edge "attempt/[n] that is not an attempt"` ×3 (expects the `404` digest) |
| Tab facts: outcome and cost; Ticket's event count | `Want + Edge "Tab facts"`. Cost is checklist 3: the fixtures have no spend rows, so cost reads *unknown*. |
| The Events section shows that stream only, with no stream-id or seq heading | `Edge "The Events section"` |
| Changes paths are relative to the repository | `Edge "Changes"` |
| Prompt is captioned by its size, with the version in `title` | `Edge "Prompt"` |
| A read that fails in a child loader | `Edge "A read that fails in a child loader"` |
| The Run log section is `RunLog`'s own `<details>` | `Fix (6): the Run log section is RunLog's own <details> …` |
| `Reveal`, `openTo`, `panelOf` and `Latch` are deleted; `useLatch` and `fragmentId` are kept | `Fix (6): Reveal, openTo, panelOf …` |

## Style table

**The mock (claude.ai artifact `W56gPtnYeM8yX27dXWTTzp`) could not be read from this session**: the docs connector's read was refused permission. So the values below are the board's own current tokens for the record and its tab strip (`apps/board/src/app/globals.css:2136-2175`). The ticket says the mock was *built from the live page with only the record regrouped*, so these should be the mock's values too. **A person should confirm each row against the mock** and correct any row that differs.

| # | Element (how to find it) | Property | Expected |
|---|---|---|---|
| S1 | The record box (the element holding the tab row and the open tab) | `background` / `border` / `border-radius` | `var(--surface)` / `1px solid var(--rule)` / `3px` |
| S2 | The tab row (the container of the `Ticket` / `Attempt N` links) | `display` / `flex-wrap` / `border-bottom` | `flex` / `wrap` / `1px solid var(--rule)` |
| S3 | A tab link (`Attempt 3 …`), not selected | `font-family` / `color` / `padding` / `border-bottom` | `var(--mono)` / `var(--muted)` / `0.55rem 0.85rem` / `2px solid transparent` |
| S4 | The selected tab link (`aria-current="page"` or `aria-selected="true"`) | `color` / `border-bottom-color` | `var(--ink)` / `var(--accent)` |
| S5 | A tab's name (`Attempt 3`, `Ticket`) | `font-size` / `letter-spacing` / `text-transform` | `0.78rem` / `0.12em` / `uppercase` (today's `.rname`) |
| S6 | A tab's fact (`finished · $4.38`, `12 events`) | `max-width` / `overflow` | `24ch` / `hidden` (today's `.rfact`) |
| S7 | A tab link | `text-decoration` | `none`. **The ticket gives no value.** A link styled as a tab must not show an underline, but this row is inferred, not taken from the mock. |
| S8 | The five closed sections (`Changes` … `Events`) | disclosure marker | The board's shared `details > summary::before` triangle, as for every disclosure on the board. |

## Visual checklist

Compare a screenshot of `/task/ticket-lingtai-603` and one of `/task/ticket-lingtai-698` with the mock. Answer each item yes or no.

1. The top of the page (bar, state, reason, moves, rail, Discussion) is unchanged from before this ticket.
2. Below it there is one tab row, and its first tab is **Ticket**.
3. After Ticket come **Attempt N** tabs, newest first. Each shows its outcome and cost (`Attempt 7 · finished · $4.38`).
4. No tab is called History, Diff, Findings or Attempts, and no tab label shows `pass-…` or `the run`.
5. The open attempt tab reads, top to bottom:
   - the summary line (outcome, turns, time, cost, diff size, date);
   - the base/head/branch line;
   - **Steps** (the rail, then the verdicts);
   - on the deciding attempt only, the wait's reasoning;
   - then **Changes**, **Prompt**, **Recipe**, **Run log** and **Events**, all closed.
6. Hovering the base/head line shows the run id. The run id is not visible text.
7. With more than three attempts, at most five attempt tabs show, and the rest are under one *earlier attempts* list.
8. Clicking a tab changes the URL to `/task/<id>/attempt/N` or `/task/<id>/ticket`, does not scroll to the top, and the top of the page does not flash or reload.
9. Opening `/task/<id>#attempt-7` lands on `/task/<id>/attempt/7`, and `#record-ticket` lands on `/task/<id>/ticket`.
10. With JavaScript off, every tab still opens, and the closed sections open.
11. On a running item, the running attempt's Run log is open and following, or it says the log is followed at the top.
12. Nothing overflows its box. Long paths under **Changes** wrap or clip inside the record, and the tab row wraps rather than scrolling sideways.
13. A **Changes** path reads `apps/…`, not `/…/.lingtai/worktrees/…`.

## Lines with no automated check, and why

- **Done when 7** (page size under 1 MB, the Jaeger span, matching the mock) needs the live board, #603's real log and a Jaeger instance. A unit test cannot measure bytes of a real render, and the ticket rules out byte targets in tests (Out of scope). The checklist and the `/task tab` measure test cover what can be covered.
- **Old fragment URLs** (`#attempt-N` → `attempt/N`): this is a client effect on `window.location`, and the suite has no DOM. Covered by checklist 9.
- **The attempt in flight follows its log**: `RunLog`'s live tail needs a browser and a run. Covered by checklist 11.
- **`cache()` shares reads between the layout and the child within one render**: React's `cache` only dedupes inside a server-components render, which the unit half does not have. Each loader's own reads are pinned by the `Done when 5` tests. Sharing is checked with Jaeger (one `events.task` per request).
- **An append refreshes both segments, and a new claim's tab appears**: `router.refresh()` needs Next's app router. The layout keeping `Follow` is pinned by `Edge "Follow"`.
- **Docs** (`doc/design/task-detail-page.md:37` and `:62`, and the comments that name five tabs): these are prose, not behaviour. A reviewer reads the diff for them.
- **Changes keeps `RunDiff`**: the fixtures have no `projects` client to diff with. A reviewer reads the diff for it.
