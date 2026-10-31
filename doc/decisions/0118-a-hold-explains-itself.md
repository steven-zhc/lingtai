# 0118 — Waiting on you: every wait says what kind it is, what is asked, and what each answer does

**Status** accepted · 2026-10-07 · types settled 2026-10-12 with [0120](0120-a-reason-is-a-type.md) · §3 amended 2026-10-24 with tool-enabled Codex triage (#569) · §12 amended 2026-10-26 (#605)

An item in the Waiting lane is waiting on a person, so the page for it is the
person's. It opens with the ticket itself (its title, triage's reading of
what it wants, and the opening of the body, §2), then where the pass stopped and what is left to spend (taken
from the log, which costs nothing), then a triage band, then the resolutions, then
the record. Triage is an agent the daemon runs when a wait is recorded. It
names the cause of the wait, asks the questions only a person can answer, and
recommends one resolution, and what it advised is recorded as an event. What the
person then does is the decision, and it is recorded by the resolution they choose. An
answer is written into the ticket's body, because that is the only text every
later attempt is sure to read. Triage advises; it never moves the item.

## Context

What reaches a person today is whatever the stopping step said, written for the
machine: the judge's `why`, cut to 400 characters
(`packages/conductor/src/conduct.ts:3134-3138`), above a collapsed raw block. Every
sentence of it can be true and still leave the reader unable to act. #377's and
#390's waits were each answered in a terminal session that read the branch and
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
resolution (approve, requeue or close), and that resolution already has its event. The
conversation itself decides nothing and needs no fold. Triage is different. It
is an analysis Lingtai pays for unasked, and its recommendation is a fact the
board has to show on a card and the log has to keep. Then _what the agent
advised_ and _what the person chose_ sit side by side.

The waits are not one thing, and they are not one kind of thing. Three routes
into `waiting` exclude each other and want different resolutions:

- **A judgement.** A review that rounds could not satisfy. A step that stopped
  to ask (`StepAsked`). A fixer that declined to change anything. A declared
  `human:` or `--no-merge` with every step green.
- **A machine failure.** A check that stayed red, or went red on a moved base.
  A merge the lane refused. A turn or dollar ceiling. An agent that did not
  finish. A `prepared` step that refused before any agent ran.
- **A person's own question.** `lingtai ask`, before any run.

Two more things put a card in the lane, and neither is a fourth kind. **Waiting
with no block** (`RunAwaitingInput` and a bare `RunFailed` leave `blocked`
false, `packages/projector/src/task-view.ts:447-566`) is a state that should
not exist. `DispatchRefused` moves nothing into this lane since `#405`: the
refusal is the pass's rather than this item's, so the fold leaves an item that
was merely queued `queued` and the conductor pauses instead — and leaves an
item already in this lane on a question exactly as it was, because only a
person's answer may lift that. **Unpushed work** (the branch did
not reach origin,
and the worktree that holds it is removed when the pass
ends) can come on top of any wait that has a run. Today none of this is
written down: the wait's event carried `needs`, `runId` and `diagnosis`, and
which kind a wait was got inferred again in each place that needed it, from
`runId === null` in one and `needs` in another.

## Decision

