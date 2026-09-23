# Reference: every term, and everything currently in it

One table per term. Each says where the list lives in code, so a reader can
check rather than trust — the two doc defects found on 2026-09-02 were both a
document asserting a state of the world the code had moved past.

Where a list is open-ended (streams, runs, projects) it says so and gives
examples instead of pretending to be exhaustive.

**Counted 2026-09-10.**

> **This describes the code as it is.** It is updated as each step lands, never ahead of it. A
> reference that documents intent instead of behaviour is the defect this
> repository hit four times on 2026-09-02, and it is the one thing this file
> exists not to do.

---

## event — 59 types

One fact that already happened, past tense. Never edited, never deleted.
Source: the registry at the bottom of `packages/domain/src/events.ts`.

| Group | Types |
|---|---|
| work item (7) | `WorkItemDiscovered` `WorkItemClaimed` `WorkItemReleased` `WorkItemBlocked` `WorkItemUnblocked` `WorkItemLinked` `WorkItemLanded` |
| dispatch (1) | `DispatchRefused` |
| run (9) | `RunStarted` `RunPrompted` `RunTouchedFile` `RunContextExhausted` `RunAwaitingInput` `RunProducedDiff` `RunProposedCompletion` `RunFinished` `RunFailed` |
| gate (9) | `GatesResolved` `EndActionsResolved` `GateRequested` `GateStarted` `GatePassed` `GateFailed` `GateNeverRan` `GateDidNotFinish` `GateWaived` — the last two are the two ways a gate's agent ends without judging the diff: it never started ([0041](decisions/0041-a-gate-that-never-ran.md)), or it started and produced no receipt ([0057](decisions/0057-a-gate-that-did-not-finish.md)) |
| approval (3) | `ApprovalRequested` `ApprovalGranted` `ApprovalRevoked` |
| integration (3) | `IntegrationAttempted` `IntegrationRefused` `IntegrationSucceeded` |
| repair (2) | `RepairRequested` `RepairDeclined` — **retired** (`#143`), `RETIRED` in the same file. A lane refusal buys nothing ([0039](decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §Consequences), so there is no purchase to record and no decline to keep apart from one |
| fix (3) | `FixRequested` `FixApplied` `FixDeclined` — a refusal answered inside the pass that was refused ([0039](decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §2) |
| restart (1) | `PassRestarted` — a pass whose rounds are spent, starting the ticket over ([0040](decisions/0040-rounds-bound-depth-restarts-bound-breadth.md)) |
| control (5) | `ConductorStarted` `ConductorPaused` `ConductorResumed` `ConductorShutdownRequested` `ConductorShutdownWithdrawn` |
| issue (2) | `IssueUpdated` `IssueUpdateFailed` |
| outbox (2) | `OutboxDelivered` `OutboxFailed` — **retired** ([0022](decisions/0022-the-seams.md)), `RETIRED` in the same file |
| discussion (4) | `DiscussionRequested` `DiscussionAsked` `DiscussionAnswered` `DiscussionHeld` |
| prompt (1) | `PromptEdited` |
| project & queue (7) | `QueueChanged` `RunRequested` `ProjectOnboardingStarted` `ProjectConfigured` `ProjectRefused` `ProjectRecovered` `Reconciled` |
| github app (1) | `GitHubAppCreated` — the team's own App, minted from a manifest (`#169`). **Two fields, and the other four values that arrived are the reason**: the private key, the webhook secret and an OAuth client secret Lingtai has no flow for. The log is permanent and `projection rebuild` replays it, so what is recorded is the **id and the slug** — the key goes to a `0600` file, the webhook secret to the env file, and the OAuth pair is dropped where the conversion is read (`packages/github/src/manifest.ts`) |
| extension (1) | `PluginFailed` |

Every type has a Zod payload schema and an entry in `SCHEMA_VER`. A payload
change means bumping that type's version and adding an upcaster in the same
commit — old events are never rewritten.

A **retired** type is one the log holds and nothing appends again. The refusal is
on the write side because the read side has no honest way to decline a row:
retiring is two things, and only the second can be enforced — stop writing them,
and keep reading them for ever.

A **transition** type is appended when a state changes, never while it lasts.
`ProjectRefused` and `ProjectRecovered` are the pair (`#148`). A conductor's
pass that cannot look at a project — the catch in `conduct.ts`, a recipe that
will not resolve or a client that will not build — appends `ProjectRefused` to
`prj-{project}`, carrying the message, the `ref` the recipe was read from and
the `codeSha` of the refusing process. A later pass that looks at the project
without refusing appends `ProjectRecovered`. Something that fails after the
project was looked at — the issue listing, a run, the merge lane — is reported by
the pass and is not a `ProjectRefused`: that project was read and worked. A pass whose refusal matches the
one on record — same `ref`, same `codeSha`, same message with its digits taken
out — appends nothing, so N sweeps against one broken recipe are one event. The
decision is read off the project's own fold (`passTransition`,
`packages/domain/src/project.ts`) and reads no clock
([0027](decisions/0027-the-lease-is-deleted.md)). The same message from another
`codeSha` is a new refusal: that commit is what tells *this recipe is broken*
apart from *this process is too old for a recipe that is fine*. It is not
`DispatchRefused`, which is about tiers and is appended after a claim that a
refusing pass never reaches. A run that `runOnce` stops before its claim is not
a `ProjectRefused` either.

A project is **pending** between `ProjectOnboardingStarted` and
`ProjectConfigured` (`#163`): recorded, visible on the board, and conducted by
nothing. There is no flag and no table — `isRegistered` is `project !== null &&
configHash !== null`, and `configHash` arrives only with a recipe that was read.
`loadProjects()` has filtered on it since before pending existed, which is why
the daemon needed no guard. **What pending waits for is `Recheck`, not an
installation** (`#182`): the wizard writes the recipe on this machine and
records the project only through a client built on the App's installation on
the repository, refusing without one — so every pending project had one when it
was recorded. What can still refuse is `lingtai add`'s checks: the
installation's permissions, the recipe, or an installation removed since. The
board draws a card with `Recheck` on it, and `Recheck` is `recheck`
(`packages/conductor/src/onboard.ts`): it asks `installationForRepo` first and
answers *not installed* with nothing written, and otherwise runs `lingtai add`'s
own path — the scopes, `~/.lingtai/<project>/recipe.yml`, `ProjectConfigured` —
saying everything `add` said when it refuses. Nothing finishes it
automatically, by decision
([the onboarding wizard](design/the-onboarding-wizard.md)).

What appends that first event is `startOnboarding`
(`packages/conductor/src/wizard.ts`, `#165`), called by the wizard page's
*Write the recipe on this machine* (`apps/board/src/app/setup/wizard/finish.ts`), and it is **the only write the
wizard makes of its own accord** — and since `#180` it writes nothing to the
repository: the recipe is parsed before anything is written, so a file that
would fail `lingtai add` names its bad field instead; then
`~/.lingtai/<project>/recipe.yml`, with the page's agent and limits under
`projects.<project>.runtime` in `~/.lingtai/config.yml`, read back the way `add`
reads them; then the event. A recipe already at that path that is not this one,
or a machine file that already names another runtime for the project, is refused
before anything is written. Abandon the page before it and the wizard has left
nothing of its own accord to clean up. If the append fails over a written file it
names the file and says which of two things happened: a store that blinked is
finished by pressing again, which picks up a file that is *this* recipe, while a
stream that moved underneath it is not, and that refusal says so and hands back
the file. Beside
it `firstPass` is the last screen — `selectRunnable` and
`passedOver` and no rule of its own, so
`12 runnable · 18 passed over — excluded-label 14, no-kind 4` is the sentence
`lingtai status` will print an hour later.

`Hold all` is `holdAll`, and it is **the operator's write and not the
wizard's** — the one thing on that screen that outlives abandoning the page,
since the labels stay on GitHub and the project has no stream to record them
on. So it is offered and never automatic, it adds its label rather than
replacing an issue's set, and the label is `agent:hold` or there is no button:
`source.exclude` is free-form, and a recipe that excludes only `wontfix` gets
no offer rather than that word stamped across twelve bug reports.

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
| `ctl-` | control | `ctl-conductor`, `ctl-github-app` |
| `chat-` | discussion about one work item | `chat-8f21…` |
| `ext-` | extension | `ext-subscribers` (the only one so far) |

`ctl-github-app` is the installation's App and holds one event per creation
(`#169`). It is beside `ctl-conductor` rather than on it because the daemon
appends to that stream while it runs, and a board recording an App would race a
pass for the version — `ext-subscribers` is apart for the same reason.

## upcaster — 18 chains, 23 steps

A function reading an older event shape and returning the current one.
Source: `UPCASTERS` in `packages/domain/src/upcast.ts`.

| Type | Step | What changed, and why the honest reading is the one given |
|---|---|---|
| `ProjectConfigured` | 1 → 2 | `owner` — the repo name alone could not reach GitHub again. v1 events get `null`, not a guess. |
| `ProjectConfigured` | 2 → 3 | `base` — defaulting to the repo's default branch is only right by convention, and admin's default was a feature branch. `null` means "ask GitHub", which is what those runs did. |
| `Reconciled` | 1 → 2 | each finding gained `action` |
| `WorkItemClaimed` | 1 → 2 | `title` and `kind`, because the queue left the log |
| `WorkItemClaimed` | 2 → 3 | `leaseUntilMs` **removed** ([0027](decisions/0027-the-lease-is-deleted.md)). The first of the two steps that drop a field rather than add one — `GateDidNotFinish` 1 → 2 below is the other — and the reason it is a step at all: the log holds thousands of these timestamps and none is rewritten, so the reader is what stops believing them |
| `WorkItemBlocked` | 1 → 2 | `needs` and `diagnosis` (`#83`). A block could say only *what is your question*, so a `human:` gate asking for a decision and a conflict nobody had looked at were the same event with a different string on it. Both null on a v1: the upcaster is handed a payload rather than a stream, and the question's wording is a convention of the three call sites and not a field |
| `RunStarted` | 1 → 2 | `invocation` — the command, the tier and the limits as applied, where there had been only the runtime's name (`#88`) |
| `RunPrompted` | 1 → 2 | the prompt text and not only its length (`#88`) |
| `PromptEdited` | 1 → 2 | `hash` and `basedOn` (`#104`). Both null: the digest could be recomputed from `text`, but recomputing it and recording it are different claims |
| `FixRequested` | 1 → 2 | `of` — the `rounds` ceiling the round is counted against (`#146`). Zero means *not recorded*, and the number is not guessable: the recipe is read from the base branch every pass |
| `GatesResolved` `GateRequested` `GateStarted` `GatePassed` `GateFailed` `GateWaived` `ApprovalRequested` `ApprovalGranted` `ApprovalRevoked` | 1 → 2 | the `diff` gate point became `proposed` ([0018](decisions/0018-the-proposed-point.md)). Nine types carry a `Step`, so nine move together — a payload whose `gate` is still `diff` would fail the enum rather than pass wrongly, which is why none can be skipped |
| `GatesResolved` | 2 → 3 | `recipe`, the canonical recipe the run resolved against ([0047](decisions/0047-the-recipe-a-run-got-is-on-the-log.md)). The step adds **nothing** — absent, not null and not `{}`, so *not recorded* stays distinguishable from *recorded, and empty* |
| `GatesResolved` | 3 → 4 | `points` names all **ten** steps where it named five ([0058](decisions/0058-lingtai-is-a-development-pipeline.md) §3). The five the vocabulary did not have get `[]`, which is not a guess but what that recipe said: there was nothing at `claim`, `design`, `implement`, `build` or `review` to configure. Without it `.length(10)` refuses every plan this log holds |
| `GateDidNotFinish` | 1 → 2 | `attempt` and `retrying` **removed** with 0057 §4's retry (`#234`). The second step that drops a field, and a step for `WorkItemClaimed`'s reason: the rows saying `attempt: 2, retrying: false` are not rewritten, so the reader is what stops believing them. There is nothing to recover — the retry those numbers described reused the crashed attempt's session id, so `claude` refused it in zero seconds having run nothing. This type is younger than 0018, so 1 never said `diff` |
| `GatePassed` | 2 → 3 | `findings`, the shape `GateFailed` carries (`#135`). A `minor` does not refuse, so a passing review's findings had existed only as prose inside `evidence`. A v2 pass gets `[]`, not a parse of that prose, which is untouched |

**The counts in this heading are counted off the table, never computed.** Nine
of the eighteen chains are one row above, because ADR 0018 moved nine types
together and reads as one fact; the heading still counts them as nine. It read
*15 chains, 17 steps* while `PromptEdited` and `FixRequested` were missing
rows — a heading that is arithmetic on a number nobody re-derived is how a
reader comes to believe four rows are stale and deletable.

**The nine `1 → 2` steps go when the log goes, and not before.**
[0061](decisions/0061-the-recipe-is-the-pipeline.md) §7 spends this history by
**resetting** it — [the-pipeline](design/the-pipeline.md)'s T5, with T5b's fold
of the log before it, neither landed. Until they are, the store holds
`schemaVer: 1` rows of all nine, so the step stays and so do the nine
`SCHEMA_VER`s that depend on it: lowering a version below what the writer
stamped sends every stored row down `upcast`'s *the writer is newer than the
reader* branch, which names the wrong party.

**`GatesResolved`'s `3 → 4` is there for the same reason and was nearly not
written.** The plan going from five steps to ten was to be paid for by that
same reset, so it landed with no step and no version — and the reset is the
thing that has not run. A `.length(10)` reached with nothing in between refuses
every row this log holds, and the refusal is not survivable: `decodeRow`
rethrows the `ZodError` bare, so a projector stops at the first such seq and
never advances past it, rebuild included. *The reset will pay for it* is not a
property a reader can have today. **The mechanism is untouched either way**
([0001](decisions/0001-event-sourcing.md)): it was built before it was needed
because the first upcaster is written under time pressure against real history,
and a Lingtai whose log nobody may reset will want it.

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

Every other section counts a **kind**: event types, steps, doctor checks,
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
attempt failed*, which is the premise of `#82`. It was also `repair`'s
([0025](decisions/0025-a-failure-buys-one-agent.md)), and a refusal buys no run
to be told anything since `#143` — so what carries a failure forward is the
attempt history in `{{failure}}`, and the round inside the pass, which is handed
the refusal verbatim. An agent that cannot see the failure repeats it.

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

Two of these bound **one agent run**; `rounds` bounds **how many of them a pass
buys**; `restarts` bounds **how many passes one ticket buys**. They sit in one
block because the number anybody actually wants is the product,
`(restarts + 1) × (rounds + 1) × wall`, and it is computed once — `passCeiling`
— so `lingtai add`, the board's chip and `lingtai shutdown` cannot say different
things about the same recipe ([0039](decisions/0039-the-worktree-is-the-whole-of-a-pass.md) §3,
[0040](decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) §5).

| Key | Default | What it decides |
|---|---|---|
| `runtime.limits.turns` | `300` | turns before the runtime stops the agent, **per run** |
| `runtime.limits.wall` | `2h` | wall clock before the same, **per run** |
| `runtime.limits.rounds` | `2` | how many times a pass sends the agent back **into the same worktree**, carrying what refused it — findings, a build's output, or the conflict left standing there. `0` means nothing patches a diff in place |
| `runtime.limits.restarts` | `0` | how many times a pass whose `rounds` are spent **starts the ticket over** from the base, carrying the findings, instead of asking a person. Only a refused *review* is answered this way; a red build and a conflict stay in the worktree, because for those the work is still there. `0` is what it did before the key existed |
| `gates.<point>[].timeout` | `15m` | per process action, not per point |
| `source.backoff` | `1h`, flat | how long a failed attempt keeps its own ticket out of the queue — its own section, below |

**Why the default is two and not one.** 0025 §3's rule for a spending default is
the smallest number that makes the feature exist. `rounds` replaces two ceilings
that were one each, and [0038](decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
§4's reason for having two was real: a build going red and a review refusing are
different failures, and one round shared between them means whichever happens
first decides whether the other gets an attempt at all. A pass that fixes a red
build and then meets a finding needs two rounds to do what two purses of one did.

**Why `restarts` defaults to zero, which is the opposite argument.** That rule
about spending defaults is about not taking a feature away by defaulting it too
low, and this default takes nothing away: until a recipe writes a number down
there is no feature to take. The evidence for the second ceiling is
[experiment 011](experiments/011-patching-versus-starting-over.md) — **one
ticket**, on which starting over landed for half what patching cost and landed
nothing — and the failure the ceiling itself exists for, two fresh starts both
exhausting their rounds, has never been observed. So the mechanism is built and
off, and what changes the default is more runs in `doc/experiments/`
([0040](decisions/0040-rounds-bound-depth-restarts-bound-breadth.md) §4).

**`repair.maxAttempts`, `repair.fix` and `repair.on` are gone**, and a recipe
still carrying a `repair` block is **refused by name** rather than ignored —
`z.object` would have dropped it silently, leaving a repository running on a
default while its own file said otherwise. The two old ceilings do not add up to
the new one, so nothing migrates it for you.

### what Lingtai decides for itself

Not the recipe's, and each row says why.

| Constant | Value | What it decides | Why it is not a recipe key |
|---|---|---|---|
| `EVIDENCE_LINES` / `EVIDENCE_BYTES` (`packages/actions/src/command.ts`) | `60` lines / `8000` bytes | the log tail a failed command keeps as its evidence, with up to a quarter as many bytes again of its start, on top of the tail rather than out of it, when it does not all fit | it is written into `GateFailed.evidence` — an **event payload**. A recipe may decide what a run is told; it may not decide how much a project writes into a log that is never rewritten. `runtime.budget.evidence` then clips that tail again on the way into a prompt, and that is the bound that is about cost |
| `DEFAULT_RETENTION_DAYS` (`packages/projector/src/task-view.ts`) | `2` days | how long a landed task stays on the board — **a query, not a rebuild** | one board across every project, so no single recipe is the place to decide it. [0012](decisions/0012-one-task-view.md) settled the concept — *"Retention must not be in the projection, and this is the part that is easy to get wrong"* — and only the number was unrecorded |
| `BUFFER_BYTES` (`packages/actions/src/command.ts`) | `2000000` bytes | above this, older output is dropped **while the command is still running** | a runaway process can print faster than anything reads it. This bounds memory, not meaning |
| `RUN_LOG_MAX_BYTES` (`packages/agent/src/run-log.ts`) | `8000000` bytes | where a run's log file stops, saying so in itself on the line it stops at | it bounds a file on the operator's disk, not what a run is told or may spend. A trace line is about sixty bytes, so this is ~130,000 tool calls — the cap is not for the trace but for `#109`'s agent stream, which can be tens of megabytes for one run. Past this it stops being a file somebody opens to find out why a run failed ([0034](decisions/0034-the-run-log.md) §7) |
| `TRACE_LINE_CHARS` (`packages/agent/src/claude-code.ts`) | `4000` characters | where one line of the agent's own output stops, saying how much more there was | it bounds a line of a file, not what a run is told or may spend. `#109` put the agent's prose in the log and a single message has no bound; this is what keeps one runaway line from spending the whole of `RUN_LOG_MAX_BYTES` at once, and past a long paragraph more of it in the file is not more of it read. Nothing is lost: `sessionIdFor` makes the full transcript computable from a run id forever |

| `RUN_LOG_POLL_MS` (`packages/agent/src/run-log.ts`) | `250` ms | how often `lingtai attach` and the board's run-log stream look for more of the file | it is the cost of *reading* a log, which nothing about a project decides. There is no notification to wait on — 0034 chose a file over a socket precisely so that reading one needs nothing from the process that wrote it, and `tail -f` polls for the same reason. Under the threshold at which a person watching a scrolling log perceives a delay, and a pass that finds nothing costs one `read` returning zero bytes |
| `KEEP_LINES` (`apps/board/src/app/run-log.tsx`) | `2000` lines | how much of one run log the *browser* holds; the head is dropped, never the tail | it bounds a DOM node and nothing else. `RUN_LOG_MAX_BYTES` bounds the file, and eight megabytes in one `<pre>` is a tab that stops responding — a worse failure than showing less. `lingtai attach` has no such bound, because a terminal is a scrollback |
| `AGAIN_MS` / `AGAIN_MAX_MS` (`apps/board/src/app/run-log.tsx`) | `1500` ms doubling to `15000` ms, **never stopping** | how often the discussion box asks again for a turn's trace that has not been opened yet | it is the cost of an open tab, not of a project. A question asked with no daemon running is queued and answered when one starts (`answerOutstanding`), so the asking backs off rather than ending: a first attempt at #132 stopped after thirty seconds and told the reader the turn was dead, and a reader told that asks again and buys a second agent |
| `RUN_LOG_BEAT_MS` / `RUN_LOG_QUIET_MS` (`packages/agent/src/run-log.ts`) | `5000` ms, quiet past `15000` ms | how often the daemon answering a discussion touches the chat's trace, and how long untouched before the board says nothing is writing it | a trace a killed daemon left behind opens exactly like one being written, and the contents may not say which (0034 §8). The beacon cannot either: a `--no-conduct` daemon beats and answers nothing, and a page reads it once. Three missed beats, as `STALE_AFTER_MS` is for the beacon |
| `AGAIN_PATIENCE` (`apps/board/src/app/run-log.tsx`) | `5` asks, about 22 s | when the box stops saying *waiting for the daemon* and says *no daemon has started on this yet* | it changes a sentence and nothing else — the asking goes on. Far past the time a running daemon takes to open the file, so what is left is the likelier reading |

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
| what jumps it | `lingtai now`, and a pending repair (0025 §3) — neither is a *blind* retry, which is the only thing this guards against. Nothing buys a repair since `#143`, so the only pending one is an item the old code released for a repair before the deploy, and the next claim consumes it |
| what does not jump it | an ordinary release, however the run ended — and a retired `RepairRequested` a claim has already consumed |
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

## step — 10, closed forever

A step is a **place in the pass**, not a kind of check. The set may never grow.
It was five until 2026-09-23, when
[0058](decisions/0058-lingtai-is-a-development-pipeline.md) §3 widened it to the
ten a pass actually goes through: *the board cannot draw what the model does not
name*. Source: `Step` and `STEPS` in `packages/domain/src/events.ts`.

| Step | When | May refuse? | Built? |
|---|---|---|---|
| `claim` | the queue picks the item | no | not yet |
| `admit` | work starts on it; the worktree is cut here | nothing runs here — see the matrix below | not yet |
| `prepared` | after the worktree exists, before the agent starts | yes | yes |
| `design` | a document, before any code — or nothing, which is an answer | no | not yet |
| `implement` | one agent, in that worktree | no | not yet |
| `build` | the independent build of what was written | yes | not yet |
| `review` | reads the diff, returns findings, judges nothing | no | not yet |
| `proposed` | the agent stopped and there are commits — a change has been proposed | yes | yes |
| `merge` | after `proposed` passes, before the merge lane | yes | yes |
| `end` | the work item reached any terminal outcome | **no** | yes |

`prepared` and `proposed` run the recipe's actions; `merge` holds when a `human`
action asks or when `--no-merge` does; `end` runs too, its actions being effects
rather than verdicts. The conductor calls GitHub and appends the outcome; what
did not land, `reconcile` converges ([0022](decisions/0022-the-seams.md)) —
durability is convergence here, not a queue.

**Six of the ten are empty here and empty everywhere, and that is what the last
column is for.** Nothing constructs a pipeline for `claim`, `admit`, `design`,
`implement`, `build` or `review`, so an action declared at one is refused when
the recipe resolves rather than accepted and skipped (`#61`). Today's build and
review run as actions at `proposed`, and today's implementing agent is
dispatched by `run-once.ts` directly. They are all ten steps regardless — the
closed set is about the places in the pass, not about what is built today — and
naming them is what lets the log, the recipe and the board say where a pass is.
Building them is 0058's own plan ([the-pipeline](design/the-pipeline.md)).

`proposed` was called `diff` until
[0018](decisions/0018-the-proposed-point.md); stored events are upcast on read.

## retired name — 4 words, and an allowlist that may only shrink

**This is the one section that describes code the repository is still moving
away from.** Everything else here says what is true; this says what is *not* and
has not finished being untrue. The pipeline epic
([the-pipeline](design/the-pipeline.md)) renames the vocabulary over several
tickets, and a rename spread over several tickets ends as two vocabularies for
one thing unless something counts — which is
[0058](decisions/0058-lingtai-is-a-development-pipeline.md) §Context's own
defect. `packages/domain/unit/retired-names.test.ts` reads the tables below out
of this file and holds the code to them.

### the words

Matched as **whole words inside a token**, never as substrings — so `checkpoint`,
`checkpoints`, `pointer` and `pointed` are untouched, because none of them
splits into a word that is on this list. That is the whole reason this is a list
of words rather than a regex over `point`.

| retired | current | decided by |
|---|---|---|
| `gate` | `step` | [0058](decisions/0058-lingtai-is-a-development-pipeline.md) §3 |
| `gates` | `steps` | [0061](decisions/0061-the-recipe-is-the-pipeline.md) §1 — *`gates:` is gone, not renamed, replaced* |
| `point` | `step` | [0058](decisions/0058-lingtai-is-a-development-pipeline.md) §3 |
| `points` | `steps` | [0058](decisions/0058-lingtai-is-a-development-pipeline.md) §3 |

And two tokens whose replacement is **not** the word substitution, so a renamer
reading the four rows above would get them wrong. Both are already caught by
`gate`; these rows say what to put in their place:

| retired | current | decided by |
|---|---|---|
| `GatePoint` | `Step` | [0058](decisions/0058-lingtai-is-a-development-pipeline.md) §3, landed as `#227` |
| `GateAction` | `Plugin` | [0061](decisions/0061-the-recipe-is-the-pipeline.md) §2 — a step is a list of plugins, and the plugin is the key |

**Where it is enforced:** every `.ts`, `.tsx` and `.css` under
`{apps,packages}/*/src/` — identifiers, types, event types, recipe keys, a
stylesheet's class selectors, and the strings and JSX a person reads: the
board's copy, a refusal's text, `lingtai`'s output. **A module
specifier is one of those strings**, and deliberately: eight files under `src/`
carry a retired word in their own name — `gate.ts`, `agent-gate.ts`,
`gate-audit.ts`, `gates-resolved.ts`, `end-point.ts` among them — each renamed
by the ticket that renames what is inside it, and `./gate.ts` in an import is
the only place the ledger can count that. `packages/actions/src/index.ts`'s
`gate` ×5 is five re-export lines and no identifier at all.

**A recipe key is enforced through the schema that declares it**, which is
`packages/recipe/src/recipe.ts` and is read like any other file; no `.yml` or
`.yaml` is. The repository's own `.lingtai/config.yaml` is not read and nothing
is lost by that — nothing reads it either ([0046](decisions/0046-lingtai-is-personal.md)
§3: the recipe is `~/.lingtai/<project>/recipe.yml`, outside every worktree),
and a key the schema does not declare is refused by name before it reaches
anything.

**Where it is not**, and there are four of them: comments; everything under
`doc/`; everything outside `{apps,packages}/*/src/`, which is the two test
halves, `scripts/`, `prompts/` and every config file; and, inside `src/`, every
other extension and everything in a stylesheet that is not a selector.

**The first two are the ticket's.** A comment or a document describing *history*
keeps the name that history happened under —
[0018](decisions/0018-the-proposed-point.md) records that the point called
`diff` became `proposed`, and
[0059](decisions/0059-a-point-carries-only-the-kinds-it-runs.md) says *`#58` was
that bug at `merge`*; both are correct and both must keep their words. Nothing
mechanical can tell a comment about the past from a comment about the present,
so the test reads neither. **A comment describing what the code does now takes
the new name** — that rule is a reviewer's, not a test's.

**The third is a boundary and not an oversight**, and the tests are the part of
it worth arguing — because what stands there is **larger than the table below**,
and describing it as a straggler or two is how somebody ticks the epic's last
box over work nobody did. The same rule run over
`{apps,packages}/*/{unit,integration,test}/` reads **at most 1424 occurrences in
78 files**, counted 2026-09-23, across 51 distinct tokens, of which the six
largest are `gate` ×428, `gates` ×268, `point` ×168, `points` ×95, `GatePassed`
×49 and `GateFailed` ×48. `GATE_CARRYING` in
`packages/domain/unit/upcast.test.ts` and `GateCheckPassed` in
`apps/board/unit/run-recipe.test.tsx` are two of those 1424 — locals a rename of
`src/` does not reach, and the two a reader meets first, which is exactly why
naming them and stopping reads as the whole of it. They are
out because a name that survives only in a test is one no
operator reads and no shipped code calls, and because a test names the thing it
tests: `gate-matrix.test.ts` is the test of a matrix that is still called that,
and it is renamed by the ticket that renames the matrix rather than ahead of it.
**So `#233`'s acceptance is about `src/`**, and sweeping the halves is a ticket
of its own — not a grep on the day the last row here goes.

**`at most`, and the test holds that number to the halves.** They are outside
the ledger on purpose, so pinning them exactly would red the `build` gate on
every diff that adds a test to anything this epic renames. What may not happen
is this sentence saying **less** than the halves carry, because it is what a
reader sizes the sweep from — the understatement is the failure, and it is the
direction that is checked, along with *larger than the table below*. The scope
is checked rather than described too: the test asserts that what it reads for
violations is exactly `{apps,packages}/*/src/`, so it cannot widen or narrow
without going red.

**The fourth is inside `src/`, and it was a hole before it was a boundary.**
`apps/board/src/app/globals.css` sits in the region named above and says
`.point`, `.points`, `.sgate` and `.actpoint` — the same words the `className`s
beside it say — so a rule reading only `.ts` and `.tsx` would have let `#233`
report `0 occurrences in 0 files` over a stylesheet still naming the retired
concept, with every one of those classes by then matching nothing in the TSX.
Two vocabularies and a rule matching nothing, under a green gate: 0058
§Context's own defect, arriving through the door this ledger exists to shut. So
a stylesheet's **class selectors** are read and counted like any other token.
Its declarations are not — `cursor: pointer` and `1080px` are a language nobody
here renames — and out with them goes every other extension under `src/`, which
today is `packages/event-store/src/prisma/contract.prisma` and the
`contract.json` beside it: generated from a schema, renamed with it, and saying
`checkpoints` and nothing else of ours. The extensions the rule reads are
asserted to be exactly those three, so widening or narrowing that is a red test
too — **and those two files are asserted by name**, which is the other half and
not the same assertion: an extension the rule does not read is filtered out
before anything counts it, so a third file arriving here would be as silent as
`globals.css` was until a `.scss` under `src/` reds this sentence rather than
slipping under it.

### the glued tokens

**A retired word glued to a letter is not a word, and the rule above cannot see
it.** `words("sgate")` is `["sgate"]`, which is on no list, so the same
whole-word match that leaves `checkpoint` alone leaves `className="sgate"` alone
with it — three times in the board's standing block, once more as `actpoint` on
the task page, and once each in the stylesheet that styles them. Both are the
retired concept behind a prefix, and both are on a page an operator reads.

| token | current | what it is |
|---|---|---|
| `sgate` | `sstep` | the standing block's line for what decided, and for what it refused verbatim |
| `actpoint` | `actstep` | the point column of an action's row on the task page |

**This door only opens inwards**, which is what makes it unlike the one below.
A row here can add a violation and can excuse none: every occurrence it catches
costs a count in the allowlist and raises the number above it, in the same diff.
What a row may not do is name a token the four words already reach — that would
be a second spelling of a rule that exists — or name one of `checkpoint`,
`checkpoints`, `pointer` and `pointed`, which is the substring ban coming back
in through the side. Both are cases in
`packages/domain/unit/retired-names.test.ts`, and the pair is pinned there as
the four words are.

### not the retired name

Two tokens contain one of the four words and mean something else. Each is
exempt **by name and in one file**, reviewed once, rather than by a pattern —
or by a bare token — that would exempt more than it was shown:

| token | where | what it is |
|---|---|---|
| `pointShim` | `apps/cli/src/install.ts` | *point the shim at a version* — the English verb. Nothing to do with a step |
| `entryPoints` | `apps/release/src/build.ts` | esbuild's own option. Not ours to rename |

**This table is a second door into the debt, and it is bolted differently.** An
exemption is not a row in a ledger, it is a `continue` before the match — so one
row added here excuses its token everywhere at once and nothing underneath it
moves: the allowlist does not grow, the count below does not change, and a
brand-new retired name is green in every file at once. That is the one edit
to this section a reader cannot size by reading it, so the pair in each row is
pinned in `packages/domain/unit/retired-names.test.ts` as the four words are,
and the file column is enforced: a row added, dropped or widened to a second
file is a red test, and `pointShim` in any file but `install.ts` is a violation
like any other.

**Neither token is one of the four words spelled out**, and that is the property
that keeps this door small. `pointShim` cannot be a step hiding behind an
exemption, because a step is spelled `point`; excusing the bare word `point` in
a file would excuse the step there too, which is why no row here does, and why
the English residue below is *listed* rather than excused.

`checkpoint`, `checkpoints`, `pointer` and `pointed` are **not on this list and
do not need to be** — whole-word matching never reaches inside them. They are
what a substring ban on `point` would have destroyed: 55, 34, 17 and 29
occurrences of the projector's and the installer's own vocabulary, as `#232`
counted them on 2026-09-22. What the rule actually reads of them is smaller and
uneven, and the test follows that rather than the grep: on 2026-09-23
`checkpoint` was read 9 times in 7 files and `checkpoints` 22 in 5, so those two
are asserted to be live subjects — the assertion is *read at all*, not read that
many times, so the numbers here are a measurement and not a claim the test
holds. `pointer` is read **nowhere** (all 17 are comments) and `pointed` is read
only as the one local `install.ts:465` declares, so neither is — an assertion
resting on a single
local is a red `build` gate the day somebody renames it, on a diff that
introduces no retired name. What is asserted of all four, live or not, is that
the rule does not flag them.

### the allowlist

**1079 occurrences in 77 files, counted 2026-09-23** — and that sentence is
counted by the test rather than remembered, so it is the size of the table below
and not a number somebody forgot to lower when the table shrank. The rest of the
epic empties the table: a ticket that renames its area deletes its rows and
corrects that number, and that is the whole of the ceremony.

Each row is one file, every retired token still in it, and **how many times the
rule reads that token there**. The count is the entry and not decoration: a
ledger of *distinct* names cannot see a second `gate` arrive in a file that
already says `gate`, and every file this epic will touch already says it once.
Keyed by name alone, `export const gate = "…the gate failed"` appended to
`run-once.ts` — a new identifier and a new operator-facing string — is a name
already recorded in a file already listed, and lands with nothing written down
anywhere and no number moved.

**The table is not a subset of the debt, it is exactly what the rule reads**:
the test computes the same counts from `src/` and asserts they are these, so **a
count too high is as red as a count too low**. A rename that landed and left its
ledger standing is how *align the terms* becomes a sentence everybody agrees
with and the last ticket discovers is untrue; a use added under a name already
in the table is the same failure read from the other side.

**So a retired name cannot arrive quietly, and what stops it is that there is
nowhere quiet to put it.** One added to `src/` — a new name, or one more use of
an old one — is red until this table says so, and saying so makes the sentence
above it false until the number is raised too: two edits in this document, in
one diff, one of them a line that says what it is counting. **The test is what
makes that number true; a review is what makes it go down.** That division is
the honest one: no test can tell a retired name that had to arrive from one that
did not, and a test that claimed to would be refusing the diff that fixes
something.

**The baseline is this table, and there is deliberately no second copy of it in
the test.** The other design reads better than it works — freeze today's
`file → tokens` in the test file and refuse any pair it does not hold — because
**this epic renames files**, by construction: eight files under `src/` say a
retired word in their own name, `gate.ts`, `agent-gate.ts`, `gate-audit.ts`,
`gates-resolved.ts` and `end-point.ts` among them, and every one of them is
renamed by the ticket that renames what is inside it. A frozen copy keyed by
path reads a file that moved or was renamed as a widening that did not happen,
and the only way back to green is to hand-edit
the one table whose edits were supposed to be expensive — teaching, on the
epic's ordinary path, exactly the habit it was added to prevent. Here a file
that moves costs what any move costs: its row is edited, in the ledger a person
is already reading, and nothing else moves.

**`0 occurrences in 0 files` passes.** That is `#233`'s acceptance, and a test
with a lower bound under it would red the `build` gate on the diff that finishes
the job. Nothing guards against this table being read as empty by mistake,
because nothing has to: while any debt is left in `src/` an empty parse fails
the equality above, and when none is left an empty table is the truth.

| file | retired names in it |
|---|---|
| `apps/board/src/app/backlog/page.tsx` | `gate` ×1 |
| `apps/board/src/app/evidence.tsx` | `GateEvidence` ×3 · `gate` ×4 · `gates` ×3 |
| `apps/board/src/app/globals.css` | `actpoint` ×1 · `point` ×7 · `points` ×2 · `sgate` ×1 |
| `apps/board/src/app/page.tsx` | `gate` ×2 · `gatesApproved` ×2 · `gatesFailed` ×4 · `gatesPassed` ×2 · `gatesWaived` ×2 · `points` ×2 |
| `apps/board/src/app/plan.tsx` | `point` ×4 · `points` ×2 |
| `apps/board/src/app/rail.tsx` | `PointProgress` ×5 · `PointState` ×2 · `point` ×11 · `pointOf` ×2 · `points` ×9 |
| `apps/board/src/app/recipe/[project]/page.tsx` | `point` ×1 |
| `apps/board/src/app/setup/wizard/finish.ts` | `wholeGates` ×2 |
| `apps/board/src/app/setup/wizard/wizard.tsx` | `gates` ×4 |
| `apps/board/src/app/standing.tsx` | `gate` ×4 · `sgate` ×3 |
| `apps/board/src/app/task/[id]/page.tsx` | `actpoint` ×1 · `gate` ×2 · `gates` ×6 · `point` ×4 · `points` ×3 |
| `apps/board/src/lib/board.ts` | `GatePlan` ×4 · `gates` ×1 · `gatesApproved` ×4 · `gatesFailed` ×4 · `gatesPassed` ×4 · `gatesWaived` ×4 |
| `apps/board/src/lib/history.ts` | `GateDidNotFinish` ×1 · `GateFailed` ×1 · `GateNeverRan` ×1 · `GatePassed` ×1 · `GateRequested` ×1 · `GateStarted` ×1 · `GateWaived` ×1 · `GatesResolved` ×1 · `gate` ×3 · `gateAt` ×12 · `points` ×6 |
| `apps/board/src/lib/progress.ts` | `GateDidNotFinish` ×1 · `GateFailed` ×1 · `GateNeverRan` ×1 · `GatePassed` ×1 · `GatePlan` ×3 · `GateRequested` ×1 · `GateStarted` ×1 · `GateWaived` ×1 · `GatesResolved` ×1 · `PointProgress` ×2 · `PointState` ×7 · `gate` ×4 · `point` ×12 · `pointOf` ×1 · `points` ×6 |
| `apps/board/src/lib/queued.ts` | `GatePlan` ×2 · `PlannedPoint` ×2 · `point` ×4 · `points` ×2 |
| `apps/board/src/lib/recipe.ts` | `GateAction` ×8 · `GatesResolved` ×1 · `gates` ×2 · `point` ×3 · `points` ×1 |
| `apps/board/src/lib/task.ts` | `GateDidNotFinish` ×1 · `GateFailed` ×1 · `GateNeverRan` ×1 · `GatePassed` ×1 · `GatePlan` ×3 · `GateRequested` ×1 · `GateStarted` ×1 · `GateVerdict` ×4 · `GateWaived` ×1 · `GatesResolved` ×1 · `gate` ×12 · `gates` ×11 |
| `apps/cli/src/backlog.ts` | `gate` ×1 |
| `apps/cli/src/conduct.ts` | `gate` ×1 |
| `apps/cli/src/doctor.ts` | `GatesResolved` ×1 · `endPointRan` ×3 · `gate` ×6 · `gates` ×3 · `point` ×3 · `points` ×1 |
| `apps/cli/src/end.ts` | `gates` ×1 |
| `apps/cli/src/install.ts` | `points` ×3 |
| `apps/cli/src/lingtai.ts` | `gate` ×2 · `gates` ×4 · `point` ×2 |
| `apps/cli/src/restart.ts` | `gates` ×1 |
| `apps/cli/src/service.ts` | `gates` ×1 · `point` ×1 |
| `apps/cli/src/status.ts` | `gates` ×1 |
| `apps/site/src/lib/snapshot.ts` | `gates` ×1 |
| `packages/actions/src/agent-gate.ts` | `AgentGateDeps` ×2 · `AgentGateSpec` ×3 · `Gate` ×2 · `GateContext` ×2 · `GateFinding` ×8 · `GateResult` ×2 · `createAgentGate` ×1 · `gate` ×1 · `point` ×1 |
| `packages/actions/src/from-recipe.ts` | `AgentGateDeps` ×2 · `Gate` ×2 · `GateAction` ×2 · `GateActionUnavailableError` ×7 · `GateDeps` ×2 · `WatchGateDeps` ×2 · `createAgentGate` ×2 · `createHumanGate` ×2 · `createProcessGate` ×2 · `createWatchGate` ×2 · `gate` ×5 · `gates` ×1 · `gatesFromRecipe` ×4 · `point` ×11 · `wrongPoint` ×3 |
| `packages/actions/src/gate.ts` | `Gate` ×2 · `GateContext` ×3 · `GateDidNotFinish` ×3 · `GateEvent` ×2 · `GateFailed` ×3 · `GateFinding` ×4 · `GateNeverRan` ×3 · `GatePassed` ×3 · `GateRequested` ×3 · `GateResult` ×3 · `GateStarted` ×3 · `GateVerdict` ×3 · `gate` ×19 · `gates` ×7 · `point` ×4 · `runGatePipeline` ×1 |
| `packages/actions/src/human-gate.ts` | `Gate` ×2 · `GateContext` ×2 · `GateResult` ×2 · `HumanGateSpec` ×2 · `createHumanGate` ×1 · `gate` ×1 |
| `packages/actions/src/index.ts` | `AgentGateDeps` ×1 · `AgentGateSpec` ×1 · `Gate` ×1 · `GateActionUnavailableError` ×1 · `GateContext` ×1 · `GateDeps` ×1 · `GateEvent` ×1 · `GateFinding` ×1 · `GateResult` ×1 · `GateVerdict` ×1 · `HumanGateSpec` ×1 · `ProcessGateSpec` ×1 · `WatchGateDeps` ×1 · `WatchGateSpec` ×1 · `createAgentGate` ×1 · `createHumanGate` ×1 · `createProcessGate` ×1 · `createWatchGate` ×1 · `gate` ×5 · `gatesFromRecipe` ×1 · `runGatePipeline` ×1 |
| `packages/actions/src/process-gate.ts` | `Gate` ×2 · `GateContext` ×2 · `GateResult` ×2 · `ProcessGateSpec` ×2 · `createProcessGate` ×1 · `gate` ×1 |
| `packages/actions/src/watch-gate.ts` | `Gate` ×2 · `GateContext` ×2 · `GateResult` ×2 · `WatchGateDeps` ×2 · `WatchGateSpec` ×2 · `createWatchGate` ×1 · `gate` ×1 · `gates` ×1 |
| `packages/conductor/src/approve.ts` | `GateAction` ×2 · `GateWaived` ×4 · `GatesResolved` ×2 · `gate` ×15 · `gates` ×3 · `gatesPassed` ×1 · `point` ×1 · `points` ×1 · `splitGate` ×4 |
| `packages/conductor/src/attempts.ts` | `GateDidNotFinish` ×2 · `GateFailed` ×3 · `GateNeverRan` ×2 · `GatePassed` ×1 · `GateStarted` ×3 · `GateWaived` ×1 · `gate` ×5 |
| `packages/conductor/src/attribution.ts` | `gate` ×3 |
| `packages/conductor/src/backlog.ts` | `gate` ×3 |
| `packages/conductor/src/close.ts` | `GateAction` ×2 · `gates` ×1 · `point` ×1 |
| `packages/conductor/src/create-app.ts` | `point` ×2 |
| `packages/conductor/src/end-point.ts` | `GateAction` ×3 |
| `packages/conductor/src/filter.ts` | `GatePlan` ×3 · `gatePlan` ×2 · `gates` ×1 · `point` ×3 |
| `packages/conductor/src/fix.ts` | `GateFinding` ×10 · `gates` ×1 · `point` ×4 |
| `packages/conductor/src/gate-audit.ts` | `GateDidNotFinish` ×1 · `GateFailed` ×1 · `GateNeverRan` ×1 · `GatePassed` ×1 · `GateRequested` ×1 · `GateStarted` ×1 · `GateWaived` ×1 · `gate` ×2 · `point` ×1 · `points` ×4 |
| `packages/conductor/src/gates-resolved.ts` | `gate` ×3 · `gates` ×1 · `gatesResolved` ×1 · `points` ×1 |
| `packages/conductor/src/index.ts` | `GatePlan` ×1 · `gate` ×1 · `gatePlan` ×1 · `point` ×1 |
| `packages/conductor/src/labels.ts` | `gates` ×1 |
| `packages/conductor/src/never-started.ts` | `gate` ×6 |
| `packages/conductor/src/onboard.ts` | `gates` ×3 · `point` ×3 |
| `packages/conductor/src/run-once.ts` | `GateFinding` ×5 · `GatesResolved` ×2 · `gate` ×42 · `gateDeps` ×4 · `gateDetail` ×1 · `gateDidNotFinish` ×3 · `gates` ×16 · `gatesFromRecipe` ×4 · `gatesPassed` ×1 · `gatesResolved` ×2 · `gitForGates` ×3 · `point` ×8 · `runGatePipeline` ×4 |
| `packages/conductor/src/schedule.ts` | `gate` ×1 |
| `packages/conductor/src/wizard-page.ts` | `GateAction` ×6 · `gates` ×36 · `wholeGates` ×1 |
| `packages/conductor/src/wizard.ts` | `gates` ×2 |
| `packages/daemon/src/control.ts` | `gates` ×1 |
| `packages/daemon/src/converge.ts` | `point` ×1 |
| `packages/domain/src/backlog.ts` | `gate` ×2 |
| `packages/domain/src/events.ts` | `GateDidNotFinish` ×3 · `GateFailed` ×3 · `GateNeverRan` ×2 · `GatePassed` ×3 · `GateRequested` ×3 · `GateStarted` ×3 · `GateWaived` ×3 · `GatesResolved` ×3 · `gate` ×3 · `gateBase` ×11 · `points` ×1 |
| `packages/domain/src/run.ts` | `GateDidNotFinish` ×2 · `GateFailed` ×2 · `GateFinding` ×2 · `GateNeverRan` ×2 · `GatePassed` ×2 · `GateRequested` ×3 · `GateStarted` ×1 · `GateState` ×5 · `GateVerdict` ×2 · `GateWaived` ×2 · `gate` ×28 · `gates` ×13 · `gatesOn` ×1 · `withGate` ×10 |
| `packages/domain/src/streams.ts` | `gates` ×1 |
| `packages/domain/src/upcast.ts` | `GateDidNotFinish` ×1 · `GateFailed` ×1 · `GatePassed` ×1 · `GateRequested` ×1 · `GateStarted` ×1 · `GateWaived` ×1 · `GatesResolved` ×1 · `gate` ×11 · `gatePointRenamed` ×9 · `points` ×6 |
| `packages/env/src/colour.ts` | `gates` ×1 |
| `packages/env/src/index.ts` | `Point` ×1 |
| `packages/event-store/src/index.ts` | `PointNeverRan` ×1 |
| `packages/event-store/src/log.ts` | `PointNeverRan` ×1 |
| `packages/event-store/src/queries.ts` | `GatesResolved` ×2 · `PointNeverRan` ×2 · `gate` ×12 · `point` ×7 · `points` ×2 |
| `packages/event-store/src/sqlite.ts` | `GatesResolved` ×2 · `gate` ×10 · `point` ×7 · `points` ×2 |
| `packages/projector/src/backlog.ts` | `GatePassed` ×2 · `gate` ×6 |
| `packages/projector/src/postgres.ts` | `gate` ×2 · `gates` ×3 · `gatesApproved` ×1 · `gatesFailed` ×1 · `gatesPassed` ×1 · `gatesWaived` ×1 |
| `packages/projector/src/sqlite.ts` | `gate` ×2 · `gates` ×3 · `gatesApproved` ×1 · `gatesFailed` ×1 · `gatesPassed` ×1 · `gatesWaived` ×1 |
| `packages/projector/src/task-view.ts` | `GateDidNotFinish` ×2 · `GateFailed` ×2 · `GateNeverRan` ×2 · `GatePassed` ×2 · `GateWaived` ×2 · `gate` ×4 · `gates` ×5 · `gatesApproved` ×1 · `gatesFailed` ×1 · `gatesPassed` ×1 · `gatesWaived` ×1 · `point` ×2 · `setGate` ×2 |
| `packages/recipe/src/local.ts` | `gates` ×8 · `gatesRefusal` ×3 · `point` ×2 |
| `packages/recipe/src/presets.ts` | `gates` ×6 |
| `packages/recipe/src/propose.ts` | `gates` ×1 |
| `packages/recipe/src/recipe.ts` | `GateAction` ×5 · `GateMap` ×4 · `GatesResolved` ×1 · `gates` ×1 · `point` ×18 |
| `packages/recipe/src/resolve.ts` | `gates` ×5 |
| `packages/recipe/src/watch.ts` | `gate` ×9 |
| `packages/repo/src/integrate.ts` | `gate` ×3 · `gateDetail` ×2 · `gatesPassed` ×2 |

### ordinary English

**9 of those 1079 occurrences are the English word and not the retired
term**, and nothing mechanical can tell them apart: `points at` in the installer
is the same verb `pointShim` is exempted for ten lines below it. They are the
reason `0 occurrences in 0 files` is **not** reached by renaming alone — for
every other row it is, and for these nine it is nine sentences reworded, one
word each, in copy that is correct as it stands. They are written down here so
that `#233` inherits them as a known nine rather than discovering them as a
table that will not empty.

**They are named here and excused nowhere.** An exemption row is keyed by token
and file, and in `lingtai.ts` the same spelling is both — the `end` point on
line 180, the English verb on line 249 — so excusing the token there would
excuse the step with it, which is what the table above is bolted shut against.
So these stay in the allowlist, counted with everything else; this table only
says which of those counts a rename will not reach. The test holds it to the
allowlist: every row must name a file and token the allowlist carries, with a
count no larger than the allowlist's.

| file | token | of which English | the sentence |
|---|---|---|---|
| `apps/board/src/app/recipe/[project]/page.tsx` | `point` | 1 of 1 | *…and that is the point rather than an omission* |
| `apps/cli/src/install.ts` | `points` | 3 of 3 | *the shim still points at …*, and twice more of the same verb |
| `apps/cli/src/lingtai.ts` | `point` | 1 of 2 | *point ~/.local/bin/lingtai at an older version*. The other is *the end point* |
| `apps/cli/src/service.ts` | `point` | 1 of 1 | *The whole point. Crash, logout, sleep — it comes back*, in the launchd plist |
| `packages/actions/src/agent-gate.ts` | `point` | 1 of 1 | *That is the point: this exists because self-review …*, in the reviewer's prompt |
| `packages/conductor/src/create-app.ts` | `point` | 2 of 2 | *would point .env.local at an id no repository has installed*, and one more |


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

The last two carry `when:` (`landed` / `blocked` / `failed` / `closed` / `any`), because
`end` fires on *every* terminal outcome. "Close it when it lands, label it when
it is blocked" is one configuration rather than two mechanisms. Putting either
at a gating point is refused by name — a gate that silently did nothing would be
worse. Which kind may be at which point is the matrix below, and every cell in
it answers one way or the other.

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

## step × kind — the 60 cells, and which of them run

Not every kind runs at every step, and for a year ten of the cells said
neither yes nor no: an action there was accepted by the schema, resolved into
`GatesResolved`, printed by `lingtai add`, drawn on the board — and never
called (`#61`). `merge` was a sixteenth until `#58` built its pipeline. **The
set is two-valued now**: a cell runs, or the recipe does not resolve and the
refusal names the action, its kind, the step and why.

It was thirty cells until the vocabulary went to ten names. **Forty-nine of the
sixty are refusals** — count the ✋ in the table below, which is what
`whyNoKindAt` answers for every cell but the eleven that run. Thirty-six of the
forty-nine are the six steps with no call site, and they are the interesting
ones: that is the same two-valued rule and not an exception to it, because
**naming a step is not building it**, and a `design:` block a recipe could
write and nothing would run is `#61` with a new spelling.

Source: `KINDS_AT` and `whyNoKindAt` in `packages/recipe/src/recipe.ts`. This
table is checked against that constant, cell for cell, by
`packages/conductor/unit/gate-matrix.test.ts` — the copy in `#61`'s own body
was wrong about `merge` within three weeks of being written, so a copy nothing
checks is not worth having.

✅ runs · ✋ refused when the recipe resolves, by name

| | `run:` | `agent:` | `watch:` | `human:` | `close:` | `labels:` |
|---|---|---|---|---|---|---|
| `claim` | ✋ | ✋ | ✋ | ✋ | ✋ | ✋ |
| `admit` | ✋ | ✋ | ✋ | ✋ | ✋ | ✋ |
| `prepared` | ✅ | ✋ | ✋ | ✋ | ✋ | ✋ |
| `design` | ✋ | ✋ | ✋ | ✋ | ✋ | ✋ |
| `implement` | ✋ | ✋ | ✋ | ✋ | ✋ | ✋ |
| `build` | ✋ | ✋ | ✋ | ✋ | ✋ | ✋ |
| `review` | ✋ | ✋ | ✋ | ✋ | ✋ | ✋ |
| `proposed` | ✅ | ✅ | ✅ | ✅ | ✋ | ✋ |
| `merge` | ✅ | ✅ | ✅ | ✅ | ✋ | ✋ |
| `end` | ✋ | ✋ | ✋ | ✋ | ✅ | ✅ |

Where each row comes from:

```
prepared    run-once.ts   gatesFromRecipe("prepared", …, { env })    an environment, and nothing else
proposed    run-once.ts   gatesFromRecipe("proposed", …, gateDeps)   every dependency
merge       run-once.ts   gatesFromRecipe("merge",    …, gateDeps)   every dependency   ← #58
end         end-point.ts  resolveEndActions                          the two effects
claim       —             no pipeline is constructed anywhere
admit       —             no pipeline is constructed anywhere
design      —             no pipeline is constructed anywhere        ← 0058 §3, not yet built
implement   —             no pipeline is constructed anywhere        ← run-once.ts dispatches the agent directly
build       —             no pipeline is constructed anywhere        ← today a `run:` action at `proposed`
review      —             no pipeline is constructed anywhere        ← today an `agent:` action at `proposed`
```

**Every ✋ is a fact about the step, not about the caller.**

- **`admit` carries nothing.** No code reaches it, so an action there would be
  resolved, printed and never called. The point stays in the closed set and the
  day something runs a pipeline there its row grows — but a recipe may only say
  what today's code does. A question that must be asked *before* anything is
  spent is `lingtai ask`, which holds the item in the queue and is answered
  without a worktree ([`ask.ts`](../packages/conductor/src/ask.ts)).
- **`prepared` is narrower than `proposed`, and this is where that is written
  down.** Nothing has been committed yet, so `agent:` would be handed no diff to
  read and `watch:` no file list to match — it is a point before a change
  exists, not a point missing a dependency. `human:` is refused for a different
  reason and a sharper one: a hold there is turned into a *release* back to the
  queue, so the person would be asked a question that re-asks itself — and pays
  for a worktree and an install — on every pass, and can never be answered. Ask
  before the claim, or at `proposed`, where there is a diff to approve.
- **The five steps 0058 §3 named carry nothing yet**, and each refusal says
  where that work is done today instead — the queue's filter for `claim`, the
  issue body for `design`, `run-once.ts`'s own dispatch for `implement`, and
  the `proposed` point's actions for `build` and `review`. The refusal is the
  half an operator can act on; *nothing runs here* on its own is a recipe key
  and no next move.
- **`end` produces no verdict**, so the four kinds that produce one have nothing
  to be there. Its two carry `when:`, which is how one step serves every
  terminal outcome.
- **`close:` and `labels:` at a step that decides** are effects rather than
  verdicts, and only `end` carries out effects. This is the direction the
  codebase already got right, and its wording is the argument for the rest:
  *an action that is silently absent is worse than a run that will not start.*

The refusal arrives when the recipe resolves — so `lingtai doctor`, `lingtai
add` and the first moment of a pass all name it, before a ticket is claimed or
an install paid for. `gatesFromRecipe` asks the same table again for a caller
that builds actions in code rather than reading a recipe.

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
    run: node packages/telegram/src/cli.ts
    env: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
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

Since `#123` this binds a subscriber as well as a `run:` at a gate point: the
daemon starts what the recipes declared and hands each one exactly the names
beside it.

## what the log says was *supposed* to happen

`GatesResolved`, one per run, appended before anything is claimed. It names all
ten steps and the ordered actions resolved for each — empty arrays included.

**Ten is the schema's assertion and not a description of it**: `points` is
`.length(10)` (`packages/domain/src/events.ts`), pinned by *refuses a plan that
is not all ten steps* in `packages/domain/unit/upcast.test.ts`. It was five
until 2026-09-23, and it moved the way every field here moves — `schemaVer: 4`
and a `3 → 4` step, which widens a stored five-step plan and gives the five the
vocabulary did not have the `[]` those runs were in fact given. [0061](decisions/0061-the-recipe-is-the-pipeline.md)
§7's reset ([the-pipeline](design/the-pipeline.md)'s T5) would have spent that
history instead, and it has not run: a widening that waits for it refuses every
plan in the store in the meantime, and `Too small: expected array to have
exactly 10 items` — raised from `parsePayload`, rethrown unwrapped by
`decodeRow` with no type, stream or seq on it — would be what a projector stops
on for ever. The step dies at the reset with the other nine.

Without it the log could not distinguish "nothing was configured here" from
"this point does not exist", because `ProjectConfigured` carries a config *hash*
and not the configuration. That distinction is what [ADR 0016](decisions/0016-the-settled-model.md)
§4 rests on: an unconfigured gate is skipped and that is the user's call; a gate
that *was* configured and did not run is Lingtai's bug, and comparing this
event to the verdicts that follow is how the second becomes detectable.

## tier — 3

`open` · `guarded` · `sandboxed`. Source: `Tier` in `packages/domain/src/events.ts:50`.

A tier names what a runtime can be asked to do, not a policy on the tools —
containment is the worktree and the filtered environment, at every tier.
Source: `meetsTier` and `missingForTier` in `packages/agent/src/runtime.ts`.

| tier | the runtime… | refused as |
|---|---|---|
| `open` | runs the agent | — |
| `guarded` | honours a refusal from the lifecycle hook Lingtai installs on the prompt — `UserPromptSubmit` exiting 2 stops the run (`canFailClosed`) — so a hook that cannot reach the conductor stops the run at its first prompt rather than let it record nothing. A runtime whose `UserPromptSubmit` can only notify does not qualify. Not a guard on the tools: no hook runs before a tool use (`PreToolUse` is not wired, and `PostToolUse` fires after the tool ran), and Lingtai refuses no tool call ([ADR 0016](decisions/0016-the-settled-model.md) §6) | `pre-tool-use-interception`, a name kept from before 0016 |
| `sandboxed` | also enforces a filesystem boundary of its own | `filesystem-sandbox` |

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

## integration refusal reason — 8

Why a merge did not happen. Source: `RefusalReason` in `packages/domain/src/events.ts:86`.

`conflict` · `dirty-base` · `unpushed-base` · `pending-migration` ·
`gate-failed` · `no-commits` · `push-rejected` · `lane-busy`

`lane-busy` is **read and never written** since #194: the merge lane took a lock
and told the loser this, and git's rejected push — `push-rejected` — is what
tells it now. The value stays because events on the log carry it.

A `push-rejected` on the log is a base that beat this merge **four times**
(`LOST_PUSHES`, `packages/repo/src/integrate.ts`). A single lost race says
nothing: the lane answers it itself, by merging against the base where it now is
and pushing again, and the whole run of pushes is one `IntegrationAttempted` and
one terminal. That is on purpose — an `IntegrationRefused` reaches the `desktop`
subscriber as *did not merge* and wakes a queue pass, and a race the lane goes on
to win is neither.

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

The board and the task page draw **all ten steps**, always, marking an empty
one `skipped` rather than leaving it out — `Segs` in `apps/board/src/app/rail.tsx`,
over `foldProgress` in `apps/board/src/lib/progress.ts`, which folds
`GatesResolved` against the verdicts that followed. A step not reached yet is
`pending`; one configured, recorded nothing, on an item that landed is
`never-ran`, hatched in the fail colour — that is where "configured but did not
run" becomes visible. It used to be a `pending` count off a second fold,
`PointView`, which could not tell the two apart (#189).

It was five until 2026-09-23 — the count moved with the vocabulary and the rule
did not, because the rule never counted. `apps/board/unit/rail.test.tsx` asserts
ten segments in all three lanes that fold, so **an operator counting ten
segments on a card is looking at correct behaviour**, and six of them are
`skipped` on every card this repository draws because nothing constructs a
pipeline at them yet.

`lingtai add` prints the same ten at onboarding (`for (const point of STEPS)` in
`packages/conductor/src/onboard.ts`). Neither surface omits a step.

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
puts right.

Nothing that changes *code* goes through here — that is git's job. The merge
lane holds no lock to do it under: since #194 two integrations against one base
overlap, and git's ref update is what decides which of them lands, by rejecting
the second push (`push-rejected`, above).

## notification subscription — 0 by default

**There is no default.** `DEFAULT_SUBSCRIPTIONS` — four types, the same for
every project, changeable only by editing `packages/daemon/src/notify.ts` — is
gone with `#123`, and so is the file. A project that declares no `subscribers:`
is told about nothing, and the daemon says so as it starts rather than being
silent about a silence.

Source: `subscribers:` in each project's own recipe
([0037](decisions/0037-an-extension-is-a-command.md) §3, `Subscriber` in
`packages/recipe/src/recipe.ts`), built by `buildSubscribers` in
`apps/cli/src/subscribers.ts`.

This repository declares two: the desktop notification that used to be
constructed by name inside the daemon, and Telegram (`#125`):

```yaml
subscribers:
  - name: desktop
    on: [ApprovalRequested, IntegrationRefused, RunAwaitingInput, WorkItemBlocked]
    run: node apps/cli/src/notify.ts
    env: []
  - name: telegram
    on: [WorkItemLanded, WorkItemBlocked, RunFailed, ApprovalRequested, RunAwaitingInput]
    run: node packages/telegram/src/cli.ts
    env: [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID]
```

`desktop`'s four mean the same thing: nothing moves until a person acts. A landed
task is good news that needed nobody, and is deliberately not in **that** channel
— a desktop notification interrupts. A Telegram message is read when you choose
rather than when it arrives, so `telegram` names `WorkItemLanded` and
`RunFailed` without that changing what interrupts you. Same event, different
channel, different answer — sayable only because the subscription is in the
recipe.

Both render with `describe` in `packages/extension` (`@lingtai/extension`),
which depends on nothing, and Telegram imports nothing else — the path a third
party's extension would take. Neither is published, so `run:` names the file in
this checkout, the directory the daemon was started in and starts them in; `npx`
would find nothing. For the same reason both import `packages/extension` by
path rather than by package name: a merge reaches the daemon's checkout with no
`pnpm install`, so a new workspace symlink would not be there to resolve, and a
path into a package that depends on nothing needs no `node_modules` at all.
Telegram's two names go in the project's env file —
`lingtai env set lingtai TELEGRAM_BOT_TOKEN` reads the value from stdin — and
until they are there each event it is owed appends `PluginFailed` saying which
is missing. `TELEGRAM_API_ROOT` is read too, for a self-hosted Bot API server,
if it is declared.

Four rules:

- **`on:` is the subscription as well as the declaration**, so a name that is
  not in `EVENTS` fails the recipe and names itself. A retired type fails too:
  spelled right, in the catalogue, and appended by nothing, which is the same
  subscription that never fires reached by a different mistake.
- **A subscriber hears about the project whose recipe declared it**, which is
  what makes a repository with no `subscribers:` genuinely quiet rather than
  quietly served by another repository's notifier. Three of the four types above
  name no work item in their own bytes — `ApprovalRequested` and
  `RunAwaitingInput` are on a run stream, `IntegrationRefused` on an integration
  lane — so `createSubjectResolver` reads the run's own `RunStarted` for the
  first two and `data.workItemId` for the third. An event that belongs to no
  repository (`ctl-conductor`, `chat-…`, `ext-subscribers`) reaches nobody.
- **`env:` is every credential that subscriber's process gets** — see *extension
  environment* above, which is the half of 0037 §1 that makes "and nothing else"
  a fact.
- **Nothing waits for one and nothing retries one.** Its exit code decides
  nothing; a non-zero one appends `PluginFailed`, which `lingtai doctor`'s
  `subscribers: failures` reads back. The process is killed after two minutes,
  which is under the boundary's ten — that one is the backstop for a promise
  that never settles at all.

## lingtai subcommand — 22

Source: the switch in `apps/cli/src/lingtai.ts`.

`add` · `run` · `approve` · `backlog` · `requeue` · `waive` · `ask` · `answer` ·
`attach` · `status` · `doctor` · `env` · `end` · `daemon` · `service` · `restart` · `pause`
· `resume` · `shutdown` · `now` · `projection` · `version`

`approve`, `requeue` and `waive` are the decisions a person can take from
here. The board's are the first two — `apps/board/src/app/actions.ts` imports
`approve` and `requeue` from `@lingtai/conductor/decide` — and a waiver from the
board is the one `approve` appends for a gate still refusing (`#150`). That the set was not
countable from the CLI's side is how `requeue` (`#130`) and `waive` (`#129`)
went missing — and the count here was two short again, `service` and `restart`
having joined the switch without it moving.

`ask` and `answer` are the one decision taken before any attempt (`#147`) — a
`WorkItemBlocked` with `runId: null`, and a `WorkItemUnblocked` whose `note` the
fold keeps and every later prompt carries. The board answers too; only the CLI
asks.

`help` (`--help`, `-h`) is the fallthrough rather than a subcommand.

## doctor check — 23 fixed, 5 per project, 3 deferred

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
| running system (6) | `daemon: liveness` · `conductor: refusals on the log` · `conductor: lock` · `worktrees: reconciliation` · `github: what we said and did not manage` · `subscribers: failures` |
| the log itself (1) | `log: every type is readable` |
| gates ran (2) | `gates: end ran on what landed` · `gates: every step that was planned ran` |
| credentials (2) | `github: app credentials` · `runtime: signed in` |
| visibility (1) | `runtime: other settings in scope` — reports what configures a run besides the recipe |

**Five more run once per configured project**, so the total depends on how many
there are: `recipe: resolves for every project`,
`env: declared names, and which layer`, `env: <project> extensions`,
`runtime: <project> limits` and
`recipe: the rules and the merge target are one branch`. Each reports under the
project's own name (`recipe: lingtai`, `env: lingtai`,
`env: lingtai extensions`, `runtime: lingtai limits`, `base: lingtai`) when it
has something to say about that project in particular.

`env: <project> extensions` is 0037 §1's half: what each `run:` action and each
subscriber declared, and whether this machine holds it. It is `fail` rather than
`warn` when one is not set, because an extension gets *only* what it declares,
so a missing name is a command that starts, finds nothing and exits — and a
subscriber's exit code is discarded.

`runtime: <project> limits` is `#89`'s: each of `runtime.limits`, and whether
the runtime that actually runs — `createClaudeCodeRuntime()`, not the recipe's
declarative `runtime.agent` — stops a run at it (`RuntimeCapabilities.enforces`).
It is `fail` when a limit is merely carried, which is the state `turns` was in
while `#84` ran 172 against a declared 150. A run stopped at `turns` ends as
`RunFailed` with kind `out-of-turns`, distinct from the wall's `timeout`.

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
