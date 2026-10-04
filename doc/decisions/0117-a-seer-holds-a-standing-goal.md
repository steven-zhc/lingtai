# 0117 — Seers: a seer holds a standing goal over the repository, wakes on the log or the clock, and only ever proposes

**Status** proposed · 2026-10-04

A pass works one ticket and ends. A **seer** is the other unit of work: declared
once per project, it never ends, and it keeps one concern — the architecture,
the roadmap, the schedule. It wakes on events or on the clock, reads only what
changed since it last looked, and says what it saw as a finding in the backlog,
a question, or a digest for subscribers. It never claims a ticket, never holds a
worktree, never commits and never opens an issue. What it may spend is bounded
per seer and recorded like every other paid call.

The name is 千里眼's, the watcher at the southern gate who sees far, reports,
and does not act.

## Context

Everything Lingtai does starts from a ticket a person wrote
([0109](0109-the-core-takes-a-ticket.md)). Work that no ticket names goes
undone: code that has drifted from an ADR, a roadmap row with no issue behind
it, a document still describing as pending something that has landed, a ticket
held for three days that nobody noticed. These are standing concerns rather
than tasks. They have no done state, and they are only visible across many
passes. The cold reviewer cannot see them, because it reads one diff. A person
can, but only by reading the log and the documents on purpose.

Two constraints shape the answer. **Lingtai proposes; a person decides a ticket
exists** (0109 §4), so a concern may produce proposals and never work. And an
agent woken by a timer on input that has not changed spends money every time
for the same answer, which is the failure the queue's backoff exists to stop.

## Decision

1. **A seer is a third unit beside the pass and the subscriber.** A pass takes a
   ticket and ends. A subscriber is told an event and is never waited for
   ([0105](0105-a-plugin-is-a-declaration-and-an-implementation.md) §7). A seer
   keeps one concern indefinitely, and it is the only one of the three that
   remembers across wakes. It is not a step and is declared at no step: the
   recipe's top-level `seers:` list sits beside `subscribers:`.

2. **A seer is a plugin, and the set is closed** (0105 §2).
   `defineSeer(key, { fields, look })` has the same two halves as any plugin:
   a declaration, which the recipe is checked against before anything runs, and
   an implementation. Three ship: `architecture`, `roadmap` and `progress`. A
   project's own concern uses either the generic `agent` seer, which takes a
   prompt file and the paths it may read, or a `run:` seer. A `run:` seer is a
   subprocess handed the delta as JSON on stdin that writes its sightings as
   JSON lines on stdout. Code that is not Lingtai's still never runs in
   Lingtai's process.

   ```yaml
   seers:
     - name: architecture
       architecture:
         paths: [doc/decisions/**, packages/*/src/**]
       wake: { on: [WorkItemLanded], every: 5 }
       limits: { turns: 40, wall: 20m }
       budget: { week: 10 }
     - name: roadmap
       roadmap:
         reads: [doc/roadmap.md, doc/design/the-pipeline.md]
       wake: { cron: "45 8 * * 1" }
     - name: progress
       progress: {}
       wake: { cron: "50 8 * * *" }
   ```

3. **It wakes on the log, on the clock, or on both, and every wake is
   recorded.** `wake.on` names event types, as `subscribers:` does, and
   `wake.every: n` wakes on every nth matching event. `wake.cron` is a schedule
   in the conducting machine's time zone. Each wake appends `SeerWoke` to the
   seer's own stream, `seer/<project>/<name>`, saying what woke it.

4. **A seer reads only what changed, and a wake with nothing new spends
   nothing.** The stream's last `SeerSlept` carries the checkpoint: the base
   commit and the `seq` the seer last read. Before any agent is dispatched, a
   deterministic **pre-look** compares the checkpoint with now: commits that
   touch the seer's paths, and events of the types it reads. An empty delta ends
   the wake with `SeerSlept { saw: "nothing" }` and no paid call. The seer is
   handed the delta rather than the whole repository, together with its own
   sightings that are still open, so it does not raise again what a person has
   not yet answered.

5. **A seer only proposes, through three outlets.**
   - **A sighting** (`SeerSaw`) is folded into `finding_backlog` beside the
     reviewer's findings. It is keyed by `seer/<name>` and its claim rather
     than by ticket, step and action. A person accepts or declines it like any
     finding (`FindingAccepted`, `FindingDeclined`). Only an accepted one
     becomes a ticket, with the kind the seer suggested. A sighting carries a
     drafted body in the four-row form (Problem, Want, Fix, Watch out), so an
     accepted one is already a ticket an agent can work.
   - **A question** (`SeerAsked`) is for a decision no finding can carry, such
     as *is 0105 §2 still the rule, or is the code right?* It is listed by
     `lingtai status` and on the board beside the questions tickets wait on.
     The answer is appended to the seer's stream, and its next wake reads it.
   - **A digest** (`SeerReported`) is a short text for people. It reaches them
     through a `subscribers:` entry that names `SeerReported`, never through
     the bar ([the-bar.md](../design/the-bar.md)).

   A seer never claims a ticket, holds a worktree, commits, pushes, opens an
   issue or edits a document. Those remain the conductor's effects, and no seer
   configuration grants them.

