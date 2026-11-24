# 0129 — One module owns each aggregate: every append to its stream and every read of its state

**Status** accepted · 2026-11-14 · not yet built

Every aggregate has one module that owns its stream: every append to it and
every read of its state go through that module, and nothing else touches the
stream. The aggregate's rules are transition functions in `domain`, beside its
reducer, and the module appends what a transition returns at the version it
read. Hosts — the daemon, the CLI, the board — call the module's commands and
never append. A request is appended to the aggregate it is about. A decision
reads the aggregate's reduce, never a projection or a store query. One decision
appends to one aggregate; a second aggregate that has to follow it does so by
reacting to the first one's event. A unit test holds the rule, and a stream's
count of appends outside its owner only goes down. [0128](0128-the-project-aggregate-holds-every-project-fact.md)
§7 is this rule applied to Project.

## Context

[doc/design/aggregate-audit.md](../design/aggregate-audit.md) looked at every
aggregate (second pass, 2026-11-14). Where one module reads, decides and
appends, the aggregate is healthy: Account, GitHub App, Discussion, Backlog
finding and `ext-subscribers`. Where several modules write, it is not: Ticket
has 13 writer modules, two of them hosts; Control has 6, though its own
docstring says everything appends through the daemon's commands
(`packages/domain/src/control.ts:13-15`); Project had three before 0128. The
size of an aggregate is not the cause — Attempt has the most events and is
sound because all of its writers run in one process.

What recurs where there is no owner:

- **Hosts append directly**, each carrying its own copy of a rule or none — the
  board's prompt edit appends to a ticket at `events.length` and checks nothing
  (`apps/board/src/app/actions.ts:743-744`).
- **The rules are re-checked by each writer.** Account, Control's ceiling and
  Project have transition functions in `domain`; Ticket and Attempt, whose rules
  cost money, have none.
- **Requests are written where the daemon listens.** `ctl-conductor` holds
  requests about tickets and discussions (`ContinueRequested`, `RunRequested`,
  `DiscussionRequested`) whose answer is on another stream, so the control
  state carries lists that grow for ever and are joined back at read time.
- **One decision is two appends on two streams**, neither atomic nor
  recoverable as one: approve (`WaitResolved` + `ContinueRequested`), land
  (`IntegrationSucceeded` + `TicketLanded`), ask (`DiscussionRequested` +
  `DiscussionAsked`).
- **Decisions are made from projections and SQL.** The queue chooses what to
  claim from `task_view` (`packages/conductor/src/queue.ts:77-112`), and two
  ticket rules are SQL in the store (`unconvergedUpdates`,
  `packages/event-store/src/queries.ts:328-349`), a second reduce that `lingtai
  doctor` and `converge` can disagree through.

## Decision

1. **Every aggregate has one owning module.** It holds the aggregate's
   commands — the only code that appends to the stream — and its reads — the
   only code that reduces the stream for a caller. Every other package calls
   the module. The owner sits below every host that calls it
   ([0101](0101-typescript-packages-effect-unbuilt.md) §4), so no host imports
   another host to reach an aggregate.

   | Aggregate | Stream | Owner |
   | --- | --- | --- |
   | Project | `prj-{project}` | `@lingtai/project` (0128) |
   | PR | `pr-{project}-{n}` | `packages/project/src/pr.ts` |
   | Ticket | `ticket-{project}-{issue}` | a ticket module in `@lingtai/conductor` — to be built |
   | Attempt | `pass-{uuid}` | the conductor's attempt (`run-attempt.ts` and what it calls) — to be named and held |
   | Integration | `int-{project}-{base}` | the conductor's landing lane — to be built; `@lingtai/repo` does git, not appends |
   | Control | `ctl-conductor` | a control module below the hosts — to be built; the daemon's commands move into it |
   | GitHub App | `ctl-github-app` | `packages/conductor/src/create-app.ts` |
   | Account | `acct-{runtime}` | `packages/conductor/src/account.ts` |
   | Discussion | `chat-{id}` | `packages/conductor/src/discuss.ts` |
   | Backlog finding | `bkl-{project}-{key}` | `packages/conductor/src/backlog.ts` |
   | Subscriber failures | `ext-subscribers` | `packages/daemon/src/failure-recorder.ts` |

