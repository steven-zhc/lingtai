# 0073 — Tokens go on the event and money never does, and the rate card is a file a person edits

**Status** accepted · **Date** 2026-09-29 · **Decides** what a paid call records
about what it consumed, now that a pass may dispatch two runtimes and only one of
them reports dollars · **Depends on**
[0070](0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md) §3, the
group a paid plugin embeds, which is why *which model* is now a per-step fact
worth recording · **Leaves `costUsd` alone** — where a runtime reports dollars
that number stays on the event exactly as it is, because it is a statement the
runtime made

## 1. The number that is not on the board

`review` runs on Codex in this repository since 2026-09-29, one step after
[#314](https://github.com/steven-zhc/lingtai/issues/314) made a step's `agent:`
dispatched rather than refused. The recipe's own comment at that step names the
cost of the move — *"So this step's dollars leave the accounting"* — and
understates it. Nothing about that step's spend reaches the log at all.

`packages/agent/src/codex.ts:300` is the whole of what Codex records:

```ts
receipt.billedTokens = (event.usage?.input_tokens ?? 0) + (event.usage?.output_tokens ?? 0);
```

Three things are wrong with that line and the third is the one that matters.

It **sums** two of the five numbers the stream carries (`:167-172`:
`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`,
`output_tokens`, `reasoning_output_tokens`), discarding three. It **assigns**
rather than accumulates, inside the `turn.completed` branch — and `turns` is
counted off that same stream (`:118`, *"Counting turns off the stream is not
enforcing them"*), so a run has many and each overwrites the last; the field's
own docblock says *"off the **last** `turn.completed`"*. And it **reaches
nothing**: `billedTokens` appears in `codex.ts` and `codex.test.ts` and in no
third file. Not an event, not a projection, not the board, not `lingtai status`.
The test says so in its own words — *"`turns` is the spend leg and
`billedTokens` cannot be"*.

So the first pass with a Codex reviewer produces a board on which that reviewer
cost nothing, beside a `$22.56` implementer. That is
[#198](https://github.com/steven-zhc/lingtai/issues/198)'s bug — unknown cost
reported as free — reappearing not as a `0` but as an absence.

## 2. A sum cannot be priced, and the rates say by how much

Cache reads cost about **a tenth** of fresh input and cache writes about
**1.25×**. So one summed token count spans a **12× range** in dollars; the sum is
not a lossy price, it is not a price.

The two fields the sum omits are the largest and the most expensive.
`cached_input_tokens` is the cache hit, and an agent run re-reads the same
repository context every turn, so it is usually most of the input.
`reasoning_output_tokens` bills as output, and this machine's Codex runs at
`model_reasoning_effort = "xhigh"` (`~/.codex/config.toml`), so it is a thick
slice. `billedTokens` therefore undercounts, by an amount it gives no way to
bound.

**And the same model has more than one price.** Claude Opus 5 is \$5/\$25 per
MTok standard and \$10/\$50 in fast mode — one model id, two rate cards. So the
key for pricing is **(model, mode, when)**, and an event recording only the model
cannot be priced either.

## 3. Both runtimes already report the same four things

This is what makes the shape shared rather than a Codex-shaped hole in an event
four other things write to.

| what it is | claude-code | codex |
|---|---|---|
| fresh input, full rate | `input_tokens` | `input_tokens` |
| served from cache, ≈0.1× | `cache_read_input_tokens` | `cached_input_tokens` |
| written to cache, ≈1.25× | `cache_creation_input_tokens` | `cache_write_input_tokens` |
| output | `output_tokens` | `output_tokens` |
| reasoning output | **not reported** — billed as output, not broken out | `reasoning_output_tokens` |

Four of five map one to one, and **both adapters already hold the data and drop
it**. Codex sums it. `claude-code.ts:534` names `modelUsage` as one of the two
things that make the receipt line grow to about four kilobytes — it is in hand
when `parseResult` reads that line, and only `costUsd` is taken out of it.

The fifth row is the asymmetry, and it is the argument for optional rather than
against the shape: absent says *this runtime does not report reasoning
separately*, which is true of claude-code and is not a claim that no reasoning
happened.

## 4. The decision: tokens on the event, optional, and absent is not zero

Two optional groups beside the `costUsd` that is already there, on each of the
four events that carry it — `RunFinished` (`events.ts:563`), `FixApplied`
(`:1219`), `DiscussionAnswered` (`:1765`), `DiscussionHeld` (`:1795`):

- **what was consumed** — the five counts above, each optional, **accumulated
  across turns**, never summed into one;
- **what it takes to price them** — the model as the recipe asked for it, and the
  mode where a runtime has a premium speed at the same model id.

**Every field is optional and absent means *this runtime did not say*.** That is
`costUsd`'s own rule one level down — `codex.ts:24`, *"never `0`, which would
report unknown cost as free"* — and a `.default(0)` anywhere in the group
inverts it. Optional also disarms the hazard a widened shared type usually
carries here: `#89`'s first attempt added a required field and missed a
hand-written literal in a package it never opened. A missed literal in this
group still compiles and still parses, and reads as *not said* — which is what it
is.

**Nested, one key per group, and not spread — deliberately unlike 0070 §3.**
That decision put `model:` and `prompt:` *beside* the plugin's key because 0063
§2 is about the ergonomics of a scalar a person writes in YAML. Nobody writes an
event by hand. So the events take one optional key per group rather than seven
loose fields each, and the group is one fact with one name.

## 5. Money never goes on the event, and never inside a fold

`costUsd` stays because a runtime *said* it: a statement about what happened, of
the same kind as the turn count. **A figure computed from tokens is not that**,
and it must not be stored or folded.

The reason is `lingtai projection rebuild`. A reducer may read the event and
nothing else — no clock, no network, no rate table compiled in — or a rebuild
disagrees with the live fold the day a price changes, **silently**, which is the
failure mode the cold reviewer is told to look for by name. Money is therefore
computed where it is displayed, from the event's own tokens and its own
occurrence time, and never on the way in.

**The rate card is a file a person edits, with dates.** Three candidates were
weighed:

1. **Fetch the published pricing page.** Rejected. The Models API
   (`GET /v1/models`) returns `max_input_tokens`, `max_tokens` and
   `capabilities` and **no price**, so this means scraping a document — a
   dependency that fails silently and puts the network on the path that computes
   money.
2. **The Admin API's usage and cost reports.** Real, and not this. It returns
   the organisation's *actual billing*, which makes it the right instrument for
   reconciliation — but it is raw HTTP with no SDK surface, needs an admin
   credential (`sk-ant-admin…`; an ordinary key is refused), and says nothing
   about Codex.
3. **A dated table in the repository.** Chosen. A price change appends a row
   rather than editing one, so a six-week-old event still prices at the rate that
   was in force, and the answer is reproducible. It is the shape
   `doc/tamper-watch.md` already has — a list a person maintains, which a test
   reads *from that file* rather than from code.

## 6. What it costs

Two optional keys on four event schemas, both adapters taught to keep what they
already parse, and a table somebody has to update when a price moves. The last
one is a standing obligation and is named here rather than discovered: a stale
rate card reports confident wrong numbers, where an absent one reports nothing.
Absent is the safer failure and is what an unpriced model must produce.

## What this does not decide

- **Where the money is displayed.** The board, `lingtai status`, and a report are
  each free to price these tokens or not. This decides only that none of them may
  do it inside a fold.
- **Whether `costUsd` is reconciled against the Admin API.** §5's second
  candidate remains available for exactly that and is not part of this.
- **What a run that reports neither dollars nor tokens should show.** Absent, and
  what a reader is shown for absent is a presentation question.
- **Per-step `tier`.** Unchanged, and still per-pass — 0070 §8.

## Related

- [0070](0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md) §3 — the
  group a paid plugin embeds. It made *which model* a per-step fact; this records
  what that step then consumed, which is why `model` belongs on the event at all.
- [0060](0060-the-gate-runs-unit-tests.md) — the trade written down with its cost
  named rather than argued away. §6 above is the same move.
- [#198](https://github.com/steven-zhc/lingtai/issues/198) — where *unknown cost
  reported as free* was first refused. §1 is that bug wearing an absence instead
  of a zero.
- [#300](https://github.com/steven-zhc/lingtai/issues/300) — the five-dispatch
  pass this is measured against: `implement` 150 turns / \$22.56, `review` 40 /
  \$4.70, the judge 1 / \$0.42. The first Codex review is the row that would be
  blank.