1. **A wait is a value of one type, and the illegal ones cannot be written.**
   The model is a set of tagged unions in `@lingtai/domain`, following
   [0120](0120-a-reason-is-a-type.md)'s principles, and every reader matches
   on them exhaustively.

   ```ts
   type RunRef = {
     runId: string
     unpushed?: {
       branch: string
       said: string
       // where the work is now (#421): kept in the mirror, or on origin as the arm
       keptAt?: { _tag: 'Mirror'; ref: string; sha: string; arm: string } | { _tag: 'Arm'; ref: string; sha: string }
     }
   }

   type WaitReason =
     // someone is asking
     | { _tag: 'OwnQuestion'; question: string; by: string } // a person's own, through `lingtai ask`
     | { _tag: 'AgentQuestion'; run: RunRef; step: 'design' | 'implement'; question: string }
     // a person decides
     | { _tag: 'SignoffRequired'; run: RunRef; step: 'proposed' | 'merge'; action: string; question: string }
     | { _tag: 'FixerDisagrees'; run: RunRef; said: string | null } // a fix round's implement changed nothing
     | { _tag: 'NothingProduced'; run: RunRef; said: string | null } // a first dispatch's implement changed nothing
     | { _tag: 'ProposedEscalated'; run: RunRef; proposal: Proposal; because: EscalationBecause }
     | {
         _tag: 'CheckRefused'
         run: RunRef
         step: 'proposed' | 'merge'
         action: string
         evidence: string
         findings: Finding[]
       }
     // the machine fell short, and nobody decided it
     | {
         _tag: 'MergeRefused'
         run: RunRef
         reason: Exclude<RefusalReason, 'conflict' | 'verify-failed' | 'base-moved'>
         raw: string
       }
     | {
         _tag: 'BudgetExhausted'
         run: RunRef
         cause: 'out-of-turns' | 'out-of-usd'
         detail: string
       }
     | {
         _tag: 'AgentCrashed'
         run: RunRef
         step: 'admit' | 'prepared' | 'design' | 'implement' | 'build' | 'review' | 'proposed' | 'merge' // all but `claim`, `end`
         cause: 'crash' | 'timeout' | 'aborted'
         detail: string
       }
     | { _tag: 'SetupRefused'; run: RunRef; step: Step; action: string; why: string }
     | {
         _tag: 'AnswerUnreadable'
         run: RunRef
         step: 'design' | 'review' | 'proposed' | 'merge'
         action: string
         raw: string
       }

   type EscalationBecause =
     | Extract<RouteDecision, { _tag: 'Escalated' }>['because'] // 0120 §3
     | { _tag: 'JudgeHandedOver'; why: string }
   ```

   - **No pass builds the seven direct variants.** `FixerDisagrees`,
     `NothingProduced`, `CheckRefused`, `MergeRefused`, `BudgetExhausted`,
     `SetupRefused` and `AnswerUnreadable` reach a person only inside
     `ProposedEscalated` over a `Proposal` (`pass-next.ts`). They stay in the
     union, with their rows in `allowedResolutions` and their words in
     `waitWords`, so that a `WaitStarted` carrying one still parses and reads.
   - **The name is the page's.** The lane is _Waiting on you_ and its id is
     `waiting`, so the card is `Waiting`, the union is `WaitReason`, and the
     events are `WaitStarted`, `WaitResolved` and `WaitTriaged`. _You_ stays on
     the page: a log or a CLI has no fixed reader. **_Hold_ means one thing,
     `agent:hold`**: a person keeping a queued ticket from being claimed, the
     opposite direction.
   - **A wait is classified where the pass decides it**, never by which
     internal value happened to be set on the way. Two pure functions build a
     `WaitReason` from a run and nothing else does: `routeNext` for everything
     `proposed` hands to a person (`ProposedEscalated`, and `AgentQuestion` for
     a question no judge answers), and `nextOf` for the rest (0120 §4). Their
     exhaustive tests together cover every variant. `OwnQuestion` is
     `lingtai ask`'s. Every proposal the route hands over is
     `ProposedEscalated`, whatever it was: a build that stayed red with the
     rounds spent is `ProposedEscalated{BuildRed}`, an unsatisfied review
     `ProposedEscalated{ReviewFindings}`, and the evidence travels inside the
     proposal.
   - **Each variant is a different thing to do.** A crash is usually re-run; a
     spent budget wants the ticket smaller first; a fixer that changed nothing
     disagrees with the reviewer and a person referees; a first dispatch that
     changed nothing has only the ticket to argue with (it is done already, or
     unclear). A setup that refused is the machine's: a check at `prepared`, a
     file not kept, a tree not cut. A wall that lifts by itself is not a wait
     at all but a requeue (0120 §4). An unreadable answer is the machinery
     losing a judgement, a thing to re-run, never _the reviewer had nothing_
     (`ReviewEmpty`). A check declared at `proposed` or before the lane at
     `merge` that refuses is `CheckRefused`.
   - **How the card groups them is the board's.** The comment lines above are
     for reading; nothing branches on a category, so none is a type.
   - **Unpushed work belongs to the run**, as an optional ref on `RunRef`, so
     it can sit beside any wait with a run and cannot sit beside an
     `OwnQuestion`. It is shown first, above everything else, with what it
     takes to rescue it.
   - **The wait's event records the `WaitReason` and nothing beside it**, with
     the `waitId` that names this wait: `WaitStarted { waitId, reason }`. The words a person reads
     live inside the variant that owns them, so `needs`, `question` and
     `diagnosis` are gone: two representations of one wait can disagree.
     **There is no upcaster**: before 1.0 the log is reset across a change of
     shape, as it was in 007 and 010.
   - **Triage is two more unions, a fact and a view of it.**

     ```ts
     type RootCause =
       | { _tag: 'UndecidedQuestion'; questions: Question[] }
       | { _tag: 'FixableLines'; fixes: LineFix[] }
       | { _tag: 'WrongApproach' }
       | { _tag: 'ConflictingHunks'; hunks: Hunk[]; total: number }
       | { _tag: 'TicketTooBig' }
       | { _tag: 'SetupBroken' }
     type TriageResult =
       | { _tag: 'TriageFailed'; why: string }
       | { _tag: 'TriageAdvised'; cause: RootCause; resolution: TriageAdvice; summary: string; want: string | null }
     type TriageAdvice = 'Approve' | 'Requeue' | 'EditBodyAndRequeue' | 'Close' | 'GrantFixRound' | 'Split' // a Resolution's tag, never AnswerQuestion
     type TriageStatus =
       // derived on read, never stored
       | { _tag: 'NotNeeded' }
       | { _tag: 'NotDeclared' }
       | { _tag: 'Queued' }
       | { _tag: 'Running' }
       | { _tag: 'Interrupted' }
       | { _tag: 'Done'; result: TriageResult }
     ```

     Triage advises a resolution by its kind alone: it never supplies an
     `onSha`, because a person confirms the exact branch state shown. It never advises `AnswerQuestion`, which belongs to `OwnQuestion`, a wait it
     does not read. `TriageResult` is what `WaitTriaged` records. `TriageStatus` is what the
     page and `recommendedResolution` match on, and what the daemon starts
     triage on: it starts one for `Queued`, and on its own start retries an
     `Interrupted` one (§3). It is derived from the wait
     first and then from the strongest fact: a wait triage does not read is
     `NotNeeded` (§3), whatever the recipe or the log says; otherwise a result
     for the current wait's latest attempt is `Done`, whatever
     the recipe says now; an attempt started with no result is `Running`, or
     `Interrupted` if it started before the running daemon did; a wait with
     neither is `Queued` while `triage:` is declared, and `NotDeclared`
     otherwise. A recipe that stops declaring triage does not hide a result
     already paid for. What Lingtai knows about a wait and what an agent
     concluded about it are never one field.

   - **A card in the Waiting lane is `Waiting`, and `Waiting` carries a
     `WaitReason`.** _Waiting with no block_ therefore has no value to be.
   - **What a person does about a wait is a `Resolution`**, how the wait ends:

     ```ts
     type ChildTicket = { key: string; title: string; body: string }
     type Dependency = { ticket: string; blockedBy: string } // child keys in the approved plan
     type Resolution =
       | { _tag: 'Approve'; onSha: string } // continue the run (§11); refused if the branch moved
       | { _tag: 'Requeue' } // a new pass from the base
       | { _tag: 'EditBodyAndRequeue' } // write into the body, then requeue
       | { _tag: 'GrantFixRound'; onSha: string; ref: string } // one human-granted round on a recorded remote ref
       | { _tag: 'Split'; children: ChildTicket[]; blockedBy: Dependency[] } // approved tickets and chain
       | { _tag: 'AnswerQuestion'; choice: string } // an OwnQuestion only
       | { _tag: 'Close' }

     const allowedResolutions: (reason: WaitReason) => Resolution['_tag'][]
     const recommendedResolution: (reason: WaitReason, triage: TriageStatus) => Resolution['_tag'] | null
     ```

     Which of these continue the saved branch and which cut a new one from the
     base is the [glossary's _What happens next_](../glossary.md#what-happens-next).

     `Approve`, `Requeue` and `Close` keep the names of the CLI commands and
     the board's buttons. `GrantFixRound` is a person's separately logged grant
     under [0108](0108-a-refusal-buys-a-round.md) §8, and it is how a conflict is
     answered; `Split`
     approves concrete child tickets and their dependency chain. The child and
     dependency values here describe the person's approved plan, not a claim
     that these contracts are implemented.

   - **One pure function, `allowedResolutions(reason)`, decides the
     resolutions**, from the wait alone. The board, the CLI and the daemon all
     ask it; none keeps a rule of its own. **Triage is not an input**: it
     advises and never moves the item. The whole table, with where an approval
     continues (§11):

     | `WaitReason`                                                             | Allowed (`GrantFixRound` only on its criterion, below)                        | `Approve` continues at         |
     | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------ |
     | `OwnQuestion`                                                            | `AnswerQuestion`, `Requeue`, `Close`                                          | —                              |
     | `AgentQuestion`                                                          | `EditBodyAndRequeue`, `Requeue`, `Close`                                      | —                              |
     | `SignoffRequired`                                                        | `Approve`, `Requeue`, `EditBodyAndRequeue`, `Close`                           | its step, the signoff `Waived` |
     | `CheckRefused`                                                           | `Approve`, `GrantFixRound`, `Requeue`, `EditBodyAndRequeue`, `Close`          | its step, the check `Waived`   |
     | `FixerDisagrees`                                                         | `Approve`, `GrantFixRound`, `Requeue`, `EditBodyAndRequeue`, `Close`          | `proposed`                     |
     | `ProposedEscalated` over `ReviewFindings`                                | `Approve`, `GrantFixRound`, `Requeue`, `EditBodyAndRequeue`, `Split`, `Close` | `proposed`                     |
     | `ProposedEscalated` over `ReviewEmpty`                                   | `Approve`, `Requeue`, `EditBodyAndRequeue`, `Close`                           | `proposed`                     |
     | `ProposedEscalated` over `BuildRed` or `VerifyRed`                       | `GrantFixRound`, `Requeue`, `EditBodyAndRequeue`, `Split`, `Close`            | —                              |
     | `ProposedEscalated` over `MergeConflict`                                 | `GrantFixRound`, `Requeue`, `Close`                                           | —                              |
     | `ProposedEscalated` over `InputNeeded`                                   | `EditBodyAndRequeue`, `Requeue`, `Close`                                      | —                              |
     | `MergeRefused`                                                           | `Approve` (once the base is fixed), `Requeue`, `Close`                        | `merge`                        |
     | `ProposedEscalated` over `BaseMoved`                                     | `Approve` (keep merging the base in), `Requeue`, `Close`                      | `merge`                        |
     | `NothingProduced`, `BudgetExhausted`, `AgentCrashed`, `AnswerUnreadable` | `EditBodyAndRequeue`, `Split`, `Requeue`, `Close`                             | —                              |
     | `SetupRefused`                                                           | `Requeue`, `Close`                                                            | —                              |
     | `AgentCrashed` with a standing wait (#654)                               | that wait's resolutions on the unmoved head, plus `Requeue`, `Close`          | that wait's                    |
     - `BaseMoved` is held only after the system's own two merges of the base
       are spent (0120 §3, #593); `Approve` continues at `merge` as a new pass
       whose count is zero, so it reads as _keep merging the base in_, and no
       fix round is granted — there is nothing wrong with the lines.
     - `FixerDisagrees`' `Approve` sides with the fixer; `EditBodyAndRequeue`
       sides with the reviewer.
     - `NothingProduced` has no `Approve`: there is nothing on the branch to
       merge.
     - **Unpushed work drops `Approve` and `GrantFixRound`**
       for every variant that has a `run`: when `run.unpushed` is set the branch
       never reached origin and the worktree that held it is gone, so an
       `Approve{onSha}` would name a sha that exists nowhere and there is
       nothing to continue.
     - `ProposedEscalated` carries the proposal the work fell short with
       (0120): over `CheckRefused`, `FixerDisagrees` or `MergeRefused` it is
       allowed what that variant's own row allows; over `NothingProduced`,
       `BudgetExhausted`, `AnswerUnreadable` or `SetupRefused`, likewise. Only
       its own `ReviewFindings`, `ReviewEmpty`, `BuildRed`, `VerifyRed`,
       `MergeConflict` and `InputNeeded` follow their rows above.
     - `GrantFixRound` is offered for fixable review findings (including a fixer
       that disagreed), a red build or verification, a check refusal with
       evidence, or a merge conflict, with work preserved on a recorded remote ref. It authorizes
       exactly one additional `implement` round on that saved head under
       [0108](0108-a-refusal-buys-a-round.md) §8, subject to that run's `turns`,
       `wall` and declared `usd` limits. It changes no recipe limit and waives no
       refusal. The ref must still exist at the recorded head sha when the
       grant is used; a missing or moved ref refuses it. No branch to fix or no
       criterion for a fixer means no grant. **The criterion is one function**,
       `grantCriterion`, "for both the offer (`allowedResolutions`) and the
       brief (`conduct.ts`), so they cannot drift apart": `CheckRefused` needs
       non-empty `evidence` or a finding with a non-empty `failureScenario`;
       `FixerDisagrees` a non-empty `said`; `ReviewFindings` some finding with a
       non-empty `failureScenario`; `BuildRed` and `VerifyRed` non-empty
       `output`; `MergeConflict` always has one (its brief is the merge step
       with the paths as detail). A reason with no criterion is never offered it. The grant and the round's spend
       are logged separately; another round needs another decision. The result
       visits `build`, `review` and `proposed` again before merge (§11).
     - `Split` is offered on waits where an oversized ticket may be the cause.
       Its child plan still needs the person's concrete approval (§12); triage
       may recommend it at the first wait, without waiting for the round budget
       to run out.
     - `ProposedEscalated` over `BuildRed`, `VerifyRed`, `MergeConflict` or
       `InputNeeded` has no `Approve`. Merging a red build would break _every
       path into `end` has been through `build`_; a conflict needs resolving
       and then another build and review; a question wants an answer.
       Today a red build can be approved with a reason; that goes.
     - An approval over a refusal needs a note (`lingtai.ts:169` already asks
       for one), kept as `WaitResolved.note`.

   - **A second pure function, `recommendedResolution(reason, status)`, picks
     at most one of those** to draw first and prefill. An advised resolution is
     recommended when `allowedResolutions` offers it, and otherwise is not, its
     words still shown. With no advice (not needed, not declared, queued,
     running, interrupted or failed) the wait's own default stands: `Approve` for `SignoffRequired`, `Requeue` for
     `BudgetExhausted` and `AgentCrashed`, nothing elsewhere. `TicketTooBig`
     may advise `Split` at the first wait; `ConflictingHunks` shows its hunks
     and advises nothing past `GrantFixRound` while the conflict is at most 5
     hunks (`CONFLICT_ROUND_HUNKS`): there `GrantFixRound` is recommended
     whatever resolution triage chose, shown beside triage's own words, and the
     fix brief carries each divergent hunk's recommended answer. Above 5,
     triage's resolution stands. The person chooses before either
     action runs.

2. **The page is in this order:** the ticket, where it is, triage, the resolutions,
   the record.
   - **The ticket** is its title, triage's one sentence of what the ticket
     wants when there is one, and a bounded reading of the issue's opening
     table when it follows this repository's Problem, Want, Fix and optional
     Watch out style. Problem, Want and Watch out appear in that order before
     the rail. An unrecognized table gets only the link to the complete issue;
     no fields are inferred. The complete body is one click
     away in the Ticket record. Triage's sentence is labelled as its reading,
     never as the ticket's words, and is plain text. Where triage could not say
     what the ticket wants, that is itself the wait's question.
   - **Where it is** is the ten-step rail the board already draws, and one line
     under it: what refused, the automatic rounds spent, any human-granted
     rounds and their spend, and the restarts left. It is put together from the
     log every time it is drawn, and never generated. Once triage has advised,
     the stopping step's own sentence is not repeated above it — triage's panel
     says what stopped and why — and the rail and its line are the whole of
     where it is. Evidence a person needs and triage does not carry, such as a
     conflict's paths, still shows.
   - **The record** is History, Diff, Findings, Attempts and Ticket, as tabs.
   - **A queued, running or approved ticket's page is drawn on the same
     frame**, and only what fills the panel and the moves differs. The header
     is the number, the state and its age as one line, the title, and the
     opening; the rail is drawn under it in every one of these states — the
     run in flight, live, on a running ticket, and the last pass on a queued
     or approved one. Where the panel says triage on a wait, a queued ticket's
     says why it is not moving — once, with the last pass's refusal whole and
     named as the last pass — and a running ticket's is the run log. What the
     next pass will do at each step is folded into the rail, one cell under
     each step, not drawn as a second list of the same ten steps. The
     prompt that will be sent is folded by default beside Discussion, because
     the opening above and the Ticket record already say it.
     [design/queued-page.html](../design/queued-page.html) is the drawing.
   - **The card** on the board carries the number, the title, the rail and its
     line (a card held for a person's approval carries the rail with no line
     under it, and one line of its own: a `WAITING FOR YOU` badge, `waitWords`'
     `short` and its age), triage's cause with one sentence, and, once triage has advised, one
     button: the resolution `recommendedResolution` names. `GrantFixRound`,
     `Requeue` and `Approve` resolve the wait in one click, through the same
     actions the page uses and refused the same way when the card is stale. An
     `Approve` over a step that still refuses records the note
     `accepted triage's recommendation: <triage's sentence>`, so the waiver
     names whose reading it took. `EditBodyAndRequeue`, `Split`,
     `AnswerQuestion` and `Close` open the page at that resolution and write
     nothing. Every other resolution is on the page the card links to.

3. **Triage is its own step, run by the daemon after a wait is recorded.**
   - **The decisions are pure and the effects are the shell's**, as
     [0120](0120-a-reason-is-a-type.md) sets out for every reason. Pure,
     reading no store, clock, git or process: whether triage runs and how its
     state reads (one function, `triageStatus`), which resolution is drawn
     first (`recommendedResolution`), and what the body becomes with an answer in it
     (`upsertSection`, #446). The shell's: running the triage agent, writing
     the body to GitHub (`updateBody`), and appending `TriageStarted` and
     `WaitTriaged`. A shell step calls the pure function and acts on its
     answer; a pure function never calls the shell.
   - After the wait's event, the daemon runs the triage agent the way it runs
     a discussion: off the pass, without the lock. It reuses that code, not
     that conversation. The recipe's `triage.tools` chooses between two routes:
     - **`none`, the default.** Reading the mirror, with no tools. Claude Code
       denies every tool; Codex reaches the model-only Responses route, billed
       separately under `codex_text` ([0106](0106-a-role-keeps-its-powers-across-runtimes.md) §6).
     - **`full`, Codex only.** The Codex CLI with its shell, run in a private
       clone of the mirror at the attempt's recorded head, or the base where
       none was recorded. The checkout protects the mirror, its refs and
       `origin`, which it cannot write; no Git hook runs in it, and nothing
       pushes, merges or claims; edits die with the directory. It does **not**
       protect host files, which stay readable by absolute path; the real
       `CODEX_HOME`, which is the login and is in reach by design because
       Codex rotates its token in place, so any Codex hook already configured
       there is loaded and runs (the run ignores neither the user's Codex
       configuration nor its hooks); the network, which is whatever the
       Codex CLI's own sandbox gives; or a checkout whose tool processes
       could not be confirmed dead, which is left on disk rather than
       deleted. This is not Discussion's containment. Discussion keeps no
       tools, and its recipe block has no key to ask otherwise.
   - It is declared in the recipe as `triage:` with its runtime and limits.
     Where it is not declared, nothing runs, and the page shows the ticket,
     where it is, and the stopping step's own words.
   - It runs for judgements and machine failures. It does not run for a
     person's own question (`OwnQuestion`), because the person wrote the
     question, nor for a declared signoff (`SignoffRequired`), where every
     step passed and nothing refused, so there is nothing to diagnose. Those
     two are `TriageStatus.NotNeeded`, decided inside `triageStatus` by a
     switch over `WaitReason` with no `default`, so a new variant cannot be
     added without saying whether triage reads it. There is no separate
     predicate beside it: whether triage runs and how its state reads are
     one answer, and two functions could disagree.
   - **What it advised is one event, `WaitTriaged`, on the ticket's stream.**
     It names the wait it explains and the head it read, and who answered: `Agent`, with its runtime and model, or `Mechanical`, when Lingtai answered without calling an agent (§8). **It carries no spend.** What an agent's triage cost is one `RunSpent { for: Triage { waitId } }`, appended where the runtime reported it, as every paid call is ([0110](0110-tokens-on-the-event-money-at-display.md) §10); a mechanical answer called nothing and appends none. Its result is
     a `TriageResult`, `TriageFailed` or `TriageAdvised`, the same type and not a copy of it,
     so an advised triage with a failure, or a failed one with advice, cannot
     be written. `Advised` carries the cause, the recommended resolution, one
     sentence for the card (`summary`), and one sentence of what the ticket
     wants (`want`, `null` where the body does not say). **The parts belong to the cause**:
     the questions, with their answers and the recommended one, exist only in
     _a decision for you_, or inside the conflict hunk they are about; the
     fixes only in _lines to fix_; the conflict hunks only in _merge by hand_.
     None of them is repeated beside the cause.
     Where the body does not say what the ticket wants, that question is a
     decision for you. A triage that fails still appends it, with the
     failure; what it spent is its `RunSpent`, as for any other attempt. **What the agent writes is bounded**, because it
     is kept for good and drawn on the page: a few questions with a few
     answers each, a bounded number of fixes and hunks, and short text, with
     the numbers in the schema. An answer past them is refused, and that
     refusal is a failed triage.
   - **A triage is keyed by its wait, and its attempts are on the log.**
     The key is the ticket and the wait's `waitId`, and
     nothing else: the head is recorded for the audit, and a recipe edit does
     not re-triage every waiting card. Before the agent is dispatched,
     `TriageStarted` names the wait and the attempt; `WaitTriaged` carries
     the same attempt, and only the latest attempt's result is read. The
     daemon is the only process that triages, under its own lock, so no claim
     is needed beside it.
   - **A triage can be stopped, and a stopped one is recorded.** It runs
     under the recipe's `triage:` wall, which must be shorter than the
     daemon's subscriber timeout; at the wall the agent is killed, a failed
     `WaitTriaged` is appended, and what the runtime reported spending is its
     `RunSpent`.
     On the `full` route only the wall stops the agent: turns are checked
     between read rounds, not inside one CLI call, and the dollar limit never
     fires because the CLI receipt reports none. The log does not record which
     route ran — `WaitTriaged.by` is the runtime and model, and `RunSpent.costUsd`
     is `null` on both Codex routes — so the route is read from the recipe in
     force, and `doctor` and the board say which it is.
   - **On start, the daemon catches up only on waits still current.** A
     wait with no `TriageStarted` is triaged; one whose last attempt started
     before this daemon did and never finished was interrupted, and is tried
     again, at most twice in all. A second interruption appends a failed
     `WaitTriaged` and is left to the person.
   - **A failed triage is final.** Any failure of the triage call, whether a
     crash, a timeout, an abort or a usage limit, running out of turns, spend
     that cannot be recorded, or an answer past the schema's bounds, appends a
     failed `WaitTriaged` and stops. Nothing triages that wait again: catch-up
     re-runs only an attempt that was interrupted, and a finished attempt is
     final whatever it answered. A person who wants another reading opens
     Discussion.
   - Below triage, the page offers Discussion for follow-ups, opened with
     triage's analysis as its context. Discussion stays what it is: a place to
     think, not a record.

4. **Triage names one cause, and the budget is not a cause.**
   - The causes are:
     - _a decision for you_ (`UndecidedQuestion`): questions only a person can answer;
     - _lines to fix_ (`FixableLines`): specific edits, and the approach is sound;
     - _the approach is wrong_ (`WrongApproach`): patching will not converge;
     - _merge by hand_ (`ConflictingHunks`): a conflict;
     - _try it again, narrower_ (`TicketTooBig`): the run did not finish, and
       either the body can save the next one what it spent its turns on, or
       the ticket asks for more than one pass should do and is split into
       smaller tickets;
     - _fix the setup_ (`SetupBroken`): the repository or the machine refused
       before or around any agent's work, so no edit to the ticket can help,
       and other tickets are refused the same way. A condition that lifts by
       itself, such as an account's usage limit, never waits: it is a requeue
       (0120 §4).
   - Rounds and restarts left are facts on the log, shown on the rail line,
     anywhere the budget is drawn. A restart ceiling of 0 with none taken is
     not shown: a ceiling nothing configured and nothing spent is no fact to a
     reader. A
     spent budget changes which resolutions are offered, never the cause.
   - Advice that will not parse into a cause and its parts is recorded as a
     failed triage, never shown as advice.

5. **When the judge and triage disagree, triage's advice stands.** The page
   shows triage's reading and recommends what triage recommends; the judge's
   routing is not drawn as a second reading, and the person is not asked to
   pick between them.
   - The judge's decision has already happened: it is why the pass stopped and
     the person is on this page. Shown again, it only competes for attention
     with the advice the person came to act on.
   - Triage knows more. The judge reads the reviewer's findings and the step's
     output, and nothing else — no ticket, no diff, no files. Triage reads the
     ticket, the diff and the code, with the judge's routing in front of it.
   - The log still keeps both: the judge's on `PassRouted`, triage's on
     `WaitTriaged`. The judge's words remain in the record.

6. **An answer is written into the body.**
   - _Write it into the body & requeue_ is one resolution. It writes a section to
     the ticket's body through the existing `ticket` outcome, then requeues.
   - **Each wait's answer is one section, found by a marker** naming the
     ticket and the wait's `waitId`. Writing it again replaces that section or
     leaves it, and never adds a second, so a retry is safe. When a write's
     outcome is unknown, the body is read back: the section as written means
     it landed. A tracker with a conditional write (Lingtai's own table)
     refuses a body that changed since it was read; GitHub has none, so there
     the write is read back after it lands and the section restored if
     another write removed it, and an edit made in the moment between the
     read and the write can still be lost.
   - **The body is written first.** If the write fails, nothing is requeued
     and the page keeps the text, so no pass ever starts without the answer.
     If the requeue is refused after the write, the page says what the item's
     state is now. The usual reason is that someone else already requeued it,
     and then the next pass reads the body anyway.
   - The appended text is composed from the answers the person picked. It is
     editable, and it stops following the answers once it is edited.
   - The requeue's reason is written for the person from those answers. They
     are not asked for one.
   - **Which advice a resolution answered is derived, never written.** A
     resolution is one event, `WaitResolved { waitId, by, resolution, note }`
     A resolution answers the `WaitTriaged` of the wait that
     was current when it was made, and both are on the item's stream, so a query
     finds the pair for board and CLI alike. Whether the resolution matched the
     advice is decided in that query too, so a change to what counts as
     matching changes every answer, old ones included.
   - A discussion answer can be added to whatever the recommended resolution will
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
     (`apps/board/src/app/decide.tsx`), but nothing appends `WaitTriaged` yet,
     `task_view` has no triage column, and every `<Close>` call site is
     unchanged. Once triage lands (§3, §10), passing its one sentence in is
     what makes the close box start filled — still a box the person can
     clear, which still refuses.

7. **A requeue keeps its meaning.** A person's `Requeue` is a new pass cut from
   the base, with the recipe's rounds again. It leaves the saved work behind;
   `GrantFixRound` instead continues that work for one paid `implement` round
   under §1 and 0108 §8. A requeue does not spend or refund an automatic
   restart: restarts are counted from
   `TicketReleased{cause: Restart}` (0120 §5), and a person's requeue
   releases with `cause: ByPerson`. Every cost line on the page says so.

8. **A merge conflict is triaged, and a moved base is answered by its overlap.**
   - The wait records only the conflicting paths and the two shas
     (`ProposedEscalated{ proposal: MergeConflict{ paths, baseSha, headSha } }`),
     so triage reads both sides from the mirror.
   - This repository declares an AI judge for conflicts, and its fix brief
     already asks an agent to merge base into the current branch. That is a
     recipe choice, not a built-in default for every repository. When this
     automatic path cannot finish, triage lists the hunks and a question for
     each hunk whose behavior differs on the two sides, for a person to read.
     The question is carried by the hunk it is about. They are advice: nothing
     picked there reaches the grant. The page also shows the wait's paths and
     GitHub's compare view, or the two shas when no compare URL is known.
   - **A conflict is answered by `GrantFixRound` with the conflict brief.**
     The agent merges the latest base into the preserved branch, resolves the
     hunks and commits, with an instruction to stop and ask when the two sides'
     behaviours contradict and the ticket does not settle which wins. What
     catches a wrong choice is `build`, `review` and that question, not a
     confirmation form; the page links to GitHub's compare view for a person
     who wants to read the hunks first. The changed branch runs through `build`
     and `review` before `proposed` and the merge lane. This is not an
     `Approve` or a waiver of either gate. If the base moves again and
     produces another conflict, a new wait is held for it.
   - Past 20 hunks it does not resolve them one by one. The hunks are counted
     from the mirror before any agent is called, and past 20 none is: the
     triage is _merge by hand_ with no hunks and their total, recommending starting over from the new base, answered by `Mechanical` (§3), and it costs nothing. The answer is the same `GrantFixRound`.
   - **A moved base has three answers, checked in this order.** A conflict
     comes first and is the rest of this section. A clean trial merge where
     the base moved on files the branch also changed (`base-moved`) is merged
     into the branch by the system, with no agent and no round spent; `build`
     and `review` then run again, and that review is shown what landed on those
     paths (capped at 400 lines). That happens at most twice a pass
     (`BASE_MERGES_LIMIT`); the third is a wait (§1's `BaseMoved` row). A base
     that moved only elsewhere lands after the lane's `verify` on the merged
     tree, and a red `verify` there is `VerifyRed` and goes back to
     `implement` (0108).

9. **Triage belongs to the wait it explains.** `WaitTriaged` names the
   wait it answers (its `waitId`) and the head it read. The page and the card
   show it only while that wait is the current one, so an approve or a
   requeue retires it. A new head arrives only with a new wait, so it
   retires it too. A branch moved by hand while the wait stands makes no new
   wait and no new triage; the page shows the triage with the head it read
   and the head the branch is at now. A triage that finishes after the person has acted
   is still recorded, for its cost, and shown nowhere.

10. **The card reads triage from `task_view`.** The projection keeps the facts for the current wait: the latest `TriageStarted`'s attempt and start time, and that attempt's `TriageResult` whole. It keeps the head that attempt read beside the result, for §9's line. It cannot keep a `TriageStatus`, because two of its cases depend on the recipe and the running daemon, which a fold never reads. The board, which has both, derives the status from the wait's `WaitReason` and those facts by §1's order, through one pure function, `triageStatus`, the same one the daemon starts triage by. Adding the columns is a rebuild:
    `lingtai projection rebuild task_view`.

11. **A wait is resolved by its own id, and an approval continues the run.**

    ```ts
    const resolveWait: (command: {
      waitId: WaitId
      resolution: Resolution
      by: string
      note: string
    }) => Effect<ResolveResult>
    ```

    - **By the wait, not the ticket.** A ticket may have been requeued into a
      new wait by the time an old page's approval arrives, so `resolveWait`
      checks atomically that `waitId` is the item's current wait and refuses,
      doing nothing, if not. `Approve` also refuses when the branch is no
      longer at its `onSha`. `approve.ts` makes both checks today, by run
      (`:216`) and by sha (`:228`), and neither is lost.
    - It checks the resolution against `allowedResolutions` and acts: a requeue
      releases the item, a close closes it, an answer is written into the body
      (§6), `GrantFixRound` continues the preserved branch for one round
      (0108 §8), conflict continuation follows §8, and a split follows §12.
      `WaitResolved` records
      the completed choice; a partial split cannot resolve the wait.
    - **An approval continues the same run** with
      `runPass({…, from: {step, waive, roundsSpent, …}})`, at the step in §1's
      table. `waive` is a list of `{name, waitId}`: every `Approve` this item
      recorded for that step, not only the latest, so two stopping actions in
      one step's list can both be got past; it applies on the step's first
      visit only, and is empty for `FixerDisagrees`, `MergeRefused` and their
      `ProposedEscalated` kin, because the router or the lane runs again
      unwaived. `roundsSpent` keeps the round budget from starting over. At that step the action this wait asked about, the refusing
      check or the signoff, is recorded `Waived{waitId}` and counts as
      cleared, and everything after it runs; otherwise the same check refuses
      the same sha again and the approval loops. Continuing at `proposed`, the
      signoffs declared there are still asked: the person approved _no change_
      or _merge past the ceiling_, not them. From there it is an ordinary
      pass: a `StepEnded`, then `Landed`, a new wait, or a route (a conflict
      after an approval routes as any conflict does), and `end` runs.
    - Today `approve.ts:344` integrates on its own outside the pass, writing
      `StepWaived` and `ApprovalGranted` and then `TicketLanded` or
      `MergeRefused{afterApproval: true}`, and skips the checks declared at
      `merge`. Both go: a merge refused after an approval is a `MergeRefused`
      whose wait follows a `WaitResolved{Approve}`, derived, not stored.
    - **`Close` here only ends a wait.** `lingtai close` closes any ticket,
      waiting or not, and still writes `TicketClosed`; a waiting ticket
      closed also gets its `WaitResolved{Close}`.

12. **A split is written from the page, and its parent closes with its
    children.** The mockup is [`0118/Split.dc.html`](0118/Split.dc.html).
    1. **The plan is advice until a person approves it on the page.** Triage
       can recommend `Split` as soon as it sees `TicketTooBig`, including the
       first wait, with at most 8 children. The waiting page draws the plan;
       the person edits titles, bodies, kinds, which children are included
       and the chain, then presses **Create all**. Nothing is created before
       that. A project whose tickets are in `db` sees the plan with splitting
       marked unavailable.
    2. **The plan freezes at the first Create all.** From then on the plan is
       the one `SplitStarted` recorded, and a retry sends none: the writer
       reads the frozen one from the log. Nothing on the page can change it,
       not after a failure either, where the split's one move is **Retry what
       is missing**. A person who wants a different split takes one of the
       wait's other resolutions, which stay available once nothing is
       writing; the children already created are named on the page and left
       for the person to close.
    3. **A child is known by its marker and by nothing else.** Every child's
       body carries an invisible marker naming the parent, the wait and the
       child's key. The writer finds what exists by listing the issues its
       own App created since the split started and reading their markers,
       never by title, and never through GitHub's search index, which lags a
       create by seconds. An issue without its marker is never adopted,
       edited or linked. A lookup that fails fails the write; an empty answer
       is never read as _not created_. A child found by its marker keeps
       GitHub's title and body.
    4. **GitHub has no transaction, so every run reconciles against GitHub,
       never against the log.** Running the write twice is the same as
       running it once, running it again after a failure converges on the
       whole plan, and it never touches an issue it did not create. A run
       creates each child no marker answers for, attaches each missing
       sub-issue, adds each missing blocked-by, and records `TicketSplit`
       only once every child and link has been read back; `TicketSplit`
       records what GitHub returned, not the plan. A retry never trusts the
       progress events of rule 5 to skip a write.
    5. **Progress is recorded as it goes.** `SplitStarted` carries the wait,
       the frozen plan and the board process's `instance`; then one
       `SplitChildWritten` per child and one `SplitLinkWritten` per
       child-to-child link, each after its read-back; the run ends with
       `TicketSplit` or `SplitFailed{step, detail}`. Every one carries the
       `waitId`, because a parent can wait again. The page draws progress
       from the log (`splitProgressOf`) and shows which children and links
       exist and which are still owed.
    6. **One child at a time:** create it, attach it, record it, then the
       next.
    7. **Writing or interrupted, and the lock.** A `SplitStarted` with
       nothing terminal after it is _writing_ only if its `instance` is this
       board process's own and this process says a writer for that wait is
       running. Otherwise it is _interrupted_, which is derived and never
       written. The page is locked exactly while the split is _writing_, and
       offers **Retry what is missing** on `failed` and on _interrupted_. An
       unfinished split from an earlier board process therefore reads as
       _interrupted_.
    8. **A partial split resolves nothing; a complete one resolves the
       wait.** Whatever progress events were written stay, and nothing else
       is appended: no `TicketSplit` and no `WaitResolved`. The wait stays
       open and the retry reconciles from what GitHub has. A complete split
       appends `TicketSplit` and then `WaitResolved{Split}` in one
       transaction, which also releases the claim, _after a split_.
    9. **The parent waits on its children and is closed at claim when they
       are all closed.** The writer marks the parent blocked by each child
       and rewrites its `## Done when` as one checkbox per child, so the
       queue passes the parent over as `blocked-by` while any child is open.
       At claim, `claimTicket` reads exactly `TicketSplit.children`, not the
       body and not GitHub's sub-issue list. All closed: the parent is
       closed with no run, a comment saying why posted first. Any open:
       `split-open`. One that cannot be read: `split-unreadable`, and
       nothing is closed.

## Consequences

- **Every wait that is a judgement or a machine failure costs one triage
  run**, whether or not anybody opens it. Its cost is a `RunSpent { for: Triage }`,
  so it shows in `/spend`, and a recipe that does not want it does not declare it.
- **Triage is billed at least once, and at most twice, per wait.** The only
  second payment is a daemon that stopped during the call, whose attempt is
  tried again on the next start.
- **The log can answer how often the advice is taken, and that is not how good
  it is.** Adoption is one query over `WaitTriaged` and the resolution after it. How
  good the advice was is a different query, over what followed the resolution: did
  the next pass land, or wait again, and for the same cause? Neither is part of
  this decision's build.
- **Triage never delays the queue.** It runs beside the next pass, not inside
  this one.
- **The stopping step's own text becomes evidence**: the judge's `why`, git's words
  and the step's raw output. It sits in the record. It is no longer the message.
- **On GitHub, an edit made in the instant between the body's read and its
  write is lost.** GitHub's issue PATCH takes no precondition, so the write
  compares and then writes; the read-back after it narrows the window and
  cannot close it. A `db` tracker's write is conditional and has no window.
  This is accepted: the page shows the section before the resolution is chosen, and
  the section is found again by its marker.
- **The body grows a section per answered wait.** That is the point: it is the
  durable, free place a decision is kept, and the place the next attempt reads
  from.

## Not decided here

- **The language triage writes in**, and whether the recipe names it.
- **Whether `lingtai status` and the GitHub comment** carry the cause or only
  link to the page.
- **Whether Discussion's turns leave the event log.** Today they are events
  on `chat-<id>` streams. A discussion decides nothing, so its text is a trace
  rather than a record, but its usage still needs somewhere to be counted.
  That is Discussion's own decision. Triage depends on none of it.
- **The per-kind table** of trigger, page and whether triage runs. It is
  design, not decision, and belongs in `doc/design/`. What each wait allows
  and recommends is §1's.

## Mockups

[`0118/`](0118/index.html) holds the pages this decision was drawn against:
the board's Waiting column, #390's page, and one page for each other cause,
the merge conflict, the questions, and what follows a resolution. They open directly
in a browser. `dc-lite.js` beside them is all they run. They illustrate the
decision and do not extend it: where a mockup and this text differ, this text
is the decision. In particular, _Outcomes_' "the judge and triage disagree"
draws the side-by-side and the pick that §5 no longer has, and _Split_'s partial
stage says the missing child can still be edited or left out before Retry,
where §12 rule 2 freezes the plan.

---

_New topic; replaces no archived ADR. The design discussion is #388._
