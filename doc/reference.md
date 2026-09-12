# Reference: every term, and everything currently in it

One table per term. Each says where the list lives in code, so a reader can
check rather than trust — the two doc defects found on 2026-09-02 were both a
document asserting a state of the world the code had moved past.

Where a list is open-ended (streams, runs, projects) it says so and gives
examples instead of pretending to be exhaustive.

**Counted 2026-09-08.**

> **This describes the code as it is.** It is updated as each step lands, never ahead of it. A
> reference that documents intent instead of behaviour is the defect this
> repository hit four times on 2026-09-02, and it is the one thing this file
> exists not to do.

---

## event — 43 types

One fact that already happened, past tense. Never edited, never deleted.
Source: the registry at the bottom of `packages/domain/src/events.ts`.

| Group | Types |
|---|---|
| work item (7) | `WorkItemDiscovered` `WorkItemClaimed` `WorkItemReleased` `WorkItemBlocked` `WorkItemUnblocked` `WorkItemLinked` `WorkItemLanded` |
| dispatch (1) | `DispatchRefused` |
| run (9) | `RunStarted` `RunPrompted` `RunTouchedFile` `RunContextExhausted` `RunAwaitingInput` `RunProducedDiff` `RunProposedCompletion` `RunFinished` `RunFailed` |
| gate (7) | `GatesResolved` `EndActionsResolved` `GateRequested` `GateStarted` `GatePassed` `GateFailed` `GateWaived` |
| approval (3) | `ApprovalRequested` `ApprovalGranted` `ApprovalRevoked` |
| integration (3) | `IntegrationAttempted` `IntegrationRefused` `IntegrationSucceeded` |
| repair (2) | `RepairRequested` `RepairDeclined` |
| control (3) | `ConductorPaused` `ConductorResumed` `ConductorShutdownRequested` |
| issue (2) | `IssueUpdated` `IssueUpdateFailed` |
| outbox (2) | `OutboxDelivered` `OutboxFailed` — **retired**, `RETIRED` in the same file |
| project & queue (4) | `QueueChanged` `RunRequested` `ProjectConfigured` `Reconciled` |
| extension (1) | `PluginFailed` |

Every type has a Zod payload schema and an entry in `SCHEMA_VER`. A payload
change means bumping that type's version and adding an upcaster in the same
commit — old events are never rewritten.

A **retired** type is one the log holds and nothing appends again. The refusal is
on the write side because the read side has no honest way to decline a row:
retiring is two things, and only the second can be enforced — stop writing them,
and keep reading them for ever.

## stream — 7 prefixes, unbounded instances

The events about one thing, in order. The **prefixes** are a closed set,
validated by regex in `packages/domain/src/envelope.ts`. The streams themselves
are not — one per work item, run, lane and project, forever.

| Prefix | One per | Example |
|---|---|---|
| `wi-` | work item (ticket) | `wi-nextloom-ai-admin-156` |
| `run-` | run (one attempt) | `run-75b80f13-9f88-48cf-b4d2-79b9779f47cf` |
| `int-` | integration lane, per base branch | `int-nextloom-ai-admin-develop` |
| `prj-` | project | `prj-nextloom-ai-admin` |
| `ctl-` | control | `ctl-conductor` (the only one so far) |
| `chat-` | discussion about one work item | `chat-8f21…` |
| `ext-` | extension | `ext-subscribers` (the only one so far) |

## upcaster — 15 chains, 17 steps

A function reading an older event shape and returning the current one.
Source: `UPCASTERS` in `packages/domain/src/upcast.ts`.

| Type | Step | What changed, and why the honest reading is the one given |
|---|---|---|
| `ProjectConfigured` | 1 → 2 | `owner` — the repo name alone could not reach GitHub again. v1 events get `null`, not a guess. |
| `ProjectConfigured` | 2 → 3 | `base` — defaulting to the repo's default branch is only right by convention, and admin's default was a feature branch. `null` means "ask GitHub", which is what those runs did. |
| `Reconciled` | 1 → 2 | each finding gained `action` |
| `WorkItemClaimed` | 1 → 2 | `title` and `kind`, because the queue left the log |
| `WorkItemClaimed` | 2 → 3 | `leaseUntilMs` **removed** ([0027](decisions/0027-the-lease-is-deleted.md)). The only step that drops a field rather than adding one, and the reason it is a step at all: the log holds thousands of these timestamps and none is rewritten, so the reader is what stops believing them |
| `WorkItemBlocked` | 1 → 2 | `needs` and `diagnosis` (`#83`). A block could say only *what is your question*, so a `human:` gate asking for a decision and a conflict nobody had looked at were the same event with a different string on it. Both null on a v1: the upcaster is handed a payload rather than a stream, and the question's wording is a convention of the three call sites and not a field |
| `RunStarted` | 1 → 2 | `invocation` — the command, the tier and the limits as applied, where there had been only the runtime's name (`#88`) |
| `RunPrompted` | 1 → 2 | the prompt text and not only its length (`#88`) |
| `GatesResolved` `GateRequested` `GateStarted` `GatePassed` `GateFailed` `GateWaived` `ApprovalRequested` `ApprovalGranted` `ApprovalRevoked` | 1 → 2 | the `diff` gate point became `proposed` ([0018](decisions/0018-the-proposed-point.md)). Nine types carry a `GatePoint`, so nine move together — a payload whose `gate` is still `diff` would fail the enum rather than pass wrongly, which is why none can be skipped |

