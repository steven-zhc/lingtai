# 0118 — Waiting on you: every hold says what kind it is, what is asked, and what each answer does

**Status** accepted · 2026-10-07

An item in the Waiting lane is waiting on a person, so the page for it is the
person's. It opens with the ticket itself (Problem, Want and Watch out, taken
from the body), then where the pass stopped and what is left to spend (taken
from the log, which costs nothing), then a triage band, then the moves, then
the record. Triage is an agent the daemon runs when a hold is recorded. It
names the cause of the hold, asks the questions only a person can answer, and
recommends one move, and what it advised is recorded as an event. What the
person then does is the decision, and it is recorded by the move they make. An
answer is written into the ticket's body, because that is the only text every
later attempt is sure to read. Triage advises; it never moves the item.

## Context

What reaches a person today is whatever the holder said, written for the
machine: the judge's `why`, cut to 400 characters
(`packages/conductor/src/conduct.ts:3134-3138`), above a collapsed raw block. Every
sentence of it can be true and still leave the reader unable to act. #377's and
#390's holds were each answered in a terminal session that read the branch and
the code around it, because the card could not be acted on as written.

The machinery that session used already exists, in Discussion
(`apps/cli/src/discuss.ts`, `packages/conductor/src/discuss.ts`). It is
answered by the daemon off the pass path, takes no claim and no lock
(`packages/daemon/src/work-loop.ts:225-243`), and reads files from the mirror at
the base's and each attempt's head sha (`apps/cli/src/discuss.ts:148-213`), so
it needs no worktree. Its answer is a JSON contract
(`packages/conductor/src/discuss.ts:218-243`). Its `ticket` outcome appends a
section to the issue body (`:646-650`). And the body reaches every later
attempt verbatim, as `{{body}}` in the brief
(`packages/conductor/src/prompt.ts:263-291`).

Discussion and triage are not the same thing, though. A discussion is a place
for a person to think with an agent. What comes out of it is the person's own
move, approve, requeue or close, and that move already has its event. The
conversation itself decides nothing and needs no fold. Triage is different. It
is an analysis Lingtai pays for unasked, and its recommendation is a fact the
board has to show on a card and the log has to keep. Then *what the agent
advised* and *what the person chose* sit side by side.

The holds are not one thing, and they are not one kind of thing. Three routes
into `waiting` exclude each other and want different moves:

- **A judgement.** A review that rounds could not satisfy. A step that stopped
  to ask (`StepAsked`). A fixer that declined to change anything. A declared
  `human:` or `--no-merge` with every step green.
- **A machine failure.** A check that stayed red, or went red on a moved base.
  A merge the lane refused. A turn or dollar ceiling. An agent that did not
  finish. A `prepared` step that refused before any agent ran.
- **A person's own question.** `lingtai ask`, before any run.

Two more things put a card in the lane, and neither is a fourth kind. **Waiting
with no block** (`DispatchRefused`, `RunAwaitingInput` and a bare `RunFailed`
leave `blocked` false, `packages/projector/src/task-view.ts:447-566`) is a state
that should not exist. **Unpushed work** (the branch did not reach origin,
`conduct.ts:3071-3072`, and the worktree that holds it is removed when the pass
ends) can come on top of any hold that has a run. Today none of this is
written down: `WorkItemBlocked` carries `needs`, `runId` and `diagnosis`, and
which kind a hold is gets inferred again in each place that needs it, from
`runId === null` in one and `needs` in another.

## Decision

1. **A hold is a value of one type, and the illegal ones cannot be written.**
   The model is a set of tagged unions, in `@lingtai/domain`, and every reader
   matches on them exhaustively:
   - **`Hold`** is exactly one of `Question` (no run: the person's own
     question and who asked it), `Judgement` (a run, the step it stopped at,
     and why), or `Failure` (a run, and what failed).
   - **`Failure`** is itself a union, each variant carrying its own evidence:
     a check that stayed red, a merge the lane refused (its paths and both
     shas), a ceiling (which one, and what was spent), a step that did not
     finish, and a setup that refused before any agent ran (and whether that
     lifts by itself or needs a person).
   - **Unpushed work belongs to the run**, as an optional ref on it, so it can
     sit beside a `Judgement` or a `Failure` and cannot sit beside a
     `Question`, which has no run. It is shown first, above everything else on
     the page, with what it takes to rescue it.
   - **Triage is a second, independent union** (`NotDeclared`, `Running`,
     `Failed`, `Advised`), and an advised triage carries a `Cause` that is a
     union too, each cause with its own parts (§4). What Lingtai knows about a
     hold and what an agent concluded about it are never one field.
   - **A card in the Waiting lane is `Held`, and `Held` carries a `Hold`.**
     *Waiting with no block* therefore has no value to be. The routes that
     produced it either block, with a kind, or do not move the card.
   - **`WorkItemBlocked` records the `Hold` it is**, written by the code that
     appends it, which knows the route. Older events are read through an
     upcaster from `needs`, `runId` and `diagnosis`.
   - **One pure function, `allowedMoves(hold, triage)`, decides the moves.**
     The board, the CLI and the daemon all ask it; none of them keeps a rule of
     its own.

