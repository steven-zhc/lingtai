# 0110 — Spend: every paid call appends one `RunSpent`, the `spend` projection holds them, and an estimate is folded at the price of the run's own day

**Status** accepted · 2026-10-01, revised 2026-10-18 and 2026-10-28 (§5: projections store estimates)

Every paid call appends one `RunSpent` when it returns, and nothing else on the
log carries spend. A paid call is one process: one _run_. `RunSpent` records
what the run consumed, in two parts: the dollars the runtime itself reported
(`costUsd`), and the token counts, kept separately rather than summed, together
with the model and mode needed to price them. `costUsd` is always written, and
`null` when the runtime did not say; every token field is optional, and absent
means the same. Neither is ever zero for _not said_. The `spend` projection
folds one row per `RunSpent`. Lingtai never computes money on the way into the
log: an event carries what the runtime said and nothing priced. A projection
may store money, as facts of its own, kept apart: the dollars the runtime
reported, and an estimate priced in the fold from the row's counts at the rate
in force on the run's own day, from [`doc/rate-card.md`](../rate-card.md) and
the dated snapshot behind it. A reader then sums stored columns.

## Context

One pass may dispatch two runtimes, and only Claude Code reports dollars. Codex
reports token usage and no price. A step with no recorded spend shows on the
board as costing nothing, which reports unknown cost as free. A single summed
token count also cannot be priced: cache reads cost about 0.1× fresh input and
cache writes about 1.25×, so one sum spans a 12× range. One model id can also
carry more than one price (Claude Opus 5 has a standard rate and a fast mode).
The run log is deleted when a ticket lands, so a number that only reaches the
run log is gone by the time anyone asks what the work cost.

Lingtai starts a paid process in six places, and they do not end on the same
kind of event. The implementer ends on `RunFinished`, a fix round on
`FixApplied`, a discussion on `DiscussionAnswered`. The cold reviewer and the
designer end inside a step's verdict, and a judge ends inside a route's
decision, neither of which is about money. Spend written onto whichever event a
call happens to end on has no single owner, and the three calls whose ending is
about something else are the three whose spend is not recorded.

## Decision

1. **`RunSpent { for, runtime, turns, durationMs, usage, costUsd }`, and `costUsd` is a statement the runtime made: `null` means it made none.**
   Claude Code fills it from its receipt; Codex always records `null`, never
   `0`. `usage` is decision 3's five counts. `runtime` is the runtime's id.
   There is no field for a price: it would be money on the way into the log,
   which decision 5 forbids for events.

2. **One `RunSpent` per paid call, and nothing else carries spend.** Every
   place that starts a paid process appends it; no other event has a spend
   field. A reason may quote a number as evidence (`BudgetExhausted`'s
   `costUsd` in [0120](0120-a-reason-is-a-type.md) §2 says how far a run got
   before its ceiling stopped it); that is evidence about a stop, not spend,
   and nothing sums it.

   **A paid call is one process.** One `Runtime.run`, one _run_ in the
   glossary, one `RunSpent`. A fix round is one run. A discussion question that
   takes three processes is three runs and three `RunSpent`s.

   **A run that returned a result records its spend, failed or not; a process
   killed with no result records nothing.** Out of turns, out of dollars, a
   failed review, an unreadable answer and a crash that still returned a
   `RunOutcome` all append `RunSpent`. A process killed before it returned
   anything (the wall clock, a second Ctrl+C, a crash of the conductor itself)
   has nothing to record, and records nothing. **So spend on the log is a lower
   bound**, and the runs it misses are the long ones: whoever reads a total
   reads it as _at least_.