2. **An aggregate's rules are transition functions in `domain`.** Beside each
   reducer, a pure `(state, command) → events | refusal`, as Account's
   transition and Control's ceiling already are. The owner reads the state,
   asks the transition, and appends what it returns at the version it read; a
   concurrency error is a re-read and a fresh decision, never a retry of the
   same events. A writer never re-implements a lifecycle check of its own.

3. **Hosts call commands; they never append.** The board, the CLI and the
   daemon reach an aggregate only through its owner's commands and reads.

4. **A request is appended to the aggregate it is about.** A request to
   continue a ticket, to run one now, or to ask about one is an event on that
   ticket's (or that discussion's) stream, and is answered there. `ctl-conductor`
   holds only what belongs to the installation — its ceiling, drains and starts.
   The daemon learns of a request from the stream it is on, as it already
   learns of everything else from the log.

5. **One decision appends to one aggregate; a second follows by reaction.**
   Where a decision has consequences on another aggregate, the owner appends
   the decision on its own aggregate, and the other aggregate's owner reacts to
   that event — idempotently, keyed by the event that caused it, and resumed
   after a restart from the log. Readers never have to join two half-written
   decisions; a decision whose follow-up has not happened yet reads as
   *decided, follow-up pending*.

   **Three decisions write a ticket's or a PR's stream and a second PR's
   stream in one transaction**, through the store's `appendAll`
   ([0100](0100-one-append-only-log.md) §3): a landing on `branch.personal`
   (the ticket, and the draft PR), a freeze (the PR, and the next draft for the
   tickets it did not keep), and a PR closed without merging (the PR, and the
   draft for its tickets) — [0131](0131-a-pr-goes-from-draft-to-merged.md) §1.
   A reaction would leave a time when a ticket has landed and no PR names it,
   and a freeze that read the draft then would leave out code its commit holds.
   Each stream's events still come from its own aggregate's transition, at the
   version read; a conflict on either stream writes neither. No other decision
   may use `appendAll`.

6. **A decision reads the aggregate's reduce.** A projection is for listing and
   showing; a store query may find which streams to look at. Whatever is
   decided — what to claim, whether an update converged, whether a finding may
   be accepted — is decided from the owning aggregate's reduce, read through its
   owner. A rule written in SQL in the store is a second reduce, and is replaced
   by the domain one.

7. **A test holds the rule.** A unit test finds every append whose stream is
   built by a stream constructor (`ticketStream`, `attemptStream`,
   `projectStream`, `CONTROL_STREAM`, …) outside that aggregate's owner, and
   counts them per stream against a baseline that only goes down, as the
   Effect ratchet counts `async`
   ([CLAUDE.md](../../CLAUDE.md), *New IO is an Effect*). Each aggregate's
   move lowers its count to zero in the commit that removes the last outside
   append; a new outside append is a red test.

## Consequences

- An aggregate's rule is in one place, so a fix to it is a fix everywhere, and
  a reviewer checks one module, not thirteen.
- `ctl-conductor` stops growing with requests that belong elsewhere.
- Hosts get thinner: the board and the CLI hold no event-writing code.
- Moving Ticket is the largest piece of work, and Control the one that removes
  the board's dependency on the daemon.

## Not built yet

All of it except the aggregates already owned (Account, GitHub App, Discussion,
Backlog finding, `ext-subscribers`, Ticket) and Project's (0128, in progress):
the Attempt, Integration and Control owners, the transition functions for
Attempt, moving the requests off `ctl-conductor`, the reactions of §5, the
reduce-backed queue and convergence of §6, and the test of §7 for the
aggregates still without an owner.

## Not decided here

- Where `RunSpent` belongs: today it is on `pass-`, `chat-` and `ticket-`,
  because an agent run that is not an attempt writes onto whichever stream
  invoked it.
- Whether the db ticket store's tables are an input to the Ticket aggregate or
  a record of it (`doc/design/aggregate-audit.md` F8).
- Whether a price change is an event (F7).

---
*New topic; replaces no archived ADR. Generalises 0128 §7.*
