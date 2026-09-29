# 015 — Does a design make the implementing run smaller?

**Set up** 2026-09-29 · **Run** not yet · **Result** none — and **it has no
numbers on purpose**, for [014](014-the-log-before-the-fourth-reset.md)'s reason:
the agent that wrote this can reach neither the conducting machine's recipe nor
the log. What it carries instead is the block to declare, the queries that answer
the question afterwards, the rule for reading them, and two things about turning
`design:` on here that only came out of reading the code.

## Why

[0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §2 is a
thesis and not a claim: *a design that is real work is what makes the implementing
agent's job smaller, and a smaller job can be done by a smaller model.* Everything
built for it — the locator, `file:`, `file-brief:`, the boundary
([0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md))
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

The block is pinned by `packages/recipe/unit/the-design-block.test.ts`, which
reads this file, splices the block into this repository's own recipe and resolves
it with the real `resolveRecipe`. That is the *Watch out* on `#302` made
mechanical: a block that no longer resolves is a red test here rather than a
refusal on the live queue.

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
cost* is a regular expression over a string, and a design whose evidence was
clipped at the bound could in principle lose its own tail. `#302` asks for the
comparison of `implement`, which is entirely in fields; the drafter's side of the
ledger is the parse.

`RunFinished` carries **no `runId`** — the run stream is the run, `run-{ulid}`, so
the join is `stream_id`. And the trap 012 already paid for: **`WorkItemLanded`
carries no `runId` either**, so a query that joins a landing to a run by that
field reads zero for every bucket and the absence looks like evidence.

## 4. The queries

`events(seq, stream_id, type, data jsonb, schema_ver, version)`. Runs that had a
design, with what `implement` then spent:

```sql
-- one row per run: did it draft, and what did the implementer cost
select r.stream_id,
       (r.data->>'workItemId')            as work_item,
       (d.data->>'action')                as drafter,
       (f.data->>'turns')::int            as implement_turns,
       (f.data->>'costUsd')::numeric      as implement_usd,
       d.data->>'evidence'                as design_evidence
from events r
left join events d
       on d.stream_id = r.stream_id and d.type = 'StepPassed'
      and d.data->>'step' = 'design'
left join events f
       on f.stream_id = r.stream_id and f.type = 'RunFinished'
where r.type = 'RunStarted'
order by r.seq;
```

`design_evidence is null` is the *without* arm and every run before the block was
pasted is in it. The design's own turns come out of that column:

```sql
select substring(data->>'evidence' from '\((\d+) turns') ::int as design_turns,
       substring(data->>'evidence' from '\$([0-9.]+)\)')::numeric as design_usd
from events
where type = 'StepPassed' and data->>'step' = 'design';
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

- [0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §2 — the
  thesis and the baseline table; §6 and §7 for what a misconfiguration costs, as
  corrected.
- [0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
  §2 — both the document and the locator cross to `implement`, which is why §1's
  block needs nothing at that step.
- [plugins/file.md](../plugins/file.md) — the key, its one field, and why the note
  is committed.
- [012](012-where-the-turns-go.md) — the turns this is measured against: ~$0.10 a
  turn, half of everything in the fix loop, `review` feeding all of it. §2's rate
  is what makes twenty turns the break-even.
- [014](014-the-log-before-the-fourth-reset.md) — the precedent for an experiment
  with queries and no numbers, written by an agent that could not reach the log.