2. **The page is in this order:** the ticket, where it is, triage, the moves,
   the record.
   - **The ticket** is its title, triage's one sentence of what the ticket
     wants when there is one, and the opening of the body, collapsed, with a
     link to the whole of it. A body is not assumed to have any structure: the
     sentence is labelled as triage's reading, never as the ticket's words, and
     is plain text. Where triage could not say what the ticket wants, that is
     itself the hold's question.
   - **Where it is** is the ten-step rail the board already draws, and one line
     under it: what refused, the rounds spent, and the restarts left. It is put
     together from the log every time it is drawn, and never generated.
   - **The record** is History, Diff, Findings, Attempts and Ticket, as tabs.
   - **The card** on the board carries only the number, the title, the rail and
     its line, and triage's cause with one sentence. Everything else, moves
     included, is on the page the card links to.

3. **Triage is its own step, run by the daemon after a block.**
   - After `WorkItemBlocked`, the daemon runs the triage agent the way it runs
     a discussion: off the pass, without the lock, reading the mirror, with no
     tools. It reuses that code, not that conversation.
   - It is declared in the recipe as `triage:` with its runtime and limits.
     Where it is not declared, nothing runs, and the page shows the ticket,
     where it is, and the holder's own words.
   - It runs for judgements and machine failures. It does not run for a
     person's own question, because the person wrote the question.
   - **What it advised is one event, `HoldTriaged`, on the work item's stream.**
     It names the block it explains and the head it read. It carries the cause,
     the questions with their answers and the recommended one, any fixes or
     conflict hunks, the recommended move, one sentence for the card, one sentence of what the ticket wants (or
     none, where the body does not say), and its
     usage ([0110](0110-tokens-on-the-event-money-at-display.md)). A triage
     that fails still appends it, with the failure and the usage and no
     advice.
   - Below triage, the page offers Discussion for follow-ups, opened with
     triage's analysis as its context. Discussion stays what it is: a place to
     think, not a record.

4. **Triage names one cause, and the budget is not a cause.**
   - The causes are:
     - *a decision for you*: questions only a person can answer;
     - *lines to fix*: specific edits, and the approach is sound;
     - *the approach is wrong*: patching will not converge;
     - *merge by hand*: a conflict;
     - *try it again, narrower*: the run did not finish, and either the body
       can save the next one what it spent its turns on, or the ticket asks
       for more than one pass should do and is split into smaller tickets;
     - *fix the setup*: the repository or the machine refused before or around
       any agent's work, so no edit to the ticket can help, and other tickets
       are refused the same way. Triage says which of two it is: a condition
       that lifts by itself, such as an account's usage limit, or one a person
       has to fix, such as a runtime missing the tier the recipe asks for.
   - Rounds and restarts left are facts on the log, shown on the rail line. A
     spent budget changes which moves are offered, never the cause.
   - Advice that will not parse into a cause and its parts is recorded as a
     failed triage, never shown as advice.

5. **When the judge and triage disagree, both are recorded and the person
   decides.** The page shows the two readings side by side and asks which is
   right, so the hold becomes *a decision for you*. Neither one is hidden, and
   the log keeps both: the judge's on `PassRouted`, triage's on `HoldTriaged`.