Every other type is still at version 1. `SCHEMA_VER` is derived from `BUMPED` in
`packages/domain/src/events.ts`; everything absent from it is 1.

## projection — 1

A regular Postgres table built by replaying the log. Holds no truth of its own.
Source: `taskViewProjection` in `packages/projector/src/task-view.ts`, wired in
`apps/cli/src/lingtai.ts`.

| Name | Answers | Owns its table? |
|---|---|---|
| `task_view` | what is the current state of every task the board shows | yes — `create`/`reset` build and drop it, along with `task_view_run` |

There were two. The `outbox` projection is gone with the outbox itself
([0022](decisions/0022-the-seams.md)), dropped by the
`20260904T2359_drop_outbox` migration; `task_view` is now a fold and nothing
else, with the queue cache gone the same way. **Nothing writes to it but the
projection**, and the way to correct it is `lingtai projection rebuild
task_view` — replay, never a repair by hand.

## task state — 5, board lane — 4

Source: `LABEL_STATES` in `packages/domain/src/streams.ts:61`, re-exported as
`TaskState` by `packages/projector/src/task-view.ts:65`.

`queued` · `running` · `gates` · `waiting` · `landed`

**The board shows four**: `gates` folds into `running` (ADR 0016 §8). From an
operator's seat "the agent is working" and "the build is running" are the same
fact — the machine is busy and you are not needed. `waiting` is the lane the
board exists for, and it stays its own.

The state survives because it is a real distinction *in the log*; only the
column is merged.

`queued` is the only one not driven by an event — it comes from GitHub, because
Lingtai never decided which issues exist ([ADR 0012](decisions/0012-one-task-view.md)).

## policy — every number that decides behaviour

Every other section counts a **kind**: event types, gate points, doctor checks,
tiers. This one lists **limits** — the numbers that decide what a run is told,
what it may spend and how long a card survives. Nothing here names a thing; each
row is a rule, and until [0029](decisions/0029-the-prompt-budget-is-the-recipes.md)
this file had no shape that could hold one.

That gap is why six of these lived in three source files with **no mention
anywhere in `doc/`, `README.md` or `CLAUDE.md`** (`#96`). They were well
commented where they sat — `agent-gate.ts` cited experiment 001's diff size as
its evidence — and being well commented is not the same as being findable. It is
the same structural gap that hid the lease ([0027](decisions/0027-the-lease-is-deleted.md))
and the backoff ([0028](decisions/0028-the-backoff-is-the-recipes.md)).

**A limit is either the recipe's or Lingtai's, and the column says which.** A
number a repository should be able to choose belongs in the recipe (0016 §7);
one that governs the log or the board belongs in code, and then this table is
where its value is written down.

### what a run is given — `runtime.budget`, the recipe's

Together these are the answer to *what does an agent know about why the last
attempt failed*, which is the premise of `#82` and of `repair`
([0025](decisions/0025-a-failure-buys-one-agent.md)). An agent that cannot see
the failure repeats it, and the ticket buys another agent.

| Key | Default | What it decides | Applied by |
|---|---|---|---|
| `runtime.budget.evidence` | `2000` chars | how much of one earlier failure's output the next prompt quotes verbatim | `clamp` in `packages/conductor/src/attempts.ts` |
| `runtime.budget.attempts` | `5` rows | how many attempts the history table names before "and N earlier" | `attemptBrief`, same file |
| `runtime.budget.findings` | `5` | how many of a review gate's findings are carried into the next attempt | `attemptOutcome`, same file |
| `runtime.budget.diff` | `400000` bytes | past this, the diff handed to a **review agent** is truncated | `buildReviewPrompt` in `packages/actions/src/agent-gate.ts` |

