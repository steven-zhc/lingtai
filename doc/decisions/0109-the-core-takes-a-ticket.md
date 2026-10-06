# 0109 — The ticket, the claim, branches and attempts, and close: the core takes a ticket, every claim leaves its commits on a named ref, and a close is a terminal outcome

**Status** accepted · 2026-10-01

The core runs a ticket. Where the ticket came from is an adapter's business,
recorded for write-back and never branched on. A claim is one attempt. Whatever
it ends in, if it committed anything it leaves `agent/<n>` (the newest work) and
`agent/<n>-attempt-<k>` (this attempt's own arm) on origin. The next attempt is
handed the names of earlier arms that exist, beside how each attempt ended, as
an offer rather than an instruction. Every pass is still cut from the base. A
landing may sweep the arms through `refs:` at `end`. Closing a ticket nobody
will do is a fourth terminal outcome, and `end` runs on it like the other three.

## Context

Tickets come from GitHub today, but the scheduler's decisions — what runs, in
what order, what a pass costs — do not depend on GitHub. Letting the source leak
into the core would make a second source an edit to the core. A pass's worktree
is deleted when the pass ends, so commits nothing pushed are lost, and a later
attempt can only build on work that is on a ref it can fetch. A ticket somebody
decides not to do needs an ending on the log, or the board keeps drawing it as
queued and the recipe's `end` actions (closing the issue, labels) silently never
run.

## Decision

1. **The core's input is a ticket.** A pass works on `Ticket`
   (`packages/conductor/src/pass-steps.ts`): the store's reference, a title and
   a body, and the body becomes the prompt. The listing the queue reads is cheap
   and holds no body; the body is fetched once, for the ticket that was claimed.
   Which system a ticket came from is recorded and never decides anything.

2. **The source is a trusted adapter behind a port, `Tickets`.**
   `packages/conductor/src/ticket-store.ts` defines it: eight verbs —
   `listOpenIssues`, `listIssuesSince`, `getIssue`, `createIssue`, `comment`,
   `setLabels`, `closeIssue`, `updateBody` — every read and write the core
   makes against a ticket system. It is not a plugin: the core cannot run on
   tickets it does not trust, so an implementation is chosen by whoever runs
   the machine, like a database driver.

   Two implementations exist. GitHub issues, where `GitHubClient` itself
   satisfies `Tickets` structurally — pinned by a type-only check in
   `unit/tickets.test.ts`. And `dbTickets`
   (`packages/conductor/src/db-tickets.ts`), which uses two tables, `tickets`
   and `ticket_comments`, on whichever store the machine chose (`TicketSql`,
   `packages/event-store/src/ticket-sql.ts`). The tables are created on first
   use by `ensureTicketTables`, and nothing in the code appends an event — a
   reset of `events` (007, 010) leaves them alone.

   `TicketStore`, with `propose` and `withdraw`, is the propose/withdraw layer
   that sits on top of either: `githubTicketStore` is written only against
   `Tickets`' verbs, so it writes a finding wherever a project's tickets
   actually live, GitHub or `dbTickets`, despite its name.

   A recipe chooses with `source.tickets: github | db` (`TicketSource`,
   `packages/recipe/src/recipe.ts`). The field absent means `github`
   (`ticketSourceOf`, `packages/recipe/src/settings.ts`) — the default lives
   there and not on the schema, so a recipe that omits the field hashes
   exactly as it did before the field existed. `ticketsFor` (`ticket-store.ts`)
   resolves the source; `passClientOf` swaps only those eight verbs onto the
   client a pass is handed — the refs, `fileAt`, the default branch and the
   token are untouched.

   **The source is chosen once.** `ticketsFor` refuses with
   `TicketSourceConflict` when the recipe says `db`, `dbTickets` holds no
   ticket yet, and the log already has `wi-<project>-*` streams — numbering
   from 1 would otherwise step into a GitHub issue's stream. Once `dbTickets`
   holds any ticket of its own, the project switched deliberately and this
   passes regardless of what the log holds from before. Moving from `db` back
   to `github` is not guarded in code.

3. **The store translates; the core decides.** A store renders a declarative
   filter in its backend's terms (labels on GitHub) and writes what it is told
   (a label, a close). Kind, priority, blockers, holds and backoff are the
   core's. `agent:hold` is the core's idea, written in the source's vocabulary.

4. **Lingtai proposes; a person decides a ticket exists.** The only ticket
   Lingtai writes is one a person accepted from the findings backlog.
   `propose` is idempotent on the finding's key, which it writes into the
   ticket body as `<!-- lingtai:finding <key> -->`. When two accepts race, the newer
   issue is withdrawn (commented and closed `not_planned`) in favour of the
   older.

5. **A claim is an append at an expected version, and it is one attempt.**
   `WorkItemClaimed` carries the `runId` and the worker (host and pid). The
   store's version check decides a race, and nothing expires, so held is held. A
   conductor that takes the lock releases claims recorded by other workers. The
   attempt ordinal `k` is the number of `WorkItemClaimed` events with distinct
   run ids, counted by `priorAttempts` (`packages/conductor/src/attempts.ts`).
   Every restart is a new claim and so a new attempt. GitHub is told
   `lingtai:working` or `lingtai:waiting`, computed from state (`labelsFor`),
   and never read back.

6. **Every claim that committed anything publishes two refs, whatever its
   ending.** `agent/<n>` is the newest work, pushed with
   `--force-with-lease`. `agent/<n>-attempt-<k>` is this attempt's arm, pushed
   with force (`agentBranch`, `armBranch` in `packages/conductor/src/branches.ts`).
   The arm is a sibling ref rather than a child because git cannot hold a ref and
   a directory under one name. On every ending but a landing,
   `publishWhatIsCommitted` in `conduct.ts` pushes both before any question is
   appended or GitHub is told, and records `RunRefsPublished` with what happened
   (`nothing-committed`, `refused`, `arm-only`, …). A head still at the base
   publishes nothing. A landing pushes `agent/<n>` alone, through the lane.

7. **The agent commits as the work stands.** `prompts/ticket.md` tells the
   implementer to commit each piece as it lands and not to push. The worktree is
   deleted when the pass ends and there is no warning before the last turn. An
   unreviewed commit on an arm costs nothing; `main` is guarded by the steps,
   never by a branch being clean.

8. **An earlier attempt is a locator the next one is handed.** `attemptBrief`
   puts a table of earlier attempts in the prompt (number, run, how it ended,
   its commits), keeping the last `runtime.budget.attempts` rows (default 5).
   For the most recent attempt it adds what it produced, the output that refused
   it, and its turns and cost. An arm is named only when origin has it
   (`armsOnOrigin`, asked only when an earlier attempt exists), so a first
   attempt's prompt is unchanged and no ref is offered that would not resolve.
   The arm name is derived from `k`, never stored. The brief offers (`git show
   <ref>:<path>`, `git diff HEAD <ref>`) and leaves the judgement to the agent.

9. **The cut does not move.** Every pass starts from the base as the mirror
   has it, never from an earlier attempt's branch. A refused approach does not
   carry into the next attempt unless the agent chooses to read it, which keeps
   *start over* meaning something.

10. **A landing's cleanup is the `refs:` plugin at `end`, and only on
    `landed`.** `when:` is the literal `landed`, so no recipe can sweep the arms
    of an item that did not land; those arms are the only record of what was
    tried. `branch:` defaults to `false`, keeping `agent/<n>` as the ref a person
    follows from the merge commit. `sweepRefs` (`packages/conductor/src/tell.ts`)
    deletes by prefix `agent/<n>-attempt-`. A team that keeps every branch leaves
    the plugin out.

11. **A close is a terminal outcome.** `TerminalOutcome` is
    `landed | blocked | failed | closed` (`packages/conductor/src/end-step.ts`),
    `when:` accepts `closed`, and `when: any` includes it. `lingtai close`
    (`packages/conductor/src/close.ts`) needs a reason, refuses an item already
    landed or closed, and appends `WorkItemClosed` together with what `end`
    resolved, in one append. It reads the recipe first, and an unreadable recipe
    refuses and closes nothing. It works from any non-terminal state; a run in
    flight finishes on its own and the item does not go back to the queue.
    Nothing reopens a closed item, so wanting the work again means a new ticket.

12. **`end` is audited per outcome.** `lingtai doctor` and `lingtai end replay`
    read every terminal ending and ask whether `end` resolved for that outcome.
    `replay` resolves each item for the outcome it actually reached.

## Consequences

- A second ticket system (Jira, Linear) is one `Tickets` adapter that passes
  `describeTicketsContract` (`packages/conductor/test/tickets-contract.ts`),
  not a change to how a pass runs.
- Closing on landing and closing on close are separate `end` actions. `when:
  any` also fires on `blocked` and `failed`, where closing the issue is wrong.
  This repository's recipe declares both, and
  `packages/conductor/unit/close.test.ts` reads that file.
- Arms pile up on origin in any repository that does not declare `refs:`.
  Leaving it out keeps every branch for audit, and it also looks the same as
  forgetting it.
- An agent can build on a refused arm without noticing why it was refused. The
  brief puts each ref next to its ending to make that harder.
- A restart's `PassRestarted` names the arm, not `agent/<n>`, so the approach it
  abandons stays fetchable after the next claim overwrites the branch.

## Not built yet

- **`source` is still a closed enum.** `WorkItemDiscovered.source` in
  `packages/domain/src/events.ts` is `github-issue | manual | agent-followup`.
  It is meant to be an open string, so that adding a store does not change the
  event schema. `githubTicketStore` reports `source: 'github-issue'` even when
  the ticket it wrote lives in `dbTickets` (`ticket-store.ts`).
- **The contract suite does not run against GitHub.** It covers `memoryTickets`
  and `dbTickets` on both SQLite and Postgres; `GitHubClient` is held to the
  `Tickets` type only.
- **`githubTicketStore`'s name now outlives what it does.** It writes through
  whichever `Tickets` a project resolved to, not only GitHub's.

---
*Replaces archived 0036, 0044, 0062, 0072 in [decisions-archive](../decisions-archive/).*
