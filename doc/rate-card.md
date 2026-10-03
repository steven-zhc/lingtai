# The rate card

What a million tokens costs, per model, per mode, with the date the rate came
into force. [0073](decisions-archive/0073-tokens-go-on-the-event-and-money-never-does.md)
§5 decided this is a file a person edits rather than a page something scrapes or
a table compiled into code, and this is that file.

**Nothing computes money on the way in.** An event carries the tokens a runtime
reported and, where the runtime reported it, the dollars it reported — never a
figure derived from one by the other. Money is computed where it is displayed,
from the event's own counts and its own occurrence time, read against the rows
below. A reducer may not read this file: a fold that did would disagree with
`lingtai projection rebuild` the day a price moved, silently, which is 0073 §5's
whole argument.

**Append, never edit.** A price change adds a row with a new `from` date and
leaves the old row standing, so an event from six weeks ago still prices at the
rate that was in force when it happened. Editing a row in place makes history
un-reproducible and is the one thing this file's shape exists to prevent.

**An absent row is the correct answer for an unpriced model, and a stale row is
not.** 0073 §6 names this as a standing obligation: a rate nobody has checked
reports a confident wrong number, where a missing rate reports nothing. So a
model that is not below is *unpriced*, and that is what a reader is shown.

## How the four counts are charged

The five counts on an event
([0073](decisions-archive/0073-tokens-go-on-the-event-and-money-never-does.md) §3) are
charged as four things, and this is the mapping money is computed through:

| count | charged at |
|---|---|
| fresh input | the row's **input** rate |
| served from cache | the row's **cache read** rate |
| written to cache | the row's **cache write** rate |
| output | the row's **output** rate |
| reasoning output | the row's **output** rate — it is output, reported separately by one runtime and not the other |

## Claude — `claude-code`

Per million tokens, US dollars. `mode` is empty for the ordinary rate and names a
premium speed where a runtime has one at the same model id — which Claude Opus 5
does, and which is why 0073 §2 says the pricing key is (model, mode, when) rather
than the model alone.

| from | model | mode | input | output | cache read | cache write |
|---|---|---|---|---|---|---|
| 2026-06-24 | `claude-opus-5` | | 5.00 | 25.00 | 0.50 | 6.25 |
| 2026-06-24 | `claude-opus-5` | fast | 10.00 | 50.00 | 1.00 | 12.50 |
| 2026-06-24 | `claude-sonnet-5` | | 2.00 | 10.00 | 0.20 | 2.50 |
| 2026-06-24 | `claude-haiku-4-5` | | 1.00 | 5.00 | 0.10 | 1.25 |
| 2026-06-24 | `claude-fable-5-1` | | 10.00 | 50.00 | 0.25 | 12.50 |
| 2026-10-03 | `claude-sonnet-5` | cache-1h | 2.00 | 10.00 | 0.20 | 4.00 |

**The 2026-10-03 row is this file noticing itself go stale, and noticing it
was missing a dimension.** `packages/domain/unit/rate-card.test.ts` captured
two real receipts — `claude -p "reply ok" --model claude-sonnet-5
--output-format json`, run twice — and compared `modelUsage.claude-sonnet-5`
against the 2026-06-24 row. The first receipt (`inputTokens:2, outputTokens:19,
cacheReadInputTokens:24352, cacheCreationInputTokens:39338,
costUSD:0.1624164`) priced at $0.1034094 against that row — 36% short of what
was actually billed, all of it the cache-write column. The second (a pure
cache-read turn, `cacheReadInputTokens:63690, cacheCreationInputTokens:0,
costUSD:0.012872`) priced exactly against that row's cache-read rate — it
carries no cache-write tokens at all, so it says nothing about that column
either way; it only confirms input, output and cache read are untouched.

**$4.00 is exactly 2× the $2.00 input rate, and 2× is the published multiplier
for a write to a one-hour cache — not the 1.25× this file derived for the
ordinary five-minute cache, which the 2026-06-24 row's $2.50 already is.** So
the first receipt was not evidence that claude-sonnet-5's general cache-write
rate had moved; it was evidence that *that one call* wrote to a one-hour
cache. Recording $4.00 under the ordinary (empty) mode would have made every
sonnet event from 2026-10-03 onward price at the one-hour rate, including the
five-minute default most calls use — a call shaped like the first receipt but
on the ordinary cache is really billed $0.1034094, not $0.1624164.

So the row above is keyed to the `cache-1h` mode rather than the empty one,
and the 2026-06-24 row still answers every ordinary lookup —
`rateFor(rows, "claude-sonnet-5", "", at)` returns the $2.50 row for any `at`,
2026-10-03 included. Nothing in this codebase tags an event with which cache
TTL it wrote to, so the `cache-1h` row is unreachable until that lands, which
is the correct state for now: unpriced is the honest answer for a regime
nothing can yet name, not a guess. The old row is left standing, as every row
here is.

**The cache columns above are derived, not quoted, except one.** The published
figures are the input and output rates plus the multipliers — cache reads at
about 0.1× input and cache writes at about 1.25× — so `cache read` and
`cache write` here are that arithmetic, and they are the numbers to replace first
when somebody checks this file against the published page. The exception is
`claude-fable-5-1`, whose cache read is quoted directly at 0.25 and is therefore
**not** 0.1× its input rate; a row that assumed the multiplier would be 4× wrong.

**`from` is 2026-06-24 for every row because that is the date of the reference
these came from, not a date anybody verified.** This file was written
2026-09-29, so the rows are three months old on arrival and are the first thing
to check. They are recorded with the date they are true of rather than the date
they were typed, which is what makes that checkable at all.

## Codex — `codex`

**No rows, and that is the honest state.** This machine runs Codex at
`model = "gpt-5.6-sol"` with `model_reasoning_effort = "xhigh"`
(`~/.codex/config.toml`), and no rate for it has been established here. So a
Codex run is **unpriced**: its tokens are on the event and no money is computed
from them.

This is the case 0073 §6 chose absent for. The alternative — a guessed row —
would put a confident number on the board for the one runtime that reports no
dollars of its own, which is the failure
[#198](https://github.com/steven-zhc/lingtai/issues/198) refused, reached by a
longer route.

Note also that Codex reports `reasoning_output_tokens` separately and that this
machine runs it at `xhigh`, so reasoning is expected to be a thick slice of its
output — a row added here without a reasoning-output rate distinct from output,
if the provider charges one, would understate it.

## Not a billing record

Every number computed through this file is an **estimate from token counts**. The
authority on what was actually charged is the provider's own billing — for
Claude, the Admin API's usage and cost reports, which 0073 §5 keeps available for
reconciliation and deliberately does not make this file's job. Where a runtime
reported dollars itself, that figure is on the event and is better evidence than
anything here.
