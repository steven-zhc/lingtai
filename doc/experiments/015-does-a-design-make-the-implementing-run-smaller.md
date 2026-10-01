# 015 — Does a design make the implementing run smaller?

**Set up** 2026-09-29 · **Run** not yet · **Result** none — and **it has no
numbers on purpose**, for [014](014-the-log-before-the-fourth-reset.md)'s reason:
the agent that wrote this can reach neither the conducting machine's recipe nor
the log. What it carries instead is the block to declare, the queries that answer
the question afterwards, the rule for reading them, and two things about turning
`design:` on here that only came out of reading the code.

## Why

[0066](../decisions-archive/0066-a-large-answer-is-a-locator-on-the-log.md) §2 is a
thesis and not a claim: *a design that is real work is what makes the implementing
agent's job smaller, and a smaller job can be done by a smaller model.* Everything
built for it — the locator, `file:`, `file-brief:`, the boundary
([0069](../decisions-archive/0069-both-the-document-and-the-locator-cross-the-step-boundary.md))
— is untested against real tickets, because **no recipe has ever declared
`design:`**. `design`'s default is deliberately nothing (0065 §4), so the step has
never run.

The measurement is cheap because the baseline already exists. `implement`, on the
three tickets that hit the turns ceiling on 2026-09-27/28:

| | turns | cost |
|---|---|---|
| `#269` attempt 1 | 151 — the wall | $26.06 |
| `#265` attempt 1 | 151 — the wall | $20.48 |
| `#266` attempt 1 | 151 — the wall | $23.66 |
| a pass from an existing branch | 24 | $1.78 |

At ~$0.10 a turn ([012](012-where-the-turns-go.md) §2) the design has to save
about twenty turns to pay for itself, and a drafter costs turns of its own.

## 1. The block

This goes under `steps:` in **`~/.lingtai/lingtai/recipe.yml`** — the conducting
machine's file (0046 §3). Not `.lingtai/config.yaml`: nothing reads the
repository's copy to run anything, so a block merged there turns nothing on and
says nothing.

```yaml
  design:
    - name: shape it
      agent: claude-code
      prompt: |
        Cite `file.ts:line` for every claim about what the code does today, and
        quote the comment or the ADR that makes it. A shape argued from memory of
        this codebase is the one thing the implementing agent cannot check.

        Behaviour here is settled by the log, and you cannot read it. Where the
        shape turns on what actually happened, name the event and the field that
        would settle it rather than asserting the behaviour.

        `pnpm test` is what the `build` step runs. The integration half takes 803
        seconds and is out of reach inside a pass, so a shape whose only check is
        `pnpm test:integration` is one nothing can verify before the merge — say
        so where that is the shape, and name the unit-level claim that stands in.

        If the shape contradicts an accepted ADR, name it and say the answer is a
        superseding file rather than an edit. The decisions are append-only.
    - name: keep the note
      file: doc/design/this-change.md
```

Two entries, and the order is the contract: `file:` keeps what an earlier entry
at the same step made, so one written first is refused when the recipe resolves
(`plugin.test.ts`'s *refuses a `file:` written first, because it would keep
nothing*).

**`prompt:` is only the project's half.** `buildDesignPrompt`
(`packages/actions/src/agent-action.ts:626`) already tells the drafter what the
step is for, that answering with nothing is a real answer and the common one, how
to ask a question, and not to edit the worktree. What is written above arrives as
a trailing `## Also for this project` section, so anything here that restated the
built-in would be paid for twice in one context window.

**`file-brief:` at `implement` is deliberately not in this block.** The document
reaches `implement` either way — both it and the locator cross the boundary (0069
§2) and the built-in dispatch renders the document — so the brief buys only
*reading it back off the branch instead of from the copy the pass carries*. It is
a second thing to get wrong in the change whose whole purpose is one number, and
declaring it would also force an explicit `agent:` at `implement`, because a
`file-brief:` written last in a step's list is refused. Add it after there is a
number, not before.

**That is a rule for the fortnight and not advice.** While this is running,
`design:` is the only block that changes on the machine's file: two changes at
once and the number attributes the saving to whichever of them it likes. Nothing
in this repository can check that — the machine's file is outside every worktree
(0046 §3) — so what a test can hold is the other half, that the block *published
here* declares `design` and no other step.

