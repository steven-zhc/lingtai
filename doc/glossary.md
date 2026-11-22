# Glossary

## What happens next

When an attempt stops short, one question decides what the answer costs: does
it **continue the saved head**, or **start from the base**? Who answers is the
other: a rule (free), a cause the system acts on, or a person — and a person
only for a spent bound, an unclear requirement or a broken environment. This
section describes what is built. Where it and the code disagree, the code is
right and this is corrected.

| | Continues the saved head | Starts from the base |
|---|---|---|
| **The machine** | **fix the refusal** (`fixRefusal`) — another `implement` in the same worktree, carrying what refused it; bounded by `runtime.limits.attempt.refusalFixes`.<br>**resolve the conflict** (`resolveConflict`) — the same for a merge conflict; bounded by `runtime.limits.attempt.conflictResolutions`.<br>**redo the step** (`redoStep`, and `writeSpentOnThenRedoStep` for *too big*) — the step that did not finish runs again, whole, from the attempt's head; bounded by `stepRedos`, a constant (3).<br>**ask a person** (`askPerson`) — only for a limit, an unclear requirement or the environment; bounded by `personAsks`, a constant (5 question waits per ticket, counted when each opens). | **start a new attempt** (`startNewAttempt`) — the ticket is released and claimed again; bounded by `runtime.limits.ticket.newAttempts`, across the ticket.<br>**split the ticket** (`splitTicket`) — triage's plan opens children and the parent waits behind them; bounded by `ticketSplits`, a constant (1 per root ticket). |
| **A person** | **FixRefusal** — one more `implement` on the saved head, then build → review → proposed. Board: *Fix the refusal on the saved work*; CLI: `lingtai fix-refusal`.<br>**RedoStep** — the step a crash or a red stopped runs again, whole, on the saved head; spends nothing. CLI: `lingtai redo-step`.<br>**Approve** — no new work; continue past the refusal. CLI: `lingtai approve`.<br>**AnswerQuestions** — writes the answers into the body and continues the step that asked (a question raised at `build`, `proposed` or `merge` goes back to `implement`). | **StartNewAttempt** — spends none of the ticket's new attempts, because only a machine's is counted. Board: *Start a new attempt from base*; CLI: `lingtai start-new-attempt`.<br>**EditBodyAndStartNewAttempt** — write into the body, then start a new attempt. Board: *Add to the ticket and start a new attempt*; CLI: `lingtai start-new-attempt --into-body`.<br>**Close** — ends the ticket. CLI: `lingtai close`. |

- The bounds the machine spends are counted on the attempt's stream
  (`refusalFixes`, `conflictResolutions`, `stepRedos`) or the ticket's
  (`newAttempts`, across the ticket; `ticketSplits`, once per root ticket;
  `personAsks`, one per question wait when it opens), so a restart, a release
  or a person's resolution resets none of them
  (`BOUNDS`, `packages/domain/src/failure/respond.ts`).
- **Continuation** is the umbrella for every move in the left column: the
  conductor calls `runPass({ from: … })`, which still starts at `admit` and runs
  `prepared`, then jumps to the step the move resumes at
  (`packages/conductor/src/run-attempt.ts`; scheduled by `requestContinuation`
  in `packages/conductor/src/resolve-wait.ts`). Nothing in the right column is
  one; each starts a new attempt.
- A new attempt is told about earlier attempts and where their commits are
  (`attemptBrief`, `packages/conductor/src/prompt.ts`), but **nothing is carried
  to it**: it starts from the base and its brief says why the old approach was
  wrong. A cut-off `implement`'s uncommitted code is committed to its branch as
  a `wip:` commit, so a continuation keeps it.
