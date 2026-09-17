# 0047 — The recipe a run was given is on the log, and nothing resolves from it

**Status** accepted · 2026-09-16 · **qualifies
[0005](0005-config-in-target-repo.md)**, which it does not supersede

`GatesResolved` carries the canonical recipe the run was resolved against, in
addition to the hash of it that it already carries. It is a record. No code path
reads it to decide anything.

## Context

The log records that a run's gates were decided, and by which recipe:

```ts
// packages/domain/src/events.ts:482
export const GatesResolved = z.object({
  runId: z.string(),
  configHash: z.string(),
  /** Every point, in order, with the ordered action names resolved for it. */
  points: z.array(z.object({ gate: GatePoint, actions: z.array(z.string()) })).length(5),
});
```

So a reader can learn that `proposed` ran `build` and `review`, and that the
recipe was `a48e0a00e9aa`. **They cannot learn what `build` was.** The commands,
the timeouts, the `env` declarations — everything that says what the gate
actually did — are in a file, and the file moves.

It moved on the day this was written: `2d3353b` took `pnpm test:db` out of
`build`. Every run before it got a `build` that ran the database suite; the
recipe at head says it does not. Both are true about different documents.

Today that gap is closable by fetching the recipe at the run's own `baseSha`,
which `RunStarted` records. **[0046 §3](0046-lingtai-is-personal.md) closes that
route**: the recipe moves to `~/.lingtai/<project>/recipe.yml`, out of the
repository, and a past recipe then has no commit to be read at. After that, an
event is the only place the answer can live.

## 1. A record is not a source, and that is the whole of the distinction

`projects.ts:75` refuses a stored recipe, and is right to:

> Read from `origin/<base>` every time rather than from anything stored: a
> snapshot in Lingtai's database would be a second source of truth, and the
> repository's copy is the one its own commits change.

That governs `currentRecipe` — *the function that decides the next run's
gates*. What it forbids is **resolving from a copy**, which drifts, needs
invalidation, and competes with the file for authority.

|  | read to decide | recorded as what happened |
|---|---|---|
| can drift from the file | yes — that is the objection | **no: it is not about the file, it is about a run that is over** |
| needs invalidating | yes | never |
| competes for authority | yes | nothing asks it a question |

**0005 already keeps a snapshot; it keeps only the fingerprint.** Its own §
says so:

> the recipe was already snapshotted, and its hash recorded in `RunStarted`

`baseSha` is stored the same way and nobody calls it a second source of truth,
because nothing resolves from it. This ADR moves one field from *fingerprint* to
*fingerprint and body*, and changes nothing about who decides.

**The rule that keeps it true is a test, not a sentence here**: no code path
outside a view may read the recorded recipe. A conductor that ever resolves from
the log has recreated exactly what `projects.ts:75` refuses, and the comment
above it will still be there claiming otherwise.

## 2. Canonical, not the file

What is recorded is `canonical(recipe)` — the same normalisation `hashRecipe`
already hashes (`recipe/src/resolve.ts:74`): parsed, `undefined` dropped, keys
sorted.

```
.lingtai/config.yaml, as written   29,588 bytes
canonical                           3,598 bytes
```

Two reasons, and the size is the smaller one.

**It is self-verifying.** The body and the hash sit on one event, and the body
is the exact input the hash was taken over — so a reader can check that the
recipe they are being shown is the one the run was decided by, without trusting
the writer. A recorded *file* would need its own second hash to make the same
claim.

**What is lost is real and is accepted.** This repository writes its reasoning
in the recipe's comments — the block explaining why `test:db` left the gate runs
to a screen — and `canonical` discards every one of them. A person reading a
past run's recipe gets what it *did* and not why. The why is in the repository's
history, where it is for a recipe that still lives there, and in nothing at all
once [0046 §3](0046-lingtai-is-personal.md) lands. **Recording the source text as
well was considered and refused**: two representations of one recipe on one
event is two things that can disagree, and the one that can disagree with the
hash is the one a reader would believe.

## 3. Old runs get nothing, and say so

`GatesResolved` goes to v2 and its upcast adds no recipe. This codebase has
already made the argument, for the field beside it:

> Zero, meaning *not recorded*, and it is not guessable: the ceiling is the
> recipe's at the moment of that round, the recipe is read from the base branch
> every pass (0005), and the value it had in September is not the value it has
> now. **Reading today's number back onto a v1 event would be the log claiming a
> bound nobody applied.** — `upcast.ts:163`

The same sentence with *recipe* for *number*. A v1 event is absent, not empty,
and every surface that reads this must carry the *not recorded* branch — which
it must carry anyway, for a run whose stream has no `GatesResolved` at all.

## 4. It holds no secrets, and that is asserted rather than observed

The recipe names environment variables and never holds their values
([0021](0021-the-recipe-decides-the-environment.md)): `env.required` is a check,
`allow` and `deny` are filters, and the values live in
`~/.lingtai/env/<project>.env` at 0600. So the canonical recipe is safe to
append.

That is a property of the schema, and **the log is permanent while a schema is
not**. A test asserts it at the boundary: nothing appended here may carry a
value for a declared name. The board's public snapshot is downstream of this
event, which is what makes the cost of being wrong once unbounded.

## Consequences

**A past run becomes explicable.** Which is the point:
[#190](https://github.com/steven-zhc/lingtai/issues/190) can show what
`proposed:build` ran on *this* run, proved against the hash on the same event,
with no request to GitHub and no dependence on the recipe still being in the
repository.

**It survives 0046.** The fetch-at-`baseSha` route this replaces does not.
Building #190 on the event rather than on the fetch is what stops
[#180](https://github.com/steven-zhc/lingtai/issues/180) from deleting a feature
instead of a data source.

**The log grows by 3.5KB per run.** At this repository's rate that is under
50KB a month, against events that already carry prompts and evidence.

**Nothing becomes readable that was not.** The recipe is already world-readable
in the repository; this puts a copy where the runs are.

**`configHash` keeps its job.** It is still what `lingtai status` prints and
what the wizard compares (`finish.ts:69`). What changes is that there is now
something for it to be the fingerprint *of*.
