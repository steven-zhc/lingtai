# 0123 — The report: what it counts per ticket, what it averages, and how the tickets that went round most are explained

**Status** proposed · 2026-10-28

The report says, for a window of time and a project, how many tickets the
pipeline resolved, and for each landed ticket how many passes, fix rounds and
waits it took, how long the machine worked on it and what it cost. It also lists
the tickets that went round most, and where each one's money went. Every number is read
from events already on the log, folded into one row per ticket by a
projection, `ticket_report`, so the report page only aggregates rows. No event
is written for the report. Time spent waiting on a person is not counted. The
explanation of such a ticket is assembled from recorded facts and costs
nothing. What to learn from a ticket is a separate, optional step: an agent
plugin at `end:`, decided in its own ADR.

**Words.** A **ticket** is one `ticket-<project>-<n>` stream. A **pass** is one
claim of it, whatever started it: the queue, a restart, a requeue, or a granted
round. A **continuation**, a held run going on after a person's approval, is
not a claim (0109 §5): it is `TicketContinued`, or, on the log written before
that, a `TicketClaimed` whose `runId` was already claimed on its stream. A **fix round** is a paid run answering a refusal.
A **wait** is one `WaitStarted` on the ticket's stream. The **window** is the
span of time the report covers.

## Context

`/spend` sums the cards the board is showing (`apps/board/src/app/spend/page.tsx`
says it is *"the same window as the board"*). It has no per-ticket view, no
time, and no count of passes or rounds. The questions the operator asks after a
night of unattended work have no surface: how much got done, what a landing
takes, and why one ticket cost ten times another. The facts are all recorded:

- `TicketClaimed`, `TicketLanded`, `TicketClosed`, `TicketReleased`,
  `WaitStarted`, `WaitResolved` and `WaitTriaged` on the ticket's stream;
- `RunSpent`, with its purpose (`SpentFor`, 0110 §9) and its round, linked to a
  ticket by the `spend` projection (`packages/projector/src/spend.ts`).

The operator's decisions in epic #648 are the inputs here.

## Decision

1. **The unit is the ticket, and its outcome places it in a window.** A ticket's
   **outcome** is *landed* (its last `TicketLanded`), *closed* (a
   `TicketClosed` with no landing after its last claim), or *open*. A landed or
   closed ticket belongs to a window when its outcome's event falls inside it.
   An open ticket belongs to every window that contains any of its passes, and
   is reported apart from the averages. The windows are **today**, **the last 7
   days**, and **a date range** the reader picks (which also covers *everything
   the store holds*). A project filter and a **kind filter** (the recipe's
   `source.kinds`: `bug`, `tech-debt`, `feature`, `documentation`) narrow any of
   them. The report reads the log as it is, and a store that has been reset
   simply holds less.

