# 0028 — The backoff is the recipe's: an hour, flat, and only a blind retry waits

**Status** accepted · 2026-09-08 · gives the scheduling backoff the decision
`doc/roadmap.md:135`'s ticked box stood in for; second finding of the audit that
produced [0027](0027-the-lease-is-deleted.md)

## Context

`lingtai status lingtai --all`, before this:

```
#75    tech-debt   lingtai add --base is a second decision about the base  [backing off]
```

**`[backing off]` is a state a person can see and cannot act on.** Nothing said
how long it lasts, what set it, or what ends it. The whole of the answer was one
constant:

```ts
/** Long enough that a failing ticket stops costing money; short enough to retry today. */
export const DEFAULT_BACKOFF_MS = 60 * 60_000;   // queue.ts:17
```

One hour. Searching every document for it:

| where | what it says |
|---|---|
| `doc/roadmap.md:135` | `\| **2c** \| Robustness: attempt backoff, … · **done** \|` — a ticked box in a phase table |
| `doc/decisions/0022-the-seams.md:66` | the **outbox's** backoff, in a list of things deleted |
| `doc/architecture.html:781` | the same deleted outbox |
| `doc/reference.md` | nothing |

So the rule that decides when a failed ticket may be retried — and therefore
when Lingtai spends money again — had no decision, no definition and no entry in
the glossary. Its only mention was a checkbox saying it was built.

## Why it had no home

Same shape as the lease. It is a **policy**, and `reference.md`'s twenty-two
sections are all **enumerations**: event types, stream prefixes, gate points,
doctor checks, tiers, presets. The file counts what kinds of thing exist. It has
no section shaped like a rule, so no policy has ever had a place to live, and
each one has been settled in a constant instead.

Backoff is also invisible until it bites: a ticket in backoff looks exactly like
a ticket nobody has got to yet. That is not a display accident — it is the same
row, in the same column, with the same state.

## Decision

### 1. It is the recipe's — `source.backoff`, a duration, `1h` by default

```yaml
source:
  kinds: [bug, tech-debt, feature]
  backoff: 1h
```

Here rather than compiled into Lingtai for the reason `repair` is
([0025](0025-a-failure-buys-one-agent.md) §2, 0016 §7): how long a failure of
*this* repository's is worth waiting out depends on what its failures usually
are — a flaky dependency that fixes itself, or a ticket that is simply wrong —
and that is a thing the repository knows and the core cannot see. It is written
the way `runtime.limits.wall` is, because it is the same kind of fact.

`RunnableOptions.backoffMs` becomes **required**. It was an optional overriding
a constant, which is exactly the shape that let the hour be a fact of Lingtai's
source that no recipe stated and no output named. Every caller now names it, and
the only value that is not the recipe's is `0`, which is a caller saying *this
one is not blind* — see §3.

It must be **positive**. Zero is not a shorter backoff, it is the absence of the
guard, and the thing a person wants when they reach for it is `lingtai now`. The
schema refuses it by name, so a recipe that tries fails to resolve saying
`source.backoff: must be a positive duration, like 1h` rather than throwing from
the middle of a queue pass.

### 2. Flat. The wait does not grow with attempts

`attempts.ts` counts attempts, so a growing curve was available and is refused.

A growing backoff is a bet that the same failure gets likelier to resolve itself
the longer you leave it. Nothing here supports that bet. What actually changes
between one attempt and the next is not elapsed time but **what the next attempt
is told**: since `#82` a second attempt carries the first's release reason, its
refusing gate and that gate's output. Delaying it further would penalise the one
mechanism that makes a retry worth anything.

And growth is the wrong instrument for the failure it would be aimed at. The
thing worth bounding is *unbounded spend on a ticket that never lands*, and the
bound for that is a **count**, not a curve — a doubling backoff still spends
forever, just on a longer timetable. See "What this does not decide".

### 3. The backoff stops blind retries, and only blind retries

That is the whole of what it is for. A failed run releases its task, a release
is a completion event, and a completion event starts the next pass — so without
the guard the top of the queue is the ticket that just failed, forever, at agent
prices. The old harness re-ran #58 and #59 five times for roughly $29 exactly
that way.

