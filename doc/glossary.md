# Glossary

## What happens next

Seven words say what happens next to a ticket, and one question decides what
each costs: does it **continue the saved branch**, or **cut a new branch from
the base**? This section describes what is built. Where it and the code
disagree, the code is right and this is corrected.

| | Continues the saved branch | Cuts a new branch from the base |
|---|---|---|
| **The machine** | **fix round** (修复轮) — another `design` or `implement` in the same worktree, carrying what refused it. Code: `FixRound` (`packages/domain/src/attempt-next.ts`). Bounded by `runtime.limits.rounds`. | **restart** (重来) — the ticket is released and claimed again. Code: `Requeued{cause: Restart}` as a `AttemptNext`, `TicketReleased{cause: Restart}` on the log (`packages/domain/src/events.ts`, `packages/conductor/src/conduct.ts`). Bounded by `runtime.limits.restarts`. |
| **A person** | **GrantFixRound** (批一轮) — one more `implement` on the saved head, then build → review → proposed; ends at a person. Board: *Continue fixing current work*; CLI: `lingtai grant-fix-round` (`apps/cli/src/grant-fix-round.ts`).<br>**Approve** (批准) — no new work; continue past the refusal. Board: *Approve and continue*; CLI: `lingtai approve` (`apps/cli/src/approve.ts`). | **Requeue** (重新排队) — `TicketReleased{cause: ByPerson}`; spends no restart, because only `cause: Restart` is counted. Board: *Start over from base*; CLI: `lingtai requeue` (`apps/cli/src/requeue.ts`).<br>**EditBodyAndRequeue** — write into the body, then requeue. Board: *Add to the ticket and start over*; CLI: `lingtai requeue --into-body`. |

- **Continuation** (续跑) is the umbrella for every move a person makes in the
  left column: the conductor calls `runPass({ from: … })`, which still starts
  at `admit` and runs `prepared`, then jumps to the step the move resumes at
  rather than walking the steps between (`packages/conductor/src/run-attempt.ts`;
  scheduled by `requestContinuation` in
  `packages/conductor/src/resolve-wait.ts`). The machine's fix round is not
  one: it stays inside the same `runPass` loop. Neither move in the right
  column is one; each starts a new attempt.
- A requeued attempt is still told about earlier attempts and where their commits
  are (`attemptBrief` and the arms on origin, `packages/conductor/src/prompt.ts`),
  so it can reuse that work — but it is new development and goes through build
  and review again.
- A person's moves are the `Resolution` type of
  [0118](decisions/0118-a-hold-explains-itself.md) §1; the granted round is
  [0108](decisions/0108-a-refusal-buys-a-round.md) §8 and restart counting is
  0120 §5.
- [The attempt](the-attempt.html) shows where each of these arrives from.

## Words on the board

The board and the CLI speak to a person who has not read the code. They use
these words, each for one thing, and no other word for it. A page that needs
another word defines it where it is used or does without it.

| Word | Means | Never |
|---|---|---|
| **Ticket** | The issue Lingtai works on, and everything recorded about it as a whole. | *task*, *item*, *issue* when the ticket is meant |
| **Attempt** | One try at the ticket, from being claimed to an outcome, numbered 1, 2, 3 in order. Shown as `Attempt N` even when it is the only one. | *pass*, *run*, *the run* |
| **Step** | One of the ten points every attempt passes, `claim` to `end`. What a step concluded is its **verdict**, shown as its state (*passed*, *failed*, *asked*) or as *N findings*. | *gate*, *stage*, *phase* |
| **Finding** | A problem a step reported, with the scenario in which it fails. | *issue*, *comment* |
| **Event** | One entry in the log. Everything a page shows is reduced from events. | *history row*, *log line* |
| **Run log** | What an agent printed while it ran, kept until the attempt lands. The one place *run* appears on its own. | *output*, *transcript* |
| **Waiting on you** | The state of a ticket that has stopped for a person. | *held*, *blocked*, when a person is what it waits for |
| **Decision** | What a person is asked to choose while a ticket is waiting on them, and the move they choose. | *judgement*, *resolution*, *wait* |
| **Triage**, **judge** | The two agents that advise on a decision: triage on why it stopped, the judge on a reviewer's findings. They name who advised, never the decision itself. | |