- A person's moves are the `Resolution` type of
  [0118](decisions/0118-a-hold-explains-itself.md) §1; the machine's are
  [0108](decisions/0108-a-refusal-buys-a-round.md) §8. The old recipe keys
  `rounds` and `restarts` are refused by name, and the refusal names the new key.
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
| **Triage**, **judge** | The two agents that each **name a cause** — triage why a wait would open, the judge what a reviewer's findings come to — and never an action: the system acts on the cause (`actionFor`, `packages/domain/src/failure/respond.ts`). A judge answers within the bounds; triage answers where a wait would open. | *advisor* |
| **Account lock** | A platform's limit on an account — a runtime's usage limit or GitHub's rate limit — with its `until`; it holds the projects that use that account and lifts at its reset (or, where none was named, at a fallback delay) or by `lingtai account lift`. | *runtime limit* as a kind of its own |
| **base-red** | The reason a ticket is passed over because a check of `build` fails on the base itself: it is the project's fault, not the ticket's, and it lifts when the base's head moves. | *blocked* |
| **Why nothing runs** | The one sentence under `Queue` in `lingtai status` and at the top of the board's Queued column, saying what holds the queued tickets. | *stuck* |
| **satisfied** | How a ticket ends when its work was already on the base: shown as *satisfied* on the Landed row, the task page and `/landed`. | *landed*, *closed* |
| **redo the step** | Run the step that did not finish again, whole, from the attempt's head. Shown as *the step is being redone*. | *retry* |
| **Handled for you** | What the board and `/report` count of the problems steps raised: each once, as *auto-fixed* when the system answered (a rule, one look or a judge) and *needed you* when a person did, or it is still open. See [operating.md](operating.md#handled-for-you). | *auto-resolved*, *success rate* |
| **Personal branch** | In a team project (0.16), the branch tickets are cut from and land on, `branch.personal`, one machine's. A ticket landed on it stays open on the tracker, labelled `lingtai:landed`, until its PR merges. | *base*, for a team project |
| **PR** | What lies between a team's personal branch and `main`: a person deciding a body of work is ready for the team. It has two numbers: Lingtai's, from 1 per personal branch, which is on the log and in the PR branch's name (`<branch.personal>-pr-<n>`); and the code host's, once it is opened (GitHub's `#88`), which cards show once there is one. | *pull request* for Lingtai's own, *release* |
| **Draft**, **In progress**, **In review**, **Merged** | A PR's states, with **Waiting on you** as the fifth. Draft is what has landed on the personal branch and no PR holds yet; In progress is Lingtai getting it ready for review; In review is ready on the code host; Merged is merged by the team. *Draft* is also the state a closed-without-merging PR goes back to, and the word for the code host's draft pull request that Lingtai opens first and marks ready only when the CI the project counts has passed (or it has none). | *open*, *pending* |
| **Submit** | The person's act that takes a Draft into In progress: a button on the draft card, or `lingtai pr submit`. Lingtai never submits on its own and never merges. | *release*, *send* |
| **pr-fix ticket** | A ticket labelled `lingtai:pr-fix`: a change the PR's review asked for. In team mode it ranks ahead of every kind the recipe names. Claimed while a PR is open, it is cut from that PR's branch and lands on it; its landing sends the PR round again from bringing `main` in. | *review fix* |
| **The PRs view** | The board's page for a team project's PRs, one column per state. `PRs` is one of the views on the place line, for a team project only, and what waits on you is a count on it. A solo project has none, and `lingtai pr` refuses there. | *PR board* |
| **The place line** | The breadcrumb on the board's bar, `Lingtai / <project ▾> / Tickets · PRs · Recipe`: the project's name opens the project menu, and the views after it are part of the place. It replaces the filter as one object. Keys: `⌘K` searches (type `#` and a ticket or PR number to find one), `G T` goes to Tickets, `G P` to PRs, `G S` switches project. See [the bar](design/the-bar.md). | *filter*, for the place |
| **AI review** | The `review:` step: an agent that reads the diff cold and reports findings. Older text, ADRs and archived docs call it the *cold reviewer*. | |
| **One look** | The middle way a problem is answered, between a mechanical rule and a person: one agent judgement (triage or a judge) that picks the next move — lines to fix, start over, or split. It counts as the system's answer in *handled for you*. Defined by the failure-paths lanes, `apps/site/src/app/failure-paths.tsx`. | |

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
  (`Approve`, `FixRefusal`, `RedoStep`, an answer, an account-limit continuation) stays in the same attempt;
  `startNewAttempt`, a person's `StartNewAttempt` and a split parent's return attempt start a new one. Say *attempt*, never *pass* or *run*, for this. Names the log already
  holds stay as they are, because an event never changes: the `pass-` stream prefix,
  the `runId` field (the attempt's stream id) and the `Run…` event names.
- **Agent run** — one invocation of an agent inside an attempt: the implement, each
  refusal fix, a judge. *Run* on its own means this and nothing else.
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
| **AttemptState** | `pass-…`, one per attempt | One attempt at one ticket: the run's lifecycle, the agent's head and what it produced, the step it is in and each step's verdict and the commit it was made on, how it ended (refused, failed), what it saved for a refusal fix, and the plan and instants the board's rail draws. `packages/domain/src/attempt.ts`. |
| **TicketState** | `ticket-{project}-{issue}`, one per issue | One ticket across all its attempts: where it stands (backlog, claimed, waiting on a person, closed, landed), what it is (title, kind, project, issue), its attempts and how each ended, the last thing a person did to it, and what Lingtai wrote back to GitHub. `packages/domain/src/ticket.ts`. |
| **ControlState** | `ctl-conductor`, one per machine | Whether the conductor may take work: `paused`, `by` and `reason` carry one pause, the setup's (conductor-wide, holding across starts, lifted by `lingtai resume`), and there is no `until` — nothing about it lifts by the clock. It also carries a standing request to drain, which lasts until the next start. A person's pause, the ceiling and a usage limit are locks, and none of them is this `paused`. `packages/domain/src/control.ts`. |
| **Lock** | read from `prj-{project}`, the control stream (the ceiling) and `acct-{runtime}` | Something that holds one project's new work, shown on the board's banner and lifted by something specific ([0126](decisions/0126-a-stop-is-a-lock-and-an-unlock.md)). Three kinds: a **project's pause** (`lingtai pause [project]`, lifted by `lingtai resume [project]`); **the day's ceiling** (lifted at midnight, by the configuration, or by `lingtai ceiling raise <usd>`); and **an account lock** (a runtime's usage limit or GitHub's rate limit, `acct-{account}`: lifted at its `until` or by `lingtai account lift <account>`). A lock stops new work, discussions and triage, never an attempt in flight. The setup's pause is not one: it is `ControlState`'s. |
| **ProjectState** | `prj-{project}`, one per project | What Lingtai was told about a project: its owner, base branch, the recipe a person declared (the file's text and its hash, with every version and who made it) and the sandbox state observed for it, and a refusal nothing has recovered from yet. The file `~/.lingtai/<project>/recipe.yml` is what a person writes; a hand edit is recorded the next time anything reads it, and nothing writes the file from the log. `packages/domain/src/project.ts`. |
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