An attempt that is told something the last one was not is not blind, and does
not wait. There are two, and now both behave that way:

- **A repair jumps it.** Already true (`queue.ts`, `row.repairPending`). It is
  told what went wrong, there is at most one per distinct failure, and the
  recipe caps how many an item may buy (0025 §3). Making it wait an hour would
  leave the thing it exists for — an item stuck with no path forward — stuck an
  hour longer, which is the complaint rather than the fix.
- **`lingtai now` jumps it.** This was **not** true, and the way it was untrue
  is the defect below.

### 4. It is said, not only applied

- `describeFilter` gains a `retries` line, so the four places that describe a
  project — `lingtai status`, `lingtai daemon` at startup, `lingtai doctor` and
  the board — all name it, in the recipe's own words.
- `lingtai status` says **when**: `[backing off — runnable in 12m]`.
- A queued card on the board carries `runnableAt`, rendered as a `runnable in
  12m` pill.

The arithmetic is one function, `heldUntil`, beside the subtraction that uses it
— `selectRunnable` filters on it and the two displays read it forwards. The
board does not get to have its own version of the rule.

## The defect this found: `lingtai now` did not mean now

`conduct.ts` decides which hand-made request to honour by intersecting the
control stream's `requested` with the queue:

```ts
const queued = new Set((await selectRunnable({ project: name, offered: offered.runnable, kinds })).map((t) => t.issue));
const asked = control.requested.find((r) => r.project === name && queued.has(r.issue));
```

`selectRunnable` applied the backoff, so **a request for a backing-off ticket
matched nothing**, and both consequences were silent:

1. `asked` was undefined, so the daemon fell through to `runQueue` and ran
   whatever was at the top of the queue instead — the opposite of what the
   command was for, with no output saying so.
2. A request is consumed by the item ceasing to be queued, and nothing had
   claimed it, so the request stayed pending — and would be honoured up to an
   hour later, by a pass the person who typed it had long stopped watching.

The person who types `lingtai now <project> --issue 75` has read the ticket and
is the input the failing attempt lacked. That call passes `backoffMs: 0`. Every
other subtraction still applies: a request for something claimed, blocked or
landed still matches nothing, because those are facts about the log and not
about the clock.

`lingtai run --issue <n>` never consulted the queue at all and is unchanged.

## What this does not decide

**Nothing bounds the number of ordinary attempts.** With a five-minute sweep
(`SWEEP_MS`) and an hour's backoff, a ticket that fails every time costs about
twenty-four agent runs a day, indefinitely. `repair.maxAttempts` caps repairs
and `runQueue`'s in-memory `attempted` set caps one pass; neither caps the
sequence.

That is a real hole and it is a **ceiling**, not a delay — deciding it here by
bending the backoff into a curve would be the same substitution 0003 made when
it settled the lease inside an argument about storage. It wants its own ticket
and its own decision, and this paragraph exists so the next person to feel the
pain does not reach for exponential backoff instead.

## Consequences

- `DEFAULT_BACKOFF_MS` leaves the code. There is no constant to override.
- `Recipe` gains `source.backoff`, so every project's `configHash` changes once,
  as it does whenever the schema gains a key. Nothing is rewritten: the hash is
  of the resolved recipe, and the resolved recipe now states one more thing.
- A recipe can shorten its own backoff, which is the same trust it already has
  over `runtime.limits.wall` and `repair.maxAttempts` — and it is a repository's
  file, read from its base branch and never from the branch an agent is working
  ([0005](0005-config-in-target-repo.md)), so an agent cannot shorten the window
  it is running inside.
- `lingtai status` stops calling a queued row that GitHub is not offering
  `[backing off]`. That row is not waiting on the clock — it was closed by hand,
  relabelled, or excluded — and it now says `[not offered]`, and says nothing at
  all when GitHub could not be asked.
- `reference.md` gains **backoff** as a term, in the first section it has that
  is a rule rather than a count.