How these appear:

- **An event is shown as a sentence first** (*Attempt 1 claimed by the
  conductor*), with its type (`TicketClaimed`) in small type beside it and its
  fields one click further. Names the log already holds keep their spelling
  where they are shown as code.
- **An id is shown short and as what it names.** An attempt is `Attempt N`; its
  stream id (`pass-…`) and its run id appear only on hover or in an
  event's fields. The one place ids are text is the bar's line of
  identifiers, each once, because that is where a person copies one for
  the CLI.
- **A path is shown relative to the repository**, never under the worktree it
  was written in.
- **An internal version is not a caption.** A prompt is described by its size;
  its version string is in its fields.
- *Stream* is not a word the board shows: the record's tabs are its streams,
  named Ticket and `Attempt N`.

## The log and its states

Lingtai is an event log. Everything else is what the log's events add up to.

- **Event** (事件) — one row of the `events` table, appended and never changed
  (0100). Every event belongs to one **stream**.
- **Stream** (流) — the events about one subject, in order. The id's prefix says
  what the subject is (`packages/domain/src/streams.ts`). Subjects are kept apart on
  purpose: a ticket, each attempt at it and each discussion about it are three
  streams, linked by the ids their events carry (`TicketClaimed.runId`,
  `RunStarted.ticketId`, `DiscussionHeld.chatId`), never one stream (the operator,
  2026-11-03). A reducer reads its own stream only; an answer that needs two is a
  projection's or a caller's join.
- **Reduce** — the one rule that takes a stream's state and its next event and
  returns the state after it. Each kind of stream has exactly one, in
  `@lingtai/domain`, and every reader calls it: the conductor, the CLI, the
  board and the projections ([one-reduce-per-stream](design/one-reduce-per-stream.md)).
  Code: `reduceAttemptEvent(state, event)` reduces one event and `reduceAttempt(events)`
  a whole stream from the start, and likewise for every stream. Say
  *reduce* for the act and **reducer** for the rule (the attempt reducer); the older
  words *fold* and *apply* mean the same thing.
- **State** (状态) — what reducing every event of one stream gives. A state is
  about one stream and nothing else; an answer that needs two streams is a
  projection or a caller's join.