3. **Tokens are recorded as five counts, accumulated across turns, never
   summed, and disjoint.** `usage` is `Usage` (`packages/domain/src/spend.ts`):
   an array of entries, one per model a call billed, each holding its own
   `tokens`:

   | count             | claude-code                   | codex                                     |
   | ----------------- | ----------------------------- | ----------------------------------------- |
   | fresh input       | `input_tokens`                | `input_tokens − cached_input_tokens`      |
   | served from cache | `cache_read_input_tokens`     | `cached_input_tokens`                     |
   | written to cache  | `cache_creation_input_tokens` | `cache_write_input_tokens`                |
   | output            | `output_tokens`               | `output_tokens − reasoning_output_tokens` |
   | reasoning output  | not reported separately       | `reasoning_output_tokens`                 |

   **Codex's own counts overlap, and the event's must not.** `cached_input_tokens`
   is part of `input_tokens`, and `reasoning_output_tokens` is part of
   `output_tokens` — measured against a real rollout, where `total_tokens` equals
   `input_tokens + output_tokens` exactly. Storing `input_tokens` as fresh input
   whole would charge the cached portion twice once it was also primed as
   cache-read. So the Codex adapter subtracts, and only when both operands were
   reported. An absent `cached_input_tokens` leaves nothing to subtract, so
   `input_tokens` is kept whole as fresh — dropping it instead would be the
   inversion decision 4 forbids, reporting tokens the runtime did say as tokens
   nobody billed. Where `reasoning_output_tokens` is absent, the whole of
   `output_tokens` is kept the same way — there is no overlap to protect
   against, and it is still billed correctly at the output rate either way.
   claude-code's four counts need no such subtraction: its own `modelUsage`
   already reports them disjoint.

   **Only the cached/reasoning pair is measured; `cache_write_input_tokens`
   is not.** No rollout and no fixture this project has seen carries that
   field, so whether it too sits inside `input_tokens` — the way
   `cached_input_tokens` demonstrably does — is open. The adapter stores it
   whole rather than subtracting it out of fresh, which is correct if it is
   its own quantity and double-counts it if it is not. Whoever first sees a
   real `cache_write_input_tokens` settles this from that rollout the way the
   cached/reasoning pair was settled here, and corrects this paragraph rather
   than adding a third counting rule beside it.

   **One entry per model, keyed by `(model, mode)`.** claude-code's `modelUsage`
   is itself keyed by model id, and a call can bill more than one — for
   claude-code, `model` on each entry is that key, verbatim, never the model
   the recipe asked for. **Codex is the opposite, and deliberately so: its
   stream never names the model that served the call, so `model` on its one
   entry is `request.model`, the recipe's ask — which says nothing about what
   actually served it, whether through a provider substitution or because
   `request.model` was absent and the run fell through to `~/.codex/config.toml`'s
   default.** A reader pricing or asserting on `usage[].model` as a runtime-reported
   fact is only safe doing so for claude-code; for Codex it is the request
   echoed back. Entries merge by `(model, mode)` when tokens from two turns are
   added together (`addUsage`); a differently-keyed entry is a second line in
   the bill, not a second count of the same one. `mode` names a premium speed
   at the same model id, where a runtime has one. Events take one array rather
   than loose fields, because nobody writes events by hand.

4. **Every token field is optional, and none defaults to zero; `costUsd` is
   written, and `null` when not said.** A `.default(0)` anywhere in these
   groups would report unknown cost as free. That is also why there is no
   `Reading<T>` wrapper: `null` and an absent count already say _not said_,
   and a reported `0` is a `0`.

5. **An event never carries a price; a projection may store an estimate, kept
   apart from what was reported.** An event records what the runtime said. A
   fold that prices a run reads the event, the shipped card and the dated
   snapshot, and nothing else: no clock and no network. It prices at the rate in
   force on the run's own `at`, so a price that changes later never moves a row
   already folded, and a rebuild gives the same figure, with one accepted
   exception below. It stores, per row,
   `cost_usd` (the runtime's own `costUsd`, `null` when not said), and
   `estimated_usd` with whether the snapshot was used (`null` when it could not
   be priced). The two are never added into one column, and a row with neither
   is unknown, never `0`.

   **A model that gains its first price re-folds what stored an estimate.** The
   one way a stored estimate goes stale that is repaired is a run of a model that had no row when
   it was folded. So when a snapshot refresh prices a model that had none, the
   projections that store estimates (`spend` and `ticket_report`, 0123) are
   rebuilt, and every row is priced again by its own day. A price that only
   changes, for a model already priced, rebuilds nothing.

   **Accepted exception: a same-day replacement.** A second fetch on the same
   UTC day replaces that day's row (`mergeSnapshot`,
   `packages/domain/src/rate-card.ts:231`), which happens only when a conductor
   restarts on a day the upstream price changed. Rows already folded keep the
   earlier estimate, and a rebuild would give the later one. Nothing is
   rebuilt for it: an estimate is not a bill, and a full rebuild for this
   case is not worth its time (0123 §6).