6. **A seer is a reader, contained like the discussion assistant**
   ([0106](0106-a-role-keeps-its-powers-across-runtimes.md) §5–6). Its runtime
   is given `tools: "none"`, and its working directory is an empty directory
   Lingtai owns. The files it reads are served from the bare mirror at the
   checkpoint's commit, bounded as a discussion's are. So a seer runs only on a
   runtime that can be given no tools, which today is `claude-code`, and a
   recipe that names another is refused when it resolves. `progress`
   dispatches no agent unless it has something to narrate, because its delta is
   a fold of the log.

7. **A seer runs in the daemon, beside the pass and never inside it.** A seer
   claims nothing, so the conductor lock
   ([0102](0102-one-conductor-holds-the-lock.md) §4) decides only which process
   hosts seers, not when they run. The daemon runs at most one seer at a time,
   on its own queue. That queue never delays a pass, and no pass delays it. A
   wake that falls due while a seer is looking is collapsed into the next one,
   just as the work loop collapses a burst of completions. `pause` stops seers
   waking as it stops passes being taken, and `shutdown` waits for a seer in
   flight as it waits for the pass.

8. **What a seer may spend is bounded twice and recorded once.** `limits:`
   bounds one look (turns and wall) and narrows `runtime.limits` field by
   field; it never widens them. `budget:` bounds a seer's spend over a rolling
   week, and a wake past the budget ends with `SeerSlept { saw: "over-budget" }`
   without a paid call. Every paid look records its tokens on the `SeerSlept`
   it ends on ([0110](0110-tokens-on-the-event-money-at-display.md)), so
   `/spend` shows each seer's cost beside the passes'.

9. **A seer is measured by what people did with what it said.** For each seer,
   `/spend` shows the share of its sightings accepted, declined and still open,
   and its spend per accepted sighting. Both are folds of events that exist. A
   seer whose sightings are mostly declined needs a different prompt, and these
   numbers are how that gets noticed.

## The three that ship

| seer | keeps | reads | says | agent |
|---|---|---|---|---|
| `architecture` | the code matches the ADRs: module boundaries, dependency direction, files outgrowing their purpose | the diff since the checkpoint under `paths:`, `doc/decisions/`, `doc/architecture.html` | `tech-debt` sightings that cite the ADR section and the `file:line`; a question when the ADR may be what is wrong | yes, so it wakes on landings rather than on the clock |
| `roadmap` | the plan and the work agree | the documents under `reads:`, the open issues, `WorkItemLanded` | `feature` or `documentation` sightings for a row with no issue, an issue nothing in the plan wants, or a document behind what landed | yes, weekly |
| `progress` | work keeps moving | the log only: throughput, time from claim to land, items held or blocked past a threshold, repeated failures, spend against budget | a digest; a question when a dated milestone in the plan is at risk | only to narrate the digest |

## Consequences

- Concerns no ticket names get an owner that works across passes, and a person
  still decides every ticket that exists.
- The backlog becomes the one queue of proposals, from reviewers and seers
  alike. Its key widens to carry a source that has no ticket, and
  `finding_backlog` is rebuilt once.
- A seer spends money on a clock. The pre-look, the checkpoint and the weekly
  budget are what make an idle week cost nothing, and a seer without them is
  refused rather than allowed to run unbounded.
- A seer can be wrong in a way a gate cannot, because its claims are
  judgements. It cannot act on them, so being wrong costs a person a minute and
  a decline, and the decline is recorded and counted.
- The daemon hosts a second queue, and pausing, draining and restarting cover
  both queues.

## Not built yet

All of it. In this order:

1. `SeerWoke`, `SeerSaw`, `SeerAsked`, `SeerReported` and `SeerSlept` in
   `packages/domain/src/events.ts`. `finding_backlog` folds `SeerSaw` with a
   source in place of ticket, run and step, which is a projection schema
   change and one rebuild.
2. `seers:` in the recipe schema, and `defineSeer`, with its refusals when the
   recipe resolves: a runtime that cannot be given no tools, `limits` that
   widen, and a `wake` with neither `on` nor `cron`.
3. The daemon's seer queue: waking on events and on cron, the pre-look and the
   checkpoint, and pause and drain. `doc/architecture.html` and its Chinese
   twin draw it.
4. `progress`, first because it is useful without an agent.
5. `roadmap`.
6. `architecture`.
7. Per-seer spend and acceptance on `/spend`.

---
*New topic; replaces nothing.*