The `diff` default is [experiment 001](experiments/001-cold-review-issue-58.md)'s
reasoning: its diff was 1391 lines across 6 files and fitted comfortably, and far
past that is a work item scoped too large — which the compaction counter already
reports. A megabyte produces a worse review, not a better one.

### what a pass may spend — `runtime.limits`, the recipe's

Two of these bound **one agent run**; the third bounds **how many of them a pass
buys**. They sit in one block because the number anybody actually wants is the
product, `(rounds + 1) × wall`, and it is computed once — `passCeiling` — so
`lingtai add`, the board's chip and `lingtai shutdown` cannot say different
things about the same recipe ([0039](decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3).

| Key | Default | What it decides |
|---|---|---|
| `runtime.limits.turns` | `300` | turns before the runtime stops the agent, **per run** |
| `runtime.limits.wall` | `2h` | wall clock before the same, **per run** |
| `runtime.limits.rounds` | `2` | how many times a pass sends the agent back, carrying what refused it — findings, a build's output, or the conflict left standing in its worktree. `0` means every refusal goes straight to a person |
| `gates.<point>[].timeout` | `15m` | per process action, not per point |
| `source.backoff` | `1h`, flat | how long a failed attempt keeps its own ticket out of the queue — its own section, below |

**Why the default is two and not one.** 0025 §3's rule for a spending default is
the smallest number that makes the feature exist. `rounds` replaces two ceilings
that were one each, and [0038](decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
§4's reason for having two was real: a build going red and a review refusing are
different failures, and one round shared between them means whichever happens
first decides whether the other gets an attempt at all. A pass that fixes a red
build and then meets a finding needs two rounds to do what two purses of one did.

**`repair.maxAttempts`, `repair.fix` and `repair.on` are gone**, and a recipe
still carrying a `repair` block is **refused by name** rather than ignored —
`z.object` would have dropped it silently, leaving a repository running on a
default while its own file said otherwise. The two old ceilings do not add up to
the new one, so nothing migrates it for you.

### what Lingtai decides for itself

Not the recipe's, and each row says why.

| Constant | Value | What it decides | Why it is not a recipe key |
|---|---|---|---|
| `EVIDENCE_LINES` / `EVIDENCE_BYTES` (`packages/actions/src/command.ts`) | `60` lines / `8000` bytes | the log tail a failed command keeps as its evidence | it is written into `GateFailed.evidence` — an **event payload**. A recipe may decide what a run is told; it may not decide how much a project writes into a log that is never rewritten. `runtime.budget.evidence` then clips that tail again on the way into a prompt, and that is the bound that is about cost |
| `DEFAULT_RETENTION_DAYS` (`packages/projector/src/task-view.ts`) | `2` days | how long a landed task stays on the board — **a query, not a rebuild** | one board across every project, so no single recipe is the place to decide it. [0012](decisions/0012-one-task-view.md) settled the concept — *"Retention must not be in the projection, and this is the part that is easy to get wrong"* — and only the number was unrecorded |
| `BUFFER_BYTES` (`packages/actions/src/command.ts`) | `2000000` bytes | above this, older output is dropped **while the command is still running** | a runaway process can print faster than anything reads it. This bounds memory, not meaning |
| `RUN_LOG_MAX_BYTES` (`packages/agent/src/run-log.ts`) | `8000000` bytes | where a run's log file stops, saying so in itself on the line it stops at | it bounds a file on the operator's disk, not what a run is told or may spend. A trace line is about sixty bytes, so this is ~130,000 tool calls — the cap is not for the trace but for `#109`'s agent stream, which can be tens of megabytes for one run. Past this it stops being a file somebody opens to find out why a run failed ([0034](decisions/0034-the-run-log.md) §7) |
| `TRACE_LINE_CHARS` (`packages/agent/src/claude-code.ts`) | `4000` characters | where one line of the agent's own output stops, saying how much more there was | it bounds a line of a file, not what a run is told or may spend. `#109` put the agent's prose in the log and a single message has no bound; this is what keeps one runaway line from spending the whole of `RUN_LOG_MAX_BYTES` at once, and past a long paragraph more of it in the file is not more of it read. Nothing is lost: `sessionIdFor` makes the full transcript computable from a run id forever |

| `RUN_LOG_POLL_MS` (`packages/agent/src/run-log.ts`) | `250` ms | how often `lingtai attach` and the board's run-log stream look for more of the file | it is the cost of *reading* a log, which nothing about a project decides. There is no notification to wait on — 0034 chose a file over a socket precisely so that reading one needs nothing from the process that wrote it, and `tail -f` polls for the same reason. Under the threshold at which a person watching a scrolling log perceives a delay, and a pass that finds nothing costs one `read` returning zero bytes |
| `KEEP_LINES` (`apps/board/src/app/run-log.tsx`) | `2000` lines | how much of one run log the *browser* holds; the head is dropped, never the tail | it bounds a DOM node and nothing else. `RUN_LOG_MAX_BYTES` bounds the file, and eight megabytes in one `<pre>` is a tab that stops responding — a worse failure than showing less. `lingtai attach` has no such bound, because a terminal is a scrollback |

**And these rows are why the section exists.** `RUN_LOG_MAX_BYTES` and
`TRACE_LINE_CHARS` are the first constants of this kind added since `#96` was
filed, and 0034 §7 wrote the requirement into the decision rather than into
anybody's intentions: *that number goes into `doc/reference.md`'s policy section
on the day it is written*.
Six of the rows above spent months deciding behaviour with no mention anywhere
in `doc/`, `README.md` or `CLAUDE.md`; being well commented where it sits is not
the same as being findable.

The two files a run leaves outside the repository are `0600` and `0700`
respectively — `RUN_LOG_MODE` and `RUN_LOG_DIR_MODE`, the standard
`agent-env`'s `ENV_FILE_MODE` set. The log holds whatever the agent printed,
which includes values it read from its filtered environment and contents of
files it opened; that output was parsed and discarded until `#109`, so
persisting it is a **new** exposure rather than a wider view of an existing
one.

**The bounds are passed in, never defaulted at the point of use.**
`attemptBrief`, `attemptOutcome` and `buildReviewPrompt` take the number as an
argument, so the value has exactly one home — the schema. A second default beside
the call site would be a second place the answer lives, which is how these got
lost in the first place.

Nothing bounds the *number* of attempts at a work item. That is a ceiling rather
than a budget, and 0028 leaves it undecided on purpose.

## claim — what holds a ticket, and the two things that are not it

**A `WorkItemClaimed` on `wi-{project}-{n}`.** It says which run took the ticket
and which `worker` — host and pid — took it for. Source:
`claimWorkItem` in `packages/conductor/src/claim.ts`; the fold is
`WorkItemLifecycle` in `packages/domain/src/work-item.ts`.

| | |
|---|---|
| what excludes | `UNIQUE (stream_id, version)`. The claim is an append at the version the reader saw; two conductors racing both append at that version and the database rejects one, which comes back as `lost-race` |
| what expires it | **nothing.** A claim held is a claim held, for as long as the log says so |
| what returns it | an appended `WorkItemReleased` — the run ending, a gate failing, `lingtai now`, or the recovery below. There is no other way back |
| what recovers it | a conductor starting. It holds `lingtai:daemon`, and since `#93` every conductor takes that lock, so it knows it is alone: every claim naming another `worker` is dead. `releaseForeignClaims` in `packages/daemon/src/reconcile.ts` appends the release, citing the lock |
| where a person sees it | a `running` card on the board, and the `WorkItemReleased.reason` naming the lock when one was recovered |

**There was a third thing, and it was none of the above.** `leaseUntilMs` was a
fixed thirty minutes written into every claim and never renewed, against a
`runtime.limits.wall` of an hour here and two hours by default — so every run
past the half hour was alive and holding an expired lease, and the next caller
could take its ticket. It excluded nobody, because two conductors pass a
timestamp check together. [0027](decisions/0027-the-lease-is-deleted.md) deleted
it: exclusion is the constraint, liveness is the lock, and neither is a number.

**Recovery is an append and never a recomputation.** A projection is a fold and
cannot read a clock; if `running` versus `queued` depended on `now()` the same
log would produce different tables at different moments, and `lingtai projection
rebuild task_view` would disagree with the incremental fold. That is what forced
the lease's expiry to be inert, and it is unchanged.

## backoff — the first rule that was written down here

The rule that decides when Lingtai spends money again lived in a constant with
no decision behind it and no mention here (`#95`), because there was nowhere in
this file shaped to hold a rule. [0028](decisions/0028-the-backoff-is-the-recipes.md)
moved it to the recipe; [0029](decisions/0029-the-prompt-budget-is-the-recipes.md)
built the section above so the next one has somewhere to land.

**How long a failed attempt keeps its own ticket out of the queue.** Source:
`source.backoff` in the recipe; applied by `selectRunnable` and read forwards by
`heldUntil`, both in `packages/conductor/src/queue.ts`.

| | |
|---|---|
| where it is decided | the recipe, `source.backoff`. There is no constant and no override |
| default | `1h`, **flat** — the wait does not grow with attempts |
| measured from | `task_view.last_attempt_at`, written by the claim, so it outlives the release |
| what jumps it | a pending repair (0025 §3), and `lingtai now` — neither is a *blind* retry, which is the only thing this guards against |
| what does not jump it | an ordinary release, however the run ended |
| where a person sees it | `[backing off — runnable in 12m]` in `lingtai status`, a `runnable in 12m` pill on a Queued card, and the `retries` line wherever a project is described |

Zero is not a shorter backoff, so the schema refuses anything that is not a
positive duration. Nothing bounds the *number* of attempts: that is a ceiling
rather than a delay, and 0028 leaves it undecided on purpose rather than bending
this into a curve.

## tool restriction — none

Lingtai restricts no tool call. There were eight rules; they are gone (ADR
0016 §6), and so is the `PreToolUse` wiring that evaluated them.

Tool limits belong to the agent runtime's own configuration — `permissions.deny`
in `~/.claude/settings.json` or a managed repository's `.claude/settings.json`.
It holds even under `--permission-mode bypassPermissions`, and it holds by
**removing the tool from the model's list**, so the agent never attempts it
([experiment 008](experiments/008-deny-survives-bypass.md)).

Containment is the filtered environment and the disposable worktree. Neither was
ever the guard's.

## hook — 7

What the runtime calls, and the only channel between a run and the log.
Source: `INTERSECTION_HOOKS` and `CLAUDE_ONLY_HOOKS` in `packages/agent/src/hook-config.ts`.

| Hook | What Lingtai does with it |
|---|---|
| `SessionStart` | lifecycle; the event is `RunStarted`, written by the conductor |
| `UserPromptSubmit` | `RunPrompted`, carrying the prompt itself and the version that produced it |
| `PostToolUse` | `RunTouchedFile`, for the four mutating tools only |
| `Stop` | hands back to the conductor, which fires the gates |
| `SessionEnd` | Claude-only; `RunFinished` comes from the process outcome |
| `PreCompact` | Claude-only; `RunContextExhausted` |
| `Notification` | Claude-only; `RunAwaitingInput` |

`PreToolUse` was the eighth and is gone with the guard. It was the only hook on
the hot path — one round trip per tool call, against a 20ms budget of which
process startup alone was 17ms.

**Four tools count as mutations** (`hook-socket.ts`), and only these produce
`RunTouchedFile`: `Write` · `Edit` · `MultiEdit` · `NotebookEdit`.

## gate point — 5, closed forever

A gate is a **place in the loop**, not a kind of check. The set may never grow.
Source: `GatePoint` and `GATE_POINTS` in `packages/domain/src/events.ts`.

| Point | When | May refuse? |
|---|---|---|
| `admit` | the queue offers an item, before it is claimed | yes |
| `prepared` | after the worktree exists, before the agent starts | yes |
| `proposed` | the agent stopped and there are commits — a change has been proposed | yes |
| `merge` | after `proposed` passes, before the merge lane | yes |
| `end` | the work item reached any terminal outcome | **no** |

`prepared` and `proposed` run the recipe's actions; `merge` holds when a `human`
action asks or when `--no-merge` does; `end` runs too, its actions being effects
rather than verdicts. The conductor calls GitHub and appends the outcome; what
did not land, `reconcile` converges ([0022](decisions/0022-the-seams.md)) —
durability is convergence here, not a queue.
`admit` is declared and empty, which is what an unconfigured point *is* rather
than a gap.

`proposed` was called `diff` until
[0018](decisions/0018-the-proposed-point.md); stored events are upcast on read.

## gate action — 6 keys, of which 4 produce a verdict

What runs at a point. Source: `GateAction` and `kindOfAction` in
`packages/recipe/src/recipe.ts`.

| Key | Verdict comes from | Needs |
|---|---|---|
| `run:` | a command's exit code | the names its `env:` declares |
| `agent:` | a cold reviewer reading the diff, given this prompt | a reviewer runtime |
| `watch:` | globs against the diff's file list, then `request-approval` or `fail` | the diff's file list |
| `human:` | a person, later, on the same stream; the string is the question | nothing |
| `close:` | — it is an effect, not a verdict. `end` only | a GitHub client |
| `labels:` | — same | a GitHub client |

The last two carry `when:` (`landed` / `blocked` / `failed` / `any`), because
`end` fires on *every* terminal outcome. "Close it when it lands, label it when
it is blocked" is one configuration rather than two mechanisms. Putting either
at a gating point is refused by name — a gate that silently did nothing would be
worse.

The shape is GitHub Actions': a `name`, exactly one of the keys above, and its
parameters beside it. Order within a point is the array's, the first refusal
wins, and the actions after it do not run.

Verdicts: `passed` · `failed` · `needs-approval`. The third is not a flavour of
failure — nothing is wrong, and nothing may proceed until a person says so.

**Verdicts are keyed `point:action`** in `task_view`, the board and `reduceRun`.
Two points may run an action of the same name, and a bare name would let the
second silently overwrite the first.

`onSha` is load-bearing: a verdict is about a diff, so a force-push invalidates
it by arithmetic rather than by anybody noticing.

## extension environment — declared, and the declaration is the whole of it

`run:` is the single extension point
([0037](decisions/0037-an-extension-is-a-command.md) §2), its code is not
trusted (§1), and `env:` beside it is **every credential its process gets**.
Source: `ExtensionEnv` in `packages/recipe/src/recipe.ts` and `extensionEnv` in
`packages/agent-env/src/index.ts`.

```yaml
subscribers:
  - name: telegram
    on: [WorkItemLanded]
    run: npx @lingtai/telegram
    env: [TELEGRAM_BOT_TOKEN]
```

Four rules, and the first is the one that matters:

- **Absent means nothing, not everything.** An extension that declares nothing
  gets `runnableEnv`'s six — `PATH` · `HOME` · `TMPDIR` · `LANG` · `USER` ·
  `LOGNAME` — and no credential at all. It used to be handed the environment
  the *agent* was given, which is how a token put in one place reached every
  extension at once.
- **The values are 0021's**, not a second mechanism:
  `~/.lingtai/env/<project>.env` over the machine's own file, merged before the
  recipe's `allow`/`deny` — those decide what reaches *the agent*, which is a
  different consumer.
- **`LINGTAI_*` cannot be declared**, and the refusal names the variable and the
  field. A prefix rather than a list, for `#63`'s reason and 0021's: `RESERVED`
  was deleted because a denylist is a thing to keep up to date. It costs a
  managed repository nothing, since a project's own file keeps its own names.
- **A declared name this machine does not hold is red before a run**, in
  `lingtai doctor`'s `env: <project> extensions`, naming `lingtai env set`.

The **worktree** is not covered by this and is not meant to be: a gate action
runs where the agent worked, and `env.plantAt` put the agent's own file there.
This is about the process environment — the daemon's credentials, which is what
0037 §1 took away.

Nothing spawns a subscriber yet, so today this binds `run:` at a gate point.

## what the log says was *supposed* to happen

`GatesResolved`, one per run, appended before anything is claimed. It names all
five points and the ordered actions resolved for each — empty arrays included.

Without it the log could not distinguish "nothing was configured here" from
"this point does not exist", because `ProjectConfigured` carries a config *hash*
and not the configuration. That distinction is what [ADR 0016](decisions/0016-the-settled-model.md)
§4 rests on: an unconfigured gate is skipped and that is the user's call; a gate
that *was* configured and did not run is Lingtai's bug, and comparing this
event to the verdicts that follow is how the second becomes detectable.

## tier — 3

`open` · `guarded` · `sandboxed`. Source: `Tier` in `packages/domain/src/events.ts:42`.

**It is the recipe's** — `runtime.tier`, defaulting to `guarded`. There is no
comparison to make and no floor underneath: `run-once.ts` refuses to dispatch
when the runtime cannot meet what the recipe asks, and that is the whole of the
enforcement.

`sandboxed` remains a value no runtime provides, so asking for it can only ever
refuse.

## work kind — open

**The repository's, not this list's.** `source.kinds` in the recipe is
`z.array(z.string()).min(1)` and `kindOf` matches against exactly it, so one
list is the vocabulary, the filter and the priority order at once. `exclude` is
free-form for the same reason and always was; the asymmetry was the defect.

There was a `WorkKind` enum here — `bug` · `feature` · `enhancement` ·
`tech-debt` — and #76 deleted it. No code ever branched on a specific kind, so
it bought no behaviour, and it cost a whole queue: a recipe naming
`documentation` did not fail to take documentation, it failed to *resolve*, and
the project offered nothing at all. It also carried `enhancement`, which no
recipe here has ever used. This is 0016 §7 — policy the core guesses at, about
a repository it cannot see.

`WorkItemDiscovered.kind` is therefore `z.string()`. Stored events still parse;
no upcaster was needed.

An issue with no label the recipe names has no kind and is **not runnable** —
which is why admin #156 sat invisible until it was labelled.

## runtime — 2

Source: `RuntimeId` in `packages/domain/src/events.ts:78`.

`claude-code` · `codex`

## integration refusal reason — 7

Why a merge did not happen. Source: `RefusalReason` in `packages/domain/src/events.ts:86`.

`conflict` · `dirty-base` · `unpushed-base` · `pending-migration` ·
`gate-failed` · `no-commits` · `lane-busy`

## run stage — 13

Where a failed run stopped, as `stopped at <stage>`. Source: the `stage:`
returns, the `failing("…")` combinators and the `refusal("…")` calls in
`packages/conductor/src/run-once.ts`.

`recipe` · `dispatch` · `discover` · `claim` · `env` · `hook` · `worktree` ·
`prepare` · `run` · `diff` · `push` · `integrate` · `unexpected`

`diff: no commits` is the one worth recognising — the agent finished and wrote
nothing. This `diff` is a *stage*, not the gate point: the run stopped while
computing the diff, before anything at `proposed` could be asked about it.

## issue change — 3

The three things Lingtai ever says about an issue — everything that leaves this
machine and is not git. Source: `IssueChange` in
`packages/conductor/src/tell.ts`.

`comment` · `labels` · `closed`

One field rather than three event types, because with the failures that would
have been six and all three are handled identically: every attempt appends
`IssueUpdated` or `IssueUpdateFailed`, and **nothing in `tell.ts` ever throws**.
A label that did not land must not turn a merge that did into a failed run.

**There is no retry behind this, and that is the point.** The outbox — a table, a
projection, a worker, a backoff and a dead-letter standing behind three calls —
is gone ([0022](decisions/0022-the-seams.md)); the failure all of it retried had
never once been observed. What it bought that was worth keeping is the *record*,
because the old loop called `gh` inline and a failed call left nothing at all.
What did not land is converged later by `reconcile`, which compares what the log
says an issue should look like against what GitHub says it does.

### where `skipped` is rendered

The task page lists **all five points**, always, marking an empty one `skipped`
rather than leaving it out — `PointView` in `apps/board/src/lib/task.ts`, built
by folding `GatesResolved` against the verdicts that followed. A point with more
planned actions than verdicts shows a `pending` count, which is where
"configured but did not run" becomes visible.

`lingtai add` prints the same five at onboarding. Neither surface omits a point.

## the `end` plan, continued

`closed` comes from `EndActionsResolved`, which is how a recipe's `end` plan
reaches a projection. The conductor reads the recipe and writes down what it
resolved; the projection only folds. **A projection may never read a recipe** —
that division is why a rebuild produces the same rows years later even if the
recipe has changed since.

`end` fires on **any** terminal outcome — `landed`, `blocked`, `failed` — from
whichever path reached it: an inline merge, `lingtai approve`, or the board's
approve button. Once per outcome, and the item's own stream is where that is
checked. A recipe that declares `end` actions gets the event even when none of
them match the outcome, so that *configured and resolved to nothing* and
*configured and never ran* are two different things in the log — which is what
`gates: end ran on what landed` compares, and what `lingtai end replay`
repairs.

Nothing that changes *code* goes through here — that is git's job, under the
merge lane's lock.

## notification subscription — 4 by default

What is worth interrupting somebody for. All four mean the same thing: nothing
moves until a person acts. Source: `DEFAULT_SUBSCRIPTIONS` in
`packages/daemon/src/notify.ts`.

`ApprovalRequested` · `IntegrationRefused` · `RunAwaitingInput` · `WorkItemBlocked`

A landed task is good news that needed nobody, and is deliberately not in
**this** channel — a desktop notification interrupts, and nothing that needed
nobody is worth interrupting for.

**The rule is per-channel, and the recipe is where a channel says its own.**
`subscribers:` ([0037](decisions/0037-an-extension-is-a-command.md) §3,
`Subscriber` in `packages/recipe/src/recipe.ts`) carries an `on:` list per
subscriber, so a Telegram bot — read when you choose rather than when it arrives
— can name `WorkItemLanded` without that changing what interrupts you:

```yaml
subscribers:
  - name: telegram
    on: [WorkItemLanded, WorkItemBlocked, RunFailed]
    run: npx @lingtai/telegram
    env: [TELEGRAM_BOT_TOKEN]
```

The `on:` list is the subscription as well as the declaration, so a name that is
not in `EVENTS` fails the recipe and names itself. A retired type fails too:
spelled right, in the catalogue, and appended by nothing, which is the same
subscription that never fires reached by a different mistake. `env:` is every
credential that subscriber's process gets — see *extension environment* above,
which is the half of 0037 §1 that makes "and nothing else" a fact. The four
above are still the daemon's own defaults and nothing reads `subscribers:` yet.

## lingtai subcommand — 16

Source: the switch in `apps/cli/src/lingtai.ts`.

`add` · `run` · `approve` · `requeue` · `attach` · `status` · `doctor` · `env` ·
`end` · `daemon` · `pause` · `resume` · `shutdown` · `now` · `projection` ·
`version`

`approve` and `requeue` are the two decisions a person can take from here.
`waive` is still the board's alone (`#129`), which is worth knowing from this
list rather than by trying it — that the set was not countable from the CLI's
side is how `requeue` went missing for as long as it did (`#130`).

`help` (`--help`, `-h`) is the fallthrough rather than a subcommand.

## doctor check — 22 fixed, 4 per project, 3 deferred

Source: the `results.push` sequence in `runDoctor`, `apps/cli/src/doctor.ts`.
**Read off the file, in the order the command prints them**; the previous
version of this section was transcribed from one run's output and had drifted
by four checks and two names.

| Group | Checks |
|---|---|
| load (1) | `packages load under Node` |
| environment (1) | `environment` |
| connections (2) | `postgres: pooled connection` · `postgres: direct connection is session mode` |
| schema (5) | `schema: tables` · `schema: optimistic concurrency` · `schema: append-only` · `schema: notify trigger` · `schema: payload column` |
| projections (2) | `projections: lag` · `projections: shape` |
| running system (5) | `daemon: liveness` · `conductor: lock` · `worktrees: reconciliation` · `github: what we said and did not manage` · `subscribers: failures` |
| the log itself (1) | `log: every type is readable` |
| gates ran (2) | `gates: end ran on what landed` · `gates: every point that was planned ran` |
| credentials (2) | `github: app credentials` · `runtime: signed in` |
| visibility (1) | `runtime: other settings in scope` — reports what configures a run besides the recipe |

**Four more run once per configured project**, so the total depends on how many
there are: `recipe: resolves for every project`,
`env: declared names, and which layer`, `env: <project> extensions` and
`recipe: the rules and the merge target are one branch`. Each reports under the
project's own name (`recipe: lingtai`, `env: lingtai`,
`env: lingtai extensions`, `base: lingtai`) when it has something to say about
that project in particular.

`env: <project> extensions` is 0037 §1's half: what each `run:` action and each
subscriber declared, and whether this machine holds it. It is `fail` rather than
`warn` when one is not set, because an extension gets *only* what it declares,
so a missing name is a command that starts, finds nothing and exits — and a
subscriber's exit code is discarded.

Four statuses: `ok`, **`warn`** (nothing is wrong and you should know anyway),
`fail`, `skip`. `warn` was added with `runtime: other settings in scope`: folding
it into `ok` hides it in a wall of green, and into `fail` makes doctor red for a
file everybody has.

The three deferred are `repository, base branch, submodules`,
`hook: fail closed` and `github: installation and labels`. A deferred detail says
**why the check is not a startup check** — of the design, and where the property
is proved instead — and claims nothing about the state of this machine. It
carries no issue number, because an issue closes and a reason that stands on its
own does not need one. They are reported rather than hidden: a check quietly
dropped is indistinguishable from one that passes.

## preset — 1

Source: `packages/recipe/src/presets.ts`.

`pnpm-workspace` — a `pnpm install --frozen-lockfile` action at `prepared` and a
`build` action at `proposed`. A preset's *name* is not part of the recipe hash, because
it is not part of what a run does.

## package — 13, plus 2 apps

`domain` · `recipe` · `event-store` · `projector` · `github` · `agent` ·
`agent-env` · `env` · `actions` · `repo` · `conductor` · `daemon` · `hook`, and
`apps/cli` · `apps/board`.

Five were renamed at [0022](decisions/0022-the-seams.md) and this section still
named the old ones: `core` is `domain`, `config` is `recipe`, `store` is
`event-store`, `runtime` is `agent`, `gates` is `actions`.

## doc — 29 decisions, 10 experiments

`doc/decisions/` is append-only in spirit: a decision that turns out wrong gets
a new file that supersedes it, never an edit. `doc/experiments/` holds things
actually run, each with its limits.