6. **The rate card is a file that a person appends to.** `doc/rate-card.md`
   holds one row per (model, mode, `from` date), with input, output, cache-read
   and cache-write rates per million tokens. Reasoning output is charged at the
   output rate. A price change adds a new row and never edits an old one, so an
   old run still prices at the rate in force when it happened. A model with no
   row is _unpriced_, and its runs are unknown under decision 7. Codex has no
   rows today. The card is not fetched from the Models API, which carries no
   price, and is not scraped from a pricing page. Rows not in the shipped card
   may come from a fetched, dated snapshot, read after the shipped rows and
   never fetched while pricing.

7. **`/spend` shows the `spend` projection, split by purpose.**
   `apps/board/src/app/spend/page.tsx` shows one row per project, with the
   purposes read off `for` and never folded together, each total kept apart by
   the rule below. The recipe limits that authorised the spend are shown beneath
   the bill.

   **A reader shows a reported dollar as fact, an estimate as an estimate, and
   an unknown as unknown, never as $0.** Where `costUsd` was reported, that is
   the figure. Where it was not, but the tokens were and the rate card has a
   row for the model and mode in force at `at`, the figure is priced from the
   tokens and marked as an estimate. Where neither holds, the run's cost is
   unknown, and is shown as unknown. **A total keeps the three apart: the
   reported total, the estimates listed beside it and never added into it, and
   a count of unknown runs.** The board, `lingtai status` and any report read
   the stored `cost_usd` and `estimated_usd` and sum them; none prices at
   display time.

8. **`RunSpent` is appended to the stream its run belongs to, and carries no
   ticket id.** A run inside a pass (implement, a fix round, the reviewer, the
   designer, the judge) is on the pass stream, whose `RunStarted` names its
   ticket once. Triage is on the ticket stream. A discussion is on its
   `chat-…` stream, whose `DiscussionRequested` names its ticket. There is no
   transaction id: the stream already says whose history the run belongs to.

9. **`for` says what the run was for**, as a tagged union:

   ```ts
   type SpentFor =
     | { _tag: 'Action'; step: Step; name: string; round: number } // a recipe action: implement, a fix round, the reviewer, the designer
     | { _tag: 'Judge'; when: JudgeWhen } // the judge at proposed
     | { _tag: 'Triage'; waitId: WaitId }
     | { _tag: 'Discussion' }
   ```

   An action's spend is the `RunSpent` on its pass stream with the same
   `step`, `name` and `round`, so an action carries no reference to its spend
   and there is no call id: `step`, `name` and `round` find it, which holds
   while an action's `name` is unique within its step. A wait that a ceiling
   stopped finds its run's spend the same way, through its `run`.

   **A declared `name` may not contain `:`** (`#503`): `run.steps` and
   `task_view` key an action by this same `step`/`name` pair, and the
   conductor appends its own signoff — `conductor:judge`/`conductor:unfixed`
   — into that key space after the stopping step's own `StepEnded`. `:` is
   reserved so `conductor:` is a namespace a declared name can never collide
   with; the recipe validator refuses any declared name that contains one.

10. **The six paid calls** are every place that calls `Runtime.run`:

    | Run               | Where                                                            | `for`                 |
    | ----------------- | ---------------------------------------------------------------- | --------------------- |
    | implement         | `packages/conductor/src/conduct.ts`, the dispatch at `implement` | `Action`              |
    | a fix round       | `conduct.ts`, the round dispatch                                 | `Action`, `round` ≥ 1 |
    | the judge         | `conduct.ts`, `askTheAgent`                                      | `Judge`               |
    | the cold reviewer | `packages/actions/src/agent-action.ts`, the review dispatch      | `Action`              |
    | the designer      | `agent-action.ts`, the design dispatch                           | `Action`              |
    | a discussion      | `apps/cli/src/discuss.ts`, `discussionAsk`                       | `Discussion`          |

    Triage has no dispatch yet; when it has one, it is the seventh and appends
    `RunSpent { for: Triage }`. A new place that starts a paid process appends
    `RunSpent` and changes no other event.