6. **An answer is written into the body.**
   - *Write it into the body & requeue* is one move. It appends a section to
     the ticket's body through the existing `ticket` outcome, then requeues.
   - **The body is written first.** If the write fails, nothing is requeued
     and the page keeps the text, so no pass ever starts without the answer.
     If the requeue is refused after the write, the page says what the item's
     state is now. The usual reason is that someone else already requeued it,
     and then the next pass reads the body anyway.
   - The appended text is composed from the answers the person picked. It is
     editable, and it stops following the answers once it is edited.
   - The requeue's reason is written for the person from those answers. They
     are not asked for one.
   - **The person's move records what they chose against what was advised.**
     `WorkItemUnblocked`, `ApprovalGranted` and `WorkItemClosed` gain an
     optional reference to the `HoldTriaged` they answer and whether the move
     taken was the one it recommended. How often the advice is taken is then a
     query, not a guess.
   - A discussion answer can be added to whatever the recommended move will
     write: the body, the list of fixes, a split, or the person's own answer
     box.
   - **A requeue's note is optional, and the CLI's `--note` is no longer
     required** (#424) — `say why, so the log can`
     (`apps/board/src/app/actions.ts:154`) and the CLI's refusal
     (`apps/cli/src/requeue.ts`) are gone, and a blank note is stored as
     empty, never invented.
   - **A close keeps its required reason.** Unlike a requeue, nothing lifts a
     close: it is "the only decision that cannot be revisited, so the sentence
     explaining it is the last thing anybody will have"
     (`packages/conductor/src/close.ts:71-73`), and `a close needs a reason`
     (`close.ts:99-100`) stays on the board, the CLI and the conductor.
   - **The seam for a prefill exists and nothing wires it yet** (#424): `Close`
     takes an optional `prefill` and seeds its box from it
     (`apps/board/src/app/decide.tsx`), but `HoldTriaged` has no schema,
     `task_view` has no triage column, and every `<Close>` call site is
     unchanged. Once triage lands (§3, §10), passing its one sentence in is
     what makes the close box start filled — still a box the person can
     clear, which still refuses.

7. **A requeue keeps its meaning.** A person's requeue is a new pass cut from
   the base, with the recipe's rounds again. It does not spend a restart and
   does not refund one: `restarts` grows only on `PassRestarted`
   (`packages/domain/src/work-item.ts:278-299`), and a requeue appends only
   `WorkItemUnblocked` (`packages/conductor/src/approve.ts:524-534`). Every
   cost line on the page says so.

8. **A merge conflict is triaged.**
   - The lane records only the conflicting paths
     (`packages/repo/src/integrate.ts:401-413`), so triage reads both sides
     from the mirror.
   - It resolves the mechanical hunks, and asks one question for each hunk
     whose behaviour differs on the two sides. The page lists every hunk with
     its status and opens only the ones that need the person.
   - Past 20 hunks it does not resolve them one by one. It recommends starting
     over from the new base.

9. **Triage belongs to the block it explains.** `HoldTriaged` names the
   `WorkItemBlocked` it answers and the head it read. The page and the card
   show it only while that block is the current one, so an approve, a requeue
   or a new head retires it. A triage that finishes after the person has acted
   is still recorded, for its cost, and shown nowhere.

10. **The card reads triage from `task_view`.** The projection folds
    `HoldTriaged` into three columns: the triage state (running, advised or
    failed), the cause, and the one sentence. A running triage is the block
    with no `HoldTriaged` yet, while `triage:` is declared. The full advice is
    read from the event by the task page. Adding the columns is a rebuild:
    `lingtai projection rebuild task_view`.

## Consequences

- **Every hold that is a judgement or a machine failure costs one triage
  run**, whether or not anybody opens it. Its usage is on `HoldTriaged`, so it
  shows in `/spend`, and a recipe that does not want it does not declare it.
- **The log can answer how good the advice is.** `HoldTriaged` and the move that
  answered it are both on the item's stream.
- **Triage never delays the queue.** It runs beside the next pass, not inside
  this one.
- **The holder's own text becomes evidence**: the judge's `why`, git's words
  and the step's raw output. It sits in the record and in the side-by-side when
  there is a disagreement. It is no longer the message.
- **The body grows a section per answered hold.** That is the point: it is the
  durable, free place a decision is kept, and the place the next attempt reads
  from.

## Not decided here

- **Three moves the pages need and the board does not have:**
  - one more round on the current branch, past the recipe's rounds;
  - splitting a ticket into chained tickets;
  - merging the base into the branch with a conflict's resolution.

  Each changes what a pass may buy ([0108](0108-a-refusal-buys-a-round.md)),
  and each is its own ticket.
- **The language triage writes in**, and whether the recipe names it.
- **Whether `lingtai status` and the GitHub comment** carry the cause or only
  link to the page.
- **Whether Discussion's turns leave the event log.** Today they are events
  on `chat-<id>` streams. A discussion decides nothing, so its text is a trace
  rather than a record, but its usage still needs somewhere to be counted.
  That is Discussion's own decision. Triage depends on none of it.
- **The per-kind table** of trigger, page, recommended move and whether triage
  runs. It is design, not decision, and belongs in `doc/design/`.

## Mockups

[`0118/`](0118/index.html) holds the pages this decision was drawn against:
the board's Waiting column, #390's page, and one page for each other cause,
the merge conflict, the questions, and what follows a move. They open directly
in a browser. `dc-lite.js` beside them is all they run. They illustrate the
decision and do not extend it: where a mockup and this text differ, this text
is the decision.

---
*New topic; replaces no archived ADR. The design discussion is #388.*