- **Attempt** (尝试) — one try at changing a ticket: Lingtai claims it and works it
  through the steps once. One attempt is one `pass-…` stream. A continuation
  (Approve, GrantFixRound) stays in the same attempt; a Requeue or a restart starts
  a new one. Say *attempt*, never *pass* or *run*, for this. Names the log already
  holds stay as they are, because an event never changes: the `pass-` stream prefix,
  the `runId` field (the attempt's stream id) and the `Run…` event names.
- **Agent run** — one invocation of an agent inside an attempt: the implement, each
  fix round, a judge. *Run* on its own means this and nothing else.
- **Turn** — one go round the conductor's loop: it looks at each project and
  starts the attempts there is room for. A *sweep* is the turn the five-minute
  fallback timer starts, as against one an event wakes.
- **Head** and **base** — an attempt works on its own branch. Its *base* is the commit
  on the base branch it started from; its *head* is the newest commit the agent
  has produced there (`AttemptState.headSha`, set by `RunProducedDiff` and
  `RunProposedCompletion`).
- **onSha** and **stale** — `onSha` is the fact: the commit a step's verdict was
  made on (`StepState.onSha`). *Stale* is the judgement read from it: from `build` on,
  a verdict whose `onSha` is not the head is stale (design D2). Say *stale*, never
  *not current*; the board's `current: boolean` is renamed `stale` by #848.
- **Projection** (投影) — a table built from the whole log in `seq` order, for
  questions across many streams (`task_view`, `ticket_report`, `spend`,
  `finding_backlog`). Where a row needs one stream's state, the projection stores
  that state in the row and reduces each new event into it with the same domain
  rule. It is corrected only by `lingtai projection rebuild <name>`.

The states, one per kind of stream:

| State | Stream | What it is |
|---|---|---|
| **AttemptState** | `pass-…`, one per attempt | One attempt at one ticket: the run's lifecycle, the agent's head and what it produced, the step it is in and each step's verdict and the commit it was made on, how it ended (refused, failed), what it saved for a fix round, and the plan and instants the board's rail draws. `packages/domain/src/attempt.ts`. |
| **TicketState** | `ticket-{project}-{issue}`, one per issue | One ticket across all its attempts: where it stands (backlog, claimed, waiting on a person, closed, landed), what it is (title, kind, project, issue), its attempts and how each ended, the last thing a person did to it, and what Lingtai wrote back to GitHub. `packages/domain/src/ticket.ts`. |
| **ControlState** | `ctl-conductor`, one per machine | Whether the conductor may take work: `paused`, `by` and `reason` carry one pause, the setup's (conductor-wide, holding across starts, lifted by `lingtai resume`), and there is no `until` — nothing about it lifts by the clock. It also carries a standing request to drain, which lasts until the next start. A person's pause, the ceiling and a usage limit are locks, and none of them is this `paused`. `packages/domain/src/control.ts`. |
| **Lock** | read from `prj-{project}`, the control stream (the ceiling) and `acct-{runtime}` | Something that holds one project's new work, shown on the board's banner and lifted by something specific ([0126](decisions/0126-a-stop-is-a-lock-and-an-unlock.md)). Three kinds: a **project's pause** (`lingtai pause [project]`, lifted by `lingtai resume [project]`); **the day's ceiling** (lifted at midnight, by the configuration, or by `lingtai ceiling raise <usd>`); and **a runtime's usage limit** (`acct-{runtime}`: lifted at its `until` or by `lingtai account lift <runtime>`). A lock stops new work, discussions and triage, never an attempt in flight. The setup's pause is not one: it is `ControlState`'s. |
| **ProjectState** | `prj-{project}`, one per repository | What Lingtai was told about a repository: its owner, base branch, the recipe hash last resolved, and a refusal nothing has recovered from yet. `packages/domain/src/project.ts`. |
| **IntegrationState** | `int-{project}-{base}`, one per base branch | The merge lane for one base branch: idle or attempting which ticket's head, and how many attempts. `packages/domain/src/integration.ts`. |
| **ChatState** | `chat-…`, one per discussion | One discussion with an agent about a ticket: its asks and answers, and how many are answered. `packages/domain/src/chat.ts`. |
| **Finding state** | `bkl-{project}-{key}`, one per finding | One reviewer finding sent to the backlog: proposed, accepted or declined. `packages/domain/src/backlog.ts`. |

### In domain-driven-design terms

Each stream is one aggregate, and every event on it is reduced into that
aggregate's state. The boundary is drawn small: two things share a stream only
when an invariant must hold across them atomically, and nothing in Lingtai needs
a ticket and its attempts, or a ticket and its discussions, to change in one write.

| DDD | Lingtai |
|---|---|
| aggregate type | a kind of stream: ticket, attempt, discussion, merge lane, project, control |
| aggregate | one stream (`ticket-lingtai-829`, `pass-…`) |
| aggregate state | `TicketState`, `AttemptState`, … |
| apply / when | the reducer (`reduceTicketEvent`) |
| command handler | the conductor, the CLI or the board: read the state, decide, `append(stream, expectedVersion, events)` |
| consistency boundary | one stream's version: a write is atomic within one stream and nowhere else |
| reference to another aggregate | an id on an event (`TicketClaimed.runId`, `RunStarted.ticketId`, `DiscussionHeld.chatId`) |
| process manager | the conductor, which writes to several streams in order, and `reconcile`, which finishes or undoes what a crash left half done |
| read model | a projection (`task_view`, `ticket_report`, `spend`, `finding_backlog`) |