11. **The `spend` projection holds one row per `RunSpent`**: `seq`, `at`,
    `ticket`, `pass` (null off a pass stream), `for` with its `step`, `action`
    and `round`, `runtime`, `turns`, `duration_ms`, `cost_usd` and `usage`
    (jsonb), the estimate of decision 5 (`estimated_usd` and
    `estimate_fetched`), and `kind`, the ticket's kind as its run's claim
    carried it when the row was folded (0123 §3). The fold fills `ticket` from the pass stream's `RunStarted`, the
    ticket stream itself, or the discussion's `DiscussionRequested`, each of
    which it has read by then. A card's total, `/spend`'s rows and the task
    page's list of calls are all queries over it. It is a row per run, not a
    total per ticket, because an estimate (decision 5) needs each run's model,
    tokens and time, and because spend per day is a query over it.

12. **Ceilings are the runtime's, and read nothing on the log.**
    `runtime.limits.usd` bounds one run and is enforced by the runtime
    (`--max-budget-usd`) on its own count, as `turns` and `wall` are. Lingtai
    enforces no dollar ceiling per pass or per ticket. Its one ceiling of its own
    is the daily one, which pauses taking new work and kills nothing
    ([0122](0122-several-passes-share-one-conductor.md) §5).

13. **No event but `RunSpent` carries spend.** The old fields — `turns`,
    `costUsd` and `usage` on `RunFinished`, `DiscussionAnswered` and
    `DiscussionHeld`, and `task_view`'s `cost_usd` and `repair_costs` — were
    written beside `RunSpent` only until the reset that changed the stored
    events ([0120](0120-a-reason-is-a-type.md)'s phase 2, #502), and are gone
    with it (#506 dropped the columns). `TriageAgent` never carried them: a
    triage agent's cost is a `RunSpent` and nothing else
    ([0118](0118-a-hold-explains-itself.md) §3). The `spend` fold reads
    `RunSpent` and no other event, and the card, `/spend` and the task page
    all read `spend`. What the old fields recorded before the reset is not
    carried into `spend`: the reset forgot it with the rest of the log.

## Consequences

- Somebody has to keep the rate card current. A stale row reports a confident
  wrong number, while a missing row reports nothing, so leaving a row absent is
  the safer failure.
- Every estimate from the rate card is an estimate. The provider's own billing
  (for Claude, the Admin API's usage and cost reports) is the authority, and
  reconciling against it is a separate question.
- Spend on the log undercounts by exactly the runs that were killed, and those
  are the long ones. A total is a floor, and the page says so.
- A judge's spend is a `RunSpent` like any other. The judge still has no event
  for its decision of its own: that is `PassRouted`.
- There are four projections to rebuild: `task_view`, `finding_backlog`,
  `spend` and `ticket_report` (0123).
- A Lingtai-enforced dollar ceiling reads `spend`'s stored figures: the daily
  one (0122 §5) and a per-ticket one if it is added (#674).
- A refresh that prices a new model costs a rebuild of every projection that
  stores an estimate. That is rare: once per model, on the first day it is
  fetched.

## Not built yet

- **Decision 5's stored estimate.** `spend` stores `cost_usd` only, and
  `apps/board/src/lib/spend.ts` and `packages/conductor/src/day-ceiling.ts`
  still price at read time; the rebuild on a newly priced model is not wired.

- **`Action.call` and `CallId` still exist** in `packages/domain/src/action.ts`
  and `wait.ts`, unset.
- **The rate card names one Codex model, `gpt-5.6-sol`.** `priceRow`
  (`@lingtai/domain/rate-card`) prices a null-`costUsd` run from the card at read
  time; a Codex run on any other model, or with none recorded, is unknown, under
  decision 7, until a person appends its row.

---

_Replaces archived 0073, 0075 in [decisions-archive](../decisions-archive/)._
