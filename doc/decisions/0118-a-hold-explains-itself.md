# 0118 — Waiting on you: every hold says what kind it is, what is asked, and what each answer does

**Status** proposed · 2026-10-06

An item in the Waiting lane is waiting on a person, so the page for it is the
person's. It opens with the ticket itself (Problem, Want and Watch out, taken
from the body), then where the pass stopped and what is left to spend (taken
from the log, which costs nothing), then a triage band, then the moves, then
the record. Triage is not a new kind of agent. It is the first turn of the
Discussion that every task page already has, started automatically when a hold
is recorded. It names the cause of the hold, asks the questions only a person
can answer, and recommends one move. An answer is written into the ticket's
body, because that is the only text every later attempt is sure to read. Triage
advises; it never moves the item.

## Context

What reaches a person today is whatever the holder said, written for the
machine: the judge's `why`, cut to 400 characters
(`packages/conductor/src/conduct.ts:3149`), above a collapsed raw block. Every
sentence of it can be true and still leave the reader unable to act. #377's and
#390's holds were each answered in a terminal session that read the branch and
the code around it, because the card could not be acted on as written.

The pieces that session used already exist. Discussion
(`apps/cli/src/discuss.ts`, `packages/conductor/src/discuss.ts`) is answered by
the daemon off the pass path, takes no claim and no lock
(`packages/daemon/src/work-loop.ts:225-243`), and reads files from the mirror at
the base's and each attempt's head sha (`apps/cli/src/discuss.ts:148-213`), so
it needs no worktree. Its answer is a JSON contract with an optional proposal
(`packages/conductor/src/discuss.ts:218-243`). Its `ticket` outcome appends a
section to the issue body (`:646-650`). Its cost is on `DiscussionAnswered` and
`DiscussionHeld`. And the body reaches every later attempt verbatim, as
`{{body}}` in the brief (`packages/conductor/src/prompt.ts:263-291`).

The holds are not one thing. The code reaches `waiting` by five kinds of
route, and they want different moves:

- **A judgement.** A review that rounds could not satisfy. A step that stopped
  to ask (`StepAsked`). A fixer that declined to change anything. A declared
  `human:` or `--no-merge` with every step green.
- **A machine failure.** A check that stayed red, or went red on a moved base.
  A merge the lane refused. A turn or dollar ceiling. An agent that did not
  finish. A `prepared` step that refused before any agent ran.
- **A person's own question.** `lingtai ask`, before any run.
- **Waiting with no block.** `DispatchRefused`, `RunAwaitingInput` and a bare
  `RunFailed` put a card in the lane with `blocked` false, so the card carries
  no move at all (`packages/projector/src/task-view.ts:447-566`).
- **Unpushed work.** It can come on top of any of the above: the branch did not
  reach origin (`conduct.ts:3015-3016`), and the worktree that holds it is
  removed when the pass ends.

## Decision

1. **Every item in the Waiting lane has a kind and at least one move.** The
   kinds are the five above. An item that is waiting without a block is a
   defect of this decision, not a sixth kind: it gets a block, and with it a
   move. Unpushed work is shown first, above everything else on the page, with
   what it takes to rescue it.

2. **The page is in this order:** the ticket, where it is, triage, the moves,
   the record.
   - **The ticket** is the Problem, Want and Watch out rows of the body, and a
     link to the whole body.
   - **Where it is** is the ten-step rail the board already draws, and one line
     under it: what refused, the rounds spent, and the restarts left. It is put
     together from the log every time it is drawn, and never generated.
   - **The record** is History, Diff, Findings, Attempts and Ticket, as tabs.
   - **The card** on the board carries only the number, the title, the rail and
     its line, and triage's cause with one sentence. Everything else, moves
     included, is on the page the card links to.

3. **Triage is a Discussion turn started by the daemon.**
   - After `WorkItemBlocked`, the daemon appends `DiscussionRequested` with the
     triage brief, and the turn runs exactly as any discussion does: off the
     pass, without the lock, reading the mirror.
   - It is declared in the recipe's `discuss:` block with its runtime and
     limits. Where it is not declared, nothing runs, and the page shows the
     ticket, where it is, and the holder's own words.
   - It runs for judgements and machine failures. It does not run for a
     person's own question: the person wrote the question, and the Discussion
     is there if they want to ask the code before answering it.
   - The thread continues below the first turn. A follow-up is an ordinary
     discussion turn.

4. **Triage names one cause, and the budget is not a cause.**
   - The causes are:
     - *a decision for you*: questions only a person can answer;
     - *lines to fix*: specific edits, and the approach is sound;
     - *the approach is wrong*: patching will not converge;
     - *merge by hand*: a conflict;
     - *try it again, narrower*: the run did not finish, and the body can save
       the next one what it spent its turns on;
     - *fix the setup*: the repository or the machine refused before any agent
       ran, so no edit to the ticket can help, and other tickets are refused
       the same way.
   - Rounds and restarts left are facts on the log, shown on the rail line. A
     spent budget changes which moves are offered, never the cause.
   - The answer contract gains these optional fields: the cause, questions each
     with two or three answers and a recommended one, a list of fixes, and
     conflict hunks with a resolution. An answer without them is still a valid
     discussion answer, and the page shows it as text.

5. **When the judge and triage disagree, both are recorded and the person
   decides.** The page shows the two readings side by side and asks which is
   right, so the hold becomes *a decision for you*. Neither one is hidden, and
   the log keeps both.

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
   - A discussion answer can be added to whatever the recommended move will
     write: the body, the list of fixes, a split, or the person's own answer
     box.
   - The other moves keep their notes, and the notes become optional. This
     needs the server's refusals changed:
     - `say why, so the log can`, and `a close needs a reason`
       (`apps/board/src/app/actions.ts:152-211`);
     - the CLI's required `--note`.

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

9. **Triage belongs to the block it explains.** Its turn names the
   `WorkItemBlocked` it answers and the head it read. The page shows it only
   while that block is the current one, so an approve, a requeue or a new head
   retires it, and a triage still running when the person acts is answered
   into a thread nobody is shown.

## Consequences

- **Every hold that is a judgement or a machine failure costs one discussion
  turn**, whether or not anybody opens it. It shows in `/spend` like any other
  discussion, and a recipe that does not want it does not declare it.
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
- **The fix brief for a conflict** tells the agent the merge is in its
  worktree (`packages/conductor/src/fix.ts:634-636`). No code stages it there.
  This is a defect, and its own ticket.
- **The language triage writes in**, and whether the recipe names it.
- **Whether `lingtai status` and the GitHub comment** carry the cause or only
  link to the page.
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