The block is pinned by `packages/recipe/unit/the-design-block.test.ts`, which
reads this file, splices the block into this repository's own recipe and puts it
through **`resolveSource`** — the half of the resolve that does not care where
the text came from (`packages/recipe/src/resolve.ts:207`), and the half that
holds every refusal a mispasted block would earn: a plugin at a step it does not
serve, a field it does not understand, a path that leaves the worktree. That is
the *Watch out* on `#302` made mechanical: a block that no longer resolves is a
red test here rather than a refusal on the live queue.

**Two things that resolve is not.** It is not `resolveRecipe`, which reads
`.lingtai/config.yaml` at a ref and then calls `resolveSource` with what it found
(`resolve.ts:190`) — there is no file at a ref in this test. And it is not
`resolveLocalRecipe`, which is the path the daemon actually takes for the
machine's file and passes `resolveSource` a fourth argument: a `shape` callback
that refuses `runtime.agent`, `runtime.limits` and `runtime.assignee` by name and
injects the machine's own in their place (`packages/recipe/src/local.ts:398`).
Neither is exercised here. What keeps the pin worth something anyway is that the
block declares no `runtime:` key at all, so the shape has nothing of the block's
to refuse — a block that grew one would resolve here and be refused on the
machine, and that is the gap to hold this file to.

## 2. Restart before pasting, and not after

`file:` and `file-brief:` landed on `main` on 2026-09-29. **A running daemon holds
the code it started with** — Node caches a module at import, and a plugin's `at`
is a module constant the daemon loaded at start — so a daemon started before those
commits does not serve either key, and *a recipe naming a plugin at a step its
copy does not serve is refused every pass*. `conduct.ts` then answers
`stage: "recipe"` for every ticket and the daemon takes nothing at all.

So the order is:

    pnpm lingtai restart "picking up file: for #302"     # first
    # then paste the block

and `lingtai add` prints what `design:` says afterwards. This is
[doc/design/the-plugin-body.md](../design/the-plugin-body.md)'s *code, restart,
paste* and it is the one sequencing mistake that costs the whole fortnight rather
than one pass.

What it costs if it is got wrong is 0066 §6's **correction**, not §6's first
paragraph: a configuration error that survives to run time is *not* retried
hourly. The pass ends `blocked`, `task_view` folds it to `waiting`, and
`selectRunnable` drops the row before it consults the backoff — one claim, one
worktree, one paid agent, and then a stop. A refusal at resolve costs nothing at
all.

## 3. What the log will carry, and the one thing that is not a field

| what | where | shape |
|---|---|---|
| this pass had a design | `StepPassed` with `step: "design"` | a row, per action — `stepBase` carries `step`, `action`, `runId`, `onSha` |
| the document | the drafter's `StepPassed.evidence` | the text, clipped to 60 lines / 8,000 bytes since 0066 §8 |
| the design's turns and cost | the drafter's `StepPassed.evidence` | **prose**: a trailing `(12 turns · $0.38)`, `agent-action.ts:977` |
| the locator | the keep's `StepPassed.evidence` | prose: `` wrote a 2.4 kB design to `doc/design/this-change.md`, committed to the branch ``, `file-action.ts:181` |
| `implement`'s turns and cost | `RunFinished` | **numbers**: `turns`, `costUsd`, `exitCode`, `durationMs` |
| each fix round's turns and cost | `FixApplied` | numbers, and it carries `runId` |
| which recipe the run got | `RunStarted.configHash`, `StepsResolved.recipe` | the hash, so *with* and *without* need not be inferred |
| the design asked instead | `StepAsked` at `design` | the question on `detail`, no `because` (0068) |

**`implement`'s numbers are fields and the design's own are a sentence**, and that
asymmetry is the thing to know before writing a query. `RunFinished` is the
implementing run's receipt with `turns` and `costUsd` typed; an `agent:` action
anywhere else splices its receipt into `evidence` as text. So *what did the design
cost* is a regular expression over a string, and the hazard is the opposite of the
one it looks like.

**The receipt cannot be clipped off.** `boundedEvidence` calls `tail`
(`packages/actions/src/command.ts:214`), which returns the head, a line counting
what was elided, and *the end* (`command.ts:156-175`) — the last line, which is
the receipt, is always inside the end, and in the one shape where even a head does
not fit it returns the end alone. **What bites is the first match.** The kept head
is the design document, and a regular expression that takes the first
`(N turns` in that string reads the document rather than the receipt: a design
about this repository's own turn budgets that writes `(151 turns at the wall)` or
`$26.06)` — §Why's very figures — answers `design_turns = 151` for a drafter that
spent twelve, and the row looks like a reading rather than a parse error. §4 takes
the **last** match and requires the receipt's exact `· $` shape for that reason.