2. **Per ticket, the report counts these, and only from these events:**

   | Fact | Read from |
   | --- | --- |
   | passes | the claims on the ticket's stream, continuations excluded by 0109 §5's rule |
   | fix rounds | distinct `(pass, round)` pairs among the ticket's `RunSpent` events whose `for` is `Action` with `round ≥ 1` (0110 §10), **summed over every pass of the ticket** |
   | reviews | each review's `StepEnded` on the ticket's pass streams (`outcome.step` is `review`), with its `round`, its time, and the count of its findings that are `blocker` or `major`; a review passed when it has none of those **and** every action of the step cleared, so an interrupted review has not passed |
   | waits | `WaitStarted` on the ticket's stream, each with its reason's tag, its latest `WaitTriaged` cause if any, and its `WaitResolved` resolution |
   | machine time | one interval per claim and per continuation, from it to the earlier of the first `TicketLanded`, `WaitStarted`, `TicketReleased` or `TicketClosed` after it and its last sign of life (below), summed. The approval itself starts nothing; the continuation after it opens its own interval |
   | cost | the ticket's `RunSpent` events, split by purpose: Work, Answering, Judge, Triage, Discussion (`apps/board/src/lib/spend.ts:30`) |
   | unknown | the number of the ticket's `RunSpent` events with no reported or priced cost, plus one for each claim that has no `Action` `RunSpent` at all. A claim is one `runId` (0109 §5), so this is the board's rule (`withNoSpendFallback`, `apps/board/src/lib/spend.ts:113`) and a continuation adds nothing |

   **Machine time excludes waiting on a person.** A triage or a discussion runs
   while the ticket waits, so its money counts and its time does not. A pass
   with a claim and no ending event (one in flight, or one whose conductor died
   before it appended one) contributes no time, and the report says how many
   such passes it skipped, together with the intervals that had no event of
   their own and so contributed 0.

   **Every interval ends at its last sign of life, so a crash costs no hours.**
   A conductor that dies leaves its claim standing, and the next one to start
   appends the `TicketReleased` (`packages/conductor/src/claim.ts:20-23`,
   `packages/daemon/src/reconcile.ts:664`), hours later after a night's crash.
   That release cannot be told from an ordinary one: both are `actor:
   conductor` with `cause: null`, and only the reason's wording differs, which
   0120 forbids reading. So no release is singled out. An interval's last sign
   of life is the last event, in log order (`seq`), between its opening event
   and its ending event, on the pass's own `pass-…` stream or on the
   integration lane naming this ticket (`IntegrationAttempted` and its
   outcomes carry `ticketId`), so a merge's own minutes count. After a crash
   that is the last thing the dead process did; in an ordinary pass it is
   seconds before the ending event. An interval with no such event contributes
   0 and is counted as incomplete. It is a lower bound the log can check, and
   it needs no event to be recognised.

   **A ticket's kind is its last claim's `kind`.** A continuation carries none
   (0109 §5), so it never clears the kind. A label changed between passes moves
   the ticket to its newest kind. A ticket whose every claim has a null kind is
   *unclassified*, a value of its own in the kind filter and in the per-kind
   table, never dropped.

   **Fix rounds sum over passes.** A ticket that took three passes of four
   rounds each took twelve rounds, not four. A per-pass count hides exactly the
   tickets that cost most (#658: 14 rounds over 4 passes).

   **Fix rounds are counted from `RunSpent`, not from routing, and are a floor.**
   `PassRouted`'s `fix-lines` decisions miss the rounds a person grants, the
   rounds after a base merge and the rounds a red build buys mechanically: on
   2026-10-28 the log held 347 rounds by `RunSpent` and 288 by `fix-lines`. A round
   whose process was killed before it returned records no `RunSpent` (0110 §2),
   so it is not counted, as its cost is not; a round count is *at least*, like
   a spend total.

3. **The overview averages landed tickets only.** For the window and project
   chosen it shows:
   - landed, closed and open counts;
   - for landed tickets, the mean **and** the median of passes, fix rounds,
     waits, machine time and cost;
   - for landed tickets, the share that landed after **0 or 1 fix rounds** and
     the share that needed **5 or more**. The second is the convergence measure
     (#669): on 2026-10-27 it was 10% of 167 landed tickets, while the median
     was already 1;
   - **how many tickets are still not past review after k reviews**: for
     the tickets whose first review falls in the window, the share not yet
     passed after 1, 2, 3 … reviews, counting every review of the ticket in
     time order across its passes. A ticket that stops without passing (landed
     on a person's approval, closed, or still open) leaves the count at its
     last review rather than counting as passed or failed (a Kaplan-Meier
     estimate). Converging review drops fast and reaches near zero; a curve
     that flattens high is review that does not converge. On 2026-10-28, over
     174 tickets: 54% not passed after one review, 33% after two, 27% after
     three, 19% after four, 12% after five, and 9% after seven, so about one
     ticket in ten never passes in the reviews it gets;
   - **spend in the window: every run whose `at` falls inside it**, whatever
     its ticket's outcome, read from `spend` by run day, the same basis as the
     spend-per-day chart, so the tile is the sum of the chart's bars. The kind
     filter narrows it by the kind `spend` recorded on each run when it folded
     it (0110 §11): a ticket relabelled between passes has its spend split
     across its kinds, which is rare and accepted. Money spent
     on work that never landed is in it, which is the number an operator most
     needs and an average over landings hides. A ticket's own cost (its
     average, its row in §4) is a different figure: all of that ticket's spend,
     on whatever days it fell. Both are said by their labels;
   - **per kind**: landed count, median fix rounds, the 0-or-1 and 5-or-more
     shares and mean cost per landed ticket, from `ticket_report`; and spend in
     the window, from `spend` by the kind it recorded per run. Kinds converge
     differently: on 2026-10-27, 15% of landed `feature` tickets needed 5 or
     more rounds against 0% of `tech-debt`;
   - the unknown count beside every dollar figure, never folded into it as zero
     (0110 §5, 0122 §5). Unreported rows are priced when a rate card exists
     (#645) and shown as estimated, never as reported.

4. **The tickets that went round most are explained mechanically.** The eight
   tickets in the window with the most fix rounds, any outcome, cost breaking a
   tie; the reader can sort the same list by cost instead. Each with:
   - its cost and the share of each purpose;
   - its passes, fix rounds and waits;
   - each wait's reason and triage cause, and how it was resolved;
   - one sentence assembled from those facts, leading with the largest share:
     *72% answering refusals over 6 fix rounds · 3 passes · waited 3 times
     (FixableLines ×2, ConflictingHunks).*

   The sentence is a template filled from the table above. No model writes it,
   and nothing in it is a claim the facts beside it cannot check.

5. **Lessons are not the report's.** Numbers are a fold of the log; a judgement
   about what to learn from a ticket is paid work. That work is an optional
   agent plugin at `end:` (a *retro*), off unless a recipe declares it, which
   reads a landed ticket's record and writes its observations. Its design, what
   it writes and where, and how observations across tickets are gathered, are
   its own ADR, discussed with the long-term roadmap agent. The report itself
   spends nothing and never starts an agent.

6. **One projection, two surfaces.** `ticket_report` is a projection beside
   `task_view`, `finding_backlog` and `spend`: one row per ticket holding the
   facts of §2 (outcome and its time, passes, fix rounds, reviews with their
   rounds, times and blocking counts, waits with their
   reasons and resolutions, machine time, cost by purpose, unknown count, and
   the time of every pass, so a window can place an open ticket). It is a fold
   and nothing else, kept current by the projector every appending process
   already holds (0022), and corrected only by
   `lingtai projection rebuild ticket_report`. **It folds the log itself and
   never reads another projection's table**, for the reason `spend` gives (`spend.ts:22-24`):
   each projection is at its own checkpoint. So it folds `RunSpent` directly,
   linking each to its ticket by the same rule `spend` uses (the pass stream's
   claim, the ticket stream, a discussion's request), and the two can be rebuilt
   apart. **Money is stored, as 0110 §5 allows**: per ticket and per purpose,
   the reported `costUsd` summed, the estimate summed (priced in this fold at
   the rate of each run's own day), and the count of runs with neither, three
   columns never added into one. **Spend by day is `spend`'s question and spend
   per ticket is this one's**: the window's spend tile and the spend-per-day
   chart read `spend` by each run's `at` and the kind it recorded; averages,
   the per-kind ticket figures and §4 read this table. When a model gains its first price (#678 prices its earlier
   runs at that first price), both projections are rebuilt, as 0110 §5 says.
   **A second fetch on the same day may replace that day's price**
   (`mergeSnapshot`, `packages/domain/src/rate-card.ts:231`), which happens
   only when a conductor restarts on a day the upstream price changed. Rows
   already folded keep the earlier estimate and a rebuild would use the later
   one. That is accepted: an estimate is not a bill, and rebuilding everything
   for it is not worth the time. The board's `/report` page and `lingtai
   report` aggregate its rows (and `spend`'s, for spend by day) for the window
   and project chosen; the aggregation, §3's figures and §4's sentence are one
   pure function both call.
   The CLI command only reads, so it takes `--json` (0121 §5), takes
   `--window today|7d`, `--from <date> --to <date>`, `--kind <k>` and
   `--project <p>`, and sits in the *everyday* help group (0121 §7). `--window`
   and `--from`/`--to` exclude each other: given both, the command is refused,
   naming both flags (0121).

7. **The page.** The board's `/report` wears the board's own chrome and tokens:
   its top bar, cool neutrals, teal as the only accent, amber never used, since
   amber means *a person is waited on*. Chart series use colours that are none of
   the board's states (not amber, red or green). Top to bottom:
   - the filters: window, dates, kinds;
   - figure tiles: landed (with closed and open), median fix rounds, the
     5-or-more share, the 0-or-1 share, spend in the window (by run day) with
     its unknown count, median machine time;
   - five panels: fix rounds by bucket (0, 1, 2, 3, 4, 5+) stacked by kind;
     tickets still not past review after k reviews, a step line from 100%
     down, each step labelled with the tickets still at risk;
     landings per day stacked by kind; spend per day stacked by purpose (from
     `spend`, by each run's day); and
     **why tickets waited, as a cross-table of each wait's reason against its
     triage cause** (no triage being a column of its own);
   - the per-kind table of §3;
   - §4's list, each ticket linking to its task page.

   Every chart has a hover with its exact figures and a legend; no chart has two
   y-axes.

## Consequences

- An average over landings says nothing about tickets that did not land. That is
  why spend in the window covers every run, whatever its ticket's outcome, and
  closed tickets are counted beside the landed ones.
- A requeue and a granted round each add a pass; an approval's continuation
  does not. *Passes* measures how often the pipeline had to start over or be
  helped, not how many restarts it chose.
- One more projection means a table, a checkpoint and a rebuild on both stores
  (Postgres and SQLite), and a fold that has to be kept in step with the events
  it reads. That is the price of a report page that does not read the whole log
  on every request.
- Changing what a fact counts is a code change plus one rebuild, never a
  migration by hand.
- 0121 §7's *everyday* row gains `report`.

## Not decided here

- Comparison between two windows side by side.
- Splitting figures by model.
- Reverts as a guardrail beside the round counts. Lingtai records no revert
  today, so there is nothing to count; it is added when there is.
- The retro plugin of §5: what it reads, what it writes, and how observations
  across tickets become a common-issues table.

## Mockups

[`0123/`](0123/index.html) holds the page this decision was drawn against. It
opens directly in a browser; the only thing it loads from outside is its fonts.
Its numbers are this installation's log as it stood on 2026-10-28. It illustrates the decision and
does not extend it: where the mockup and this text differ, this text is the
decision. In particular it prices runs from before a model's first fetched price
at that first price, which is #678 and not yet built; it puts a ticket's whole
cost on its landing day, where §6 takes spend per day from `spend` by each run's
day; it counts an approval's continuation as a pass; and it folds the Triage and
Discussion purposes into one series to keep the chart to four colours.

---

_New topic; replaces no archived ADR. The design discussion is #648._
