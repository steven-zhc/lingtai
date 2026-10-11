# 0110 — Cost and tokens: a paid call records its tokens on the event it ends on, and money is computed only where it is displayed

**Status** accepted · 2026-10-01

Every paid call records what it consumed on the event that call ends on. That
record has two parts: the dollars the runtime itself reported (`costUsd`), and
the token counts, kept separately rather than summed, together with the model
and mode needed to price them. Every field is optional. An absent field means
_this runtime did not say_, never zero. Lingtai never computes money on the way
into the log and never computes it inside a fold. Money is computed where it is
displayed, from the event's own counts and occurrence time, using
[`doc/rate-card.md`](../rate-card.md), a dated table that a person appends to.

## Context

One pass may dispatch two runtimes, and only Claude Code reports dollars. Codex
reports token usage and no price. A step with no recorded spend shows on the
board as costing nothing, which reports unknown cost as free. A single summed
token count also cannot be priced: cache reads cost about 0.1× fresh input and
cache writes about 1.25×, so one sum spans a 12× range. One model id can also
carry more than one price (Claude Opus 5 has a standard rate and a fast mode).
The run log is deleted when a ticket lands, so a number that only reaches the
run log is gone by the time anyone asks what the work cost.

## Decision

1. **`costUsd` is a statement the runtime made, and null means it made none.**
   `RunFinished`, `FixApplied`, `DiscussionAnswered`, `DiscussionHeld` and
   `HoldTriaged` ([0118](0118-a-hold-explains-itself.md) §3) in
   `packages/domain/src/events.ts` carry `costUsd: number | null`. Claude Code
   fills it from its receipt. Codex always records `null`, never `0`.

2. **A paid call records its spend on the event it ends on.** For the
   implementer that event is `RunFinished`, for the fixer `FixApplied`, and for
   a discussion `DiscussionAnswered` and `DiscussionHeld`, and for triage
   `HoldTriaged`, whether it advised or failed. For a reviewer or a
   design agent it is the step event it ends on: `StepPassed`, `StepFailed`,
   `StepDidNotFinish` or `StepNeverRan`. A runtime judge's spend goes on an
   event, never only on a run-log line. `ActionResult`
   (`packages/actions/src/action.ts`) carries the spend so the conductor can
   append it. Spend is a structured field on the event and is never
   interpolated into `evidence` prose.

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
   echoed back. Entries merge by `(model, mode)` when tokens from two turns or
   two rounds are added together (`addUsage`); a differently-keyed entry is a
   second line in the bill, not a second count of the same one. `mode` names a
   premium speed at the same model id, where a runtime has one. Events take
   one array rather than loose fields, because nobody writes events by hand.

4. **Every field is optional, and none defaults to zero.** A `.default(0)`
   anywhere in these groups would report unknown cost as free. Optional also
   keeps widened event types safe: a constructor that misses the field still
   compiles and still parses, and the event reads as _not said_.

5. **Money is never stored, and never computed in a fold.** A reducer may read
   the event and nothing else: no clock, no network, no rate table. If a fold
   priced tokens, `lingtai projection rebuild` would silently disagree with the
   live fold the day a price changed, or the day a row was added for a model
   that had none. A projection may carry the facts, `costUsd` and `usage`, as
   columns; it never carries a price computed from them. The board, `lingtai status` and any
   report may each price tokens at display time, from the event's counts and
   its occurrence time.

6. **The rate card is a file that a person appends to.** `doc/rate-card.md`
   holds one row per (model, mode, `from` date), with input, output, cache-read
   and cache-write rates per million tokens. Reasoning output is charged at the
   output rate. A price change adds a new row and never edits an old one, so an
   old event still prices at the rate in force when it happened. A model with no
   row is _unpriced_, and that is what the reader is shown. Codex has no rows
   today. The card is not fetched from the Models API, which carries no price,
   and is not scraped from a pricing page.

7. **`/spend` shows reported dollars, split by purpose.** `apps/board/src/app/spend/page.tsx`
   shows one row per project for the cards currently on the board. _Work_, _Answering_ (repair spend) and _Triage_ (0118's advice on a
   hold) are separate columns and are never folded together. The recipe limits that authorised the spend are shown beneath the
   bill. The totals come from `ledger` in `apps/board/src/lib/board.ts`.

## Consequences

- Somebody has to keep the rate card current. A stale row reports a confident
  wrong number, while a missing row reports nothing, so leaving a row absent is
  the safer failure.
- Every estimate from the rate card is an estimate. The provider's own billing
  (for Claude, the Admin API's usage and cost reports) is the authority, and
  reconciling against it is a separate question.
- Adding the groups widens several event schemas and a type that four kinds of
  action construct. This is cheap only because every field is optional.

## Not built yet

- **Reviewer and judge spend is not on an event.** `ActionResult` has no spend
  field. The cold reviewer's turns and dollars appear only inside `evidence`
  prose (`packages/actions/src/agent-action.ts`), and a judge's spend appears
  only in the run log. The step events carry no spend. (#324)
- **Nothing reads the rate card.** No code prices tokens, so a Codex step
  shows no cost. `ledger` adds a null `costUsd` as 0 in its totals, and does not
  show it as unknown. (#208)

---

_Replaces archived 0073, 0075 in [decisions-archive](../decisions-archive/)._