`#302` asks for the comparison of `implement`, which is entirely in fields; the
drafter's side of the ledger is the parse.

`RunFinished` carries **no `runId`** — the run stream is the run, `run-{ulid}`, so
the join is `stream_id`. And the trap 012 already paid for: **`WorkItemLanded`
carries no `runId` either**, so a query that joins a landing to a run by that
field reads zero for every bucket and the absence looks like evidence.

## 4. The queries

`events(seq, stream_id, type, data jsonb, schema_ver, version)`. Runs that had a
design, with what `implement` then spent:

```sql
-- one row per run: which arm it is in, and what the implementer cost
select r.stream_id,
       (r.data->>'workItemId')            as work_item,
       (f.data->>'turns')::int            as implement_turns,
       (f.data->>'costUsd')::numeric      as implement_usd,
       case when d.data is null then 'without'
            -- `agent-action.ts:975`, verbatim: the drafter's answer when it
            -- answered nothing. Non-null, and no design at `implement`.
            when d.data->>'evidence' like 'no design: this change needs none%' then 'without'
            else 'with' end               as arm,
       d.data->>'evidence'                as design_evidence
from events r
-- Lateral, and not a join on the step alone. `StepPassed` is one row **per
-- action** (`action.ts:722`; `stepBase.step` is the step, `events.ts:641`), so
-- the two-entry block leaves two rows at `design` and a join that names only the
-- step returns every designed run twice — double-weighting the *with* arm, with
-- the keep's locator sentence on one of the two halves. `'shape it'` is the
-- drafter's `name:` in §1's block. `order by seq desc` is the second reason: a
-- judge may send `design` back to itself (0058 §3c), and then the last draft is
-- the one `implement` was given.
left join lateral (
  select d.data
  from events d
  where d.stream_id = r.stream_id and d.type = 'StepPassed'
    and d.data->>'step' = 'design' and d.data->>'action' = 'shape it'
  order by d.seq desc limit 1
) d on true
left join events f
       on f.stream_id = r.stream_id and f.type = 'RunFinished'
where r.type = 'RunStarted'
order by r.seq;
```

**`design_evidence is null` is not the *without* arm**, which is the one way to
get this wrong and have the output look right. A drafter that took the built-in
prompt's stated common answer — *answering with nothing is a real answer, and it
is the common one* (`agent-action.ts:626`) — appends `StepPassed` with `evidence`
= `no design: this change needs none` and its receipt (`agent-action.ts:975`),
and the keep appends *nothing to keep at `doc/design/this-change.md` — the design
step answered that none was needed* for the same run (`file-action.ts:163`). Both
are non-null. And `StepPassed` is `{...stepBase, evidence, findings}`
(`packages/domain/src/events.ts:812`), so zod strips the `document` key
`action.ts:698` only ever puts on the in-memory result: **nothing on the event
distinguishes an empty design from a real one except that prose**, which is why
the arm is a column here rather than a rule a reader applies. Counting those runs
as designed dilutes the answer toward *no* with nothing in the output to show it.

The design's own turns come out of that column:

```sql
-- the design's own receipt: the **last** match, and the receipt's exact shape.
-- `substring(... from '\((\d+) turns')` takes the *first* match in a string
-- whose kept head is the document, so a design that discusses turn counts
-- answers with the number it was discussing (§3). Group 3 is null where the
-- runtime reported no cost (`agent-action.ts:901`).
select e.stream_id,
       m.receipt[1]::int     as design_turns,
       m.receipt[3]::numeric as design_usd
from events e
cross join lateral (
  select receipt
  from regexp_matches(e.data->>'evidence', '\((\d+) turns( · \$([0-9.]+))?\)', 'g')
       with ordinality as t(receipt, n)
  order by n desc limit 1
) m
where e.type = 'StepPassed' and e.data->>'step' = 'design'
  and e.data->>'action' = 'shape it';
```

And the pass total rather than the implementer alone, since a design that halves
`implement` and doubles the fix loop has saved nothing:

```sql
select stream_id,
       sum((data->>'turns')::int)       as turns,
       sum((data->>'costUsd')::numeric) as usd
from events
where type in ('RunFinished', 'FixApplied')
group by stream_id;
```

## 5. How to read it

`#302`'s own rule, and it is worth keeping because it was written before the data:

- three consecutive tickets that do what `#269`, `#265` and `#266` did — **151
  turns, at the wall** — mean the design is not earning its money at this size of
  change
- landing in **60–90 turns** means it is

**Three runs in the `with` arm**, and a run whose drafter answered nothing is not
one of them however many turns it spent: `implement` had no design in front of it,
so it says nothing about a design's worth and belongs beside the baseline. How
often that answer came back is its own number and worth reporting beside the
comparison rather than inside it — if the drafter answers *this needs none* on
most tickets, that is the finding.

Three tickets is the floor and not a sample. The arms differ in more than the
design — the tickets are different work — so what this can answer is *did the
ceiling stop being where these runs end*, which is the question the epic was
opened on. It cannot separate the design's contribution from the ticket's size,
and a result near the middle is a reason to keep measuring rather than a number.

**And the answer may be no.** A design that does not make the implementing run
smaller is worth as much as one that does, because the next ticket in the line —
a cheaper model at `implement` — is bought entirely on this.

## 6. Two things reading the code found

**The path is a literal and every ticket writes to the same one.** `file:` is a
plain string handed through as `path: action.file` (`from-recipe.ts:245`); nothing
interpolates the issue number. So pass after pass writes `doc/design/this-change.md`
and each merge overwrites the last note there. On a branch that reads correctly —
it is the note for this change — and on `main` it means *the last change that
carried one*. The locator on `#302`'s event still names that path after `#310`
lands, and following it then opens `#310`'s design. Git history has both and the
locator distinguishes neither, which is half of what 0066 §3 bought a locator
for. A templated path is a separate ticket against `filePlugin`; nothing here
needs one to get a number.

> Since `#310` a `file:` path takes `{{issue}}`, expanded when the action runs,
> so `doc/design/{{issue}}.md` gives each pass its own note. **This experiment's
> own recipe is unchanged by that landing** — the value on the conducting
> machine's file is still the literal, a path with no placeholder takes the same
> route and comes out identical, and §4's rule is that `design:` is the only
> block that moves while this runs. Whether to point it at `{{issue}}` before
> the fortnight is out is the owner's call; changing the path changes neither
> whether a design is made nor what it costs.

**The note is in the diff `review` reads, and that is not free.** The keep commits
(`file.md`, **Parameters** — there is no field for the other answer, because an
uncommitted note does not survive the worktree's removal), so the cold reviewer
at `review:` sees the design note in every diff it judges, and by §6 above it sees
it as a full-file rewrite each time. `review` refuses about three times for every
acceptance and feeds the whole fix loop (012 §4), so a design note is a new thing
for it to have an opinion about in exactly the place this repository's turns
already go. Whether that shows up is a fact the fortnight will produce and this
file will not guess at.

## What this does not ask

- **Whether `implement` can be a cheaper model.** The thing the whole line of work
  is for, and `runtime.limits` and `runtime.agent` are per-pass rather than
  per-step, so it needs that to move first. Open it when this has a number.
- **Whether `file-brief:` changes the answer.** §1 says why it is out of the
  block. It could only matter where the carried document and the kept one differ,
  and 0069 §4 says the document wins.
- **Whether the design is any good.** Turns and cost are what the log holds. *Did
  the implementing agent follow it* is a reading of six documents and not a query.

## Related

- [0066](../decisions-archive/0066-a-large-answer-is-a-locator-on-the-log.md) §2 — the
  thesis and the baseline table; §6 and §7 for what a misconfiguration costs, as
  corrected.
- [0069](../decisions-archive/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
  §2 — both the document and the locator cross to `implement`, which is why §1's
  block needs nothing at that step.
- [plugins/file.md](../plugins/file.md) — the key, its one field, and why the note
  is committed.
- [012](012-where-the-turns-go.md) — the turns this is measured against: ~$0.10 a
  turn, half of everything in the fix loop, `review` feeding all of it. §2's rate
  is what makes twenty turns the break-even.
- [014](014-the-log-before-the-fourth-reset.md) — the precedent for an experiment
  with queries and no numbers, written by an agent that could not reach the log.
