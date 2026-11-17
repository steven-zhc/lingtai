# 0108 — Failure and recovery: a rule answers first, a judge or triage names the cause and the system acts on it, and a person is the floor

**Status** accepted · 2026-10-01 · amended 2026-11-13 · rewritten 2026-11-17: nine named actions with one bound each, committed work kept on the branch, a step redone whole from its head, implement's five outcomes, a judge or triage answers a cause and the system acts on it, and a person only for a spent bound, an unclear requirement or a broken environment

A failure is answered in three layers. A **rule** answers what is mechanical or
transient, costs nothing and runs no agent. What a rule cannot answer is a
**judgement**: an agent names its cause — a **judge** declared at `proposed`
while the attempt is within its bounds, **triage** where a wait would
otherwise open — and the system, not the agent, chooses the action from that
cause and carries it out. A **person** is reached for three things only: a
bound that is spent, a requirement only a person can settle, and an
environment only a person can repair. Every automatic path has a bound,
counted on the log, so every loop ends and says which bound ended it.

Work that was committed is never thrown away on a failure; work that was not
committed is expected to be lost, with one exception — the code an
implementing agent left when it was cut off, which Lingtai commits for it.
Only an approach judged wrong starts over from the base. Lingtai's own
failures never reach an agent at all.

How a split is written and how a parent ticket is closed after one is
[0118](0118-a-hold-explains-itself.md) §12. The design discussion is
[doc/design/failure-handling.md](../design/failure-handling.md).

## Context

An attempt can end badly in unlike ways: a judgement about the diff, a check
that went red, an account that will not run an agent, an agent that died
mid-run, a ticket that is too big or unclear, a landing the remote refused.
They cost different money. A loop that re-buys agents without a bound never
errors, it only spends; an account-wide quota answered item by item walks the
whole queue into the same wall; a crash recorded as a refusal pays a fixer to
answer a question nobody asked. And a person asked about something a machine
could have answered is the expensive default this decision removes: the
person clicked the button triage recommended, so the system now does.

*Where* a refusal goes next (the router at `proposed`, `judge:`, the offered
set) is the pipeline's, ADR [0103](0103-a-pass-is-ten-fixed-steps.md); this ADR
fixes the actions, their bounds and the endings that router works inside.

## Decision

1. **Lingtai's own failures never reach an agent.** A recipe that will not
   resolve, a missing GitHub App or env value, no hook binary, an unreachable
   database: nothing in the repository is broken, so nothing an agent could do
   would help. `conduct.ts` answers these before it claims (for example
   `stage: "recipe"`), and `whoseFailure` in `packages/domain/src/failure/explain.ts`
   names the owner on the card (`lingtai` or `repository`). The owner decides the
   sentence a person reads, never a purchase.

2. **The worktree is the whole of an attempt.** It is cut `--force --detach` at the
   base's sha from the mirror `~/.lingtai/repos/<project>.git` into
   `~/.lingtai/worktrees/<project>/<runId>` (`provisionWorktree`,
   `packages/repo/src/worktree.ts`), and its scope encloses the merge lane.
   Detached is what makes that possible: no worktree has `agent/<n>` checked out,
   so the lane can fetch and update it. Every refusal therefore happens while the
   work is still on disk, and a new attempt is the answer only to an attempt
   that ended.

3. **`fixRefusal` answers a refusal in that worktree, carrying its evidence.**
   It is `implement` again with `fixBrief` (`packages/conductor/src/fix.ts`)
   instead of the ticket prompt, on the current head, then the attempt walks
   forward through `build`, `review` and `proposed` again. The evidence is one
   argument with two shapes: the reviewer's findings, or a command's output
   (both ends, clipped to `runtime.budget.evidence`). A merge conflict is not a
   `fixRefusal`; it is `resolveConflict` (§8), with the conflicting paths as
   its evidence. The route that bought it is `ProposalRouted{next: FixRefusal}`.

4. **Only a refusal with a criterion buys an agent.** A finding counts only if it
   carries a `failureScenario`; a command's refusal only if it printed something.
   Each is an acceptance test the fixer did not write: the scenario still happens
   or it does not, and green is green. A refusal with neither, or a reviewer answer
   that would not parse, buys no `fixRefusal` (an unparsed answer is redone,
   §12). A step before any agent has run (`prepared`) cannot offer `implement`.

5. **The fixer gets the findings, the diff and the ticket, not the reasoning,
   and may dispute.** Each `failureScenario` is passed verbatim with the diff
   (clipped at `runtime.budget.diff`) and the ticket's body as it reads at the
   fix (what the cold reviewer held the change to — context, and the findings
   stay the criterion). No plan, transcript or session of the implementer's.
   The re-review is handed the same findings (`ActionContext.recheck`) and
   asked whether those sequences still happen, so silencing a finding does not
   pass. A fixer that holds a finding wrong says so and declares `Disputed`
   (§21): the router hears `fixer-disagrees` and a judge rules between the
   reviewer and the fixer. The fixer right: the finding is void and filed to
   the backlog (§9), and the attempt goes on. The reviewer right: another
   `fixRefusal`, carrying the judge's reason.

6. **A judge answers within the bounds; triage answers where a wait would
   open; both name a cause, and the system chooses the action.**
   - A red check (`red`) and a re-verify that went red on a moved base
     (`verify-failed`) need no judgement: the built-in `same-worktree` judge
     sends them to `fixRefusal` while the bound allows (§17 first runs the
     check twice).
   - A judgement within the bounds — `findings`, `fixer-disagrees`,
     `already-done` — goes to a **judge** the recipe declares at `proposed` for
     that `when:`. It reads only the step's own evidence (the findings, the
     fixer's objection, the implementer's per-item evidence), so it is cheap
     and is the usual path; this repository declares `judge: claude-code` at
     `findings`. Where no judge is declared, triage answers instead.
   - Where a wait would otherwise open — a run that met `run.turns` or
     `run.wall`, a diff too large to review (§14), a setup that failed for a
     reason no rule knows, a conflict past `CONFLICT_ROUND_HUNKS` (§8), a bound
     that is spent — **triage** ([0118](0118-a-hold-explains-itself.md) §3)
     reads the ticket, the diff and the code.
   - **Both answer one type: a cause and the parts that cause carries**, never
     an action. The causes are `FixableLines` (the lines to change),
     `WrongApproach` (one sentence on what was wrong, for the next attempt's
     brief), `ConflictingHunks` (each hunk: a resolution, *the two sides
     contradict*, or a question only a person can answer), `TicketTooBig` (a
     split plan, or where the run spent its turns), `SetupBroken` (what is
     broken and how to repair it), `UndecidedQuestion` (§22's questions) and
     `Unfinished` (the step only did not finish; optionally a sentence for the
     body).
   - **The action is the system's, from one table in `respond`** (§19):

     | Cause | Action | While | Otherwise |
     | --- | --- | --- | --- |
     | `FixableLines` | `fixRefusal` | `refusalFixes` left | `askPerson(limit)` |
     | `WrongApproach` | `startNewAttempt` | `newAttempts` left | `askPerson(limit)` |
     | `TicketTooBig` with a plan | `splitTicket` (0118 §12) | `ticketSplits` left | `askPerson(limit)` |
     | `TicketTooBig` without a plan, from `run.turns`/`run.wall` | write where the turns went into the body, then `redoStep` | `stepRedos` left | `askPerson(limit)` |
     | `TicketTooBig` without a plan, from §14 | `askPerson(limit)`: redoing does not make a diff smaller | — | — |
     | `Unfinished` | `redoStep` | `stepRedos` left | `askPerson(limit)` |
     | `ConflictingHunks` | a hunk only a person can answer → `askPerson(unclear)`; else contradicting sides → `startNewAttempt`; else `resolveConflict` | that action's bound left | `askPerson(limit)` |
     | `SetupBroken` | `askPerson(environment)` | — | — |
     | `UndecidedQuestion` | `askPerson(unclear)` | `personAsks` left | `askPerson(limit)` |

     `Approve` (land past a refusal) and `Close` are never in it: they are a
     person's (0118 §11). `limit` is the system's, never an agent's, and names
     the bound and how many times it was used.
   - **Acting on an answer follows one protocol**, the same one a person's
     resolution follows, because the world may have moved while the agent
     thought — a person closed the ticket, edited the body, or the head is no
     longer the one read. (1) The answer is bound to what it read: for triage
     the `waitId`, the attempt, the head and the ticket's version when it
     started; for a judge the route it answers. (2) Before acting, the system
     checks that the wait is still current, the ticket's version unchanged —
     `finishTriageTransition`'s `ifVersion` is required, not optional — and
     the bound left. Any check that fails acts on nothing: the agent is asked
     once more (`triageRetries`), and failing again is `askPerson`. (3) The
     answer, the action chosen and the bound it spends are appended in one
     append at the read version, before any effect. (4) The conductor then
     carries out the action from the log, as it carries out a person's
     resolution; a restart midway continues from the log, and the effect is
     keyed by its `waitId` or route so doing it twice does it once. Every such
     action is recorded `by: triage` or `by: judge`.

7. **`startNewAttempt` starts the ticket over from the base, and only a judged
   approach or a lost head earns one.** It is the action for `WrongApproach`,
   for a conflict whose sides contradict, and for a head that can no longer be
   continued (§15). A red check or a resolvable conflict never starts over,
   whatever a recipe or a judge says, because their work is still there. The
   approach being abandoned is pushed to its arm `agent/<n>-attempt-<k>` first;
   then the attempt's record (arm, head sha, every finding, the cause's
   sentence) goes on the ticket's stream; then the claim is released
   `TicketReleased{cause: NewAttempt}`. If the arm is not on origin, no
   `newAttempts` is spent and the attempt ends `failed`. The next attempt
   carries no work from the old one: its brief quotes why the old approach was
   wrong. A ticket so released waits out `source.backoff` like any release. A
   person's `StartNewAttempt` resolution (0118 §7) is a decision outside the
   automatic bound and neither spends nor refunds `newAttempts`.

8. **Every action has one bound, named after it, counted on the log.** Each
   bound counts one thing in one scope; two things that mean differently have
   two names even where their values agree. No counter is reset inside its
   scope — not by a restart of the daemon, not by a release and a re-claim,
   not by a person's resolution — and each starts at zero only with a new
   scope.

   | Action | What it does | Starts from | Bound | Scope | Value | Where |
   | --- | --- | --- | --- | --- | --- | --- |
   | `redoStep` | the step again, whole, after it did not finish (§12) | the head | `stepRedos` | attempt | 3, after 1, 5, 15 minutes (`stepRedoWaits`) | constant |
   | `rerunCommand` | a check that went red, once more on the same commit (§17) | the same commit | `commandReruns` | each red | 1 | constant |
   | `fixRefusal` | `implement` on the head with a refusal's evidence (§3) | the head | `refusalFixes` | attempt | 6 | recipe |
   | `resolveConflict` | `implement` on the head, merging the base and resolving the hunks | the head | `conflictResolutions` | attempt | 6 | recipe |
   | `mergeBaseBranch` | the moved base merged in by the system, no agent (§13) | the head | `baseBranchMerges` | attempt | 10 | constant |
   | `retryLanding` | the same head landed again after a transient refusal (§15) | the head | `landingRetries` | attempt | 3 | constant |
   | `startNewAttempt` | a new attempt from the base (§7) | the base | `newAttempts` | ticket | 2 | recipe |
   | `splitTicket` | children opened, the parent requeued behind them (0118 §12) | the base | `ticketSplits` | root ticket and its children | 1 | constant |
   | `askPerson` | a wait for a person: `unclear`, `environment` or `limit` | — | `personAsks` counts `unclear` | ticket | 5 | constant |

   A run is bounded by `run.turns` (350), `run.wall` (75m) and, where declared,
   `run.usd`; meeting one is not an action but sends the step to triage
   (§12). One triage call is bounded by `triage.turns`, `triage.wall` and
   `triage.usd`, and an unusable answer is asked again `triageRetries` (1)
   times. A conflict of at most `CONFLICT_ROUND_HUNKS` (5) hunks is resolved
   by rule, without triage. The recipe groups its bounds by scope:

   ```yaml
   runtime:
     limits:
       run:     { turns: 350, wall: 75m }
       attempt: { refusalFixes: 6, conflictResolutions: 6 }
       ticket:  { newAttempts: 2 }
   ```

   The old names — `rounds`, `restarts`, and `turns`/`wall`/`usd` directly
   under `limits` — are refused by name when the recipe resolves, and the
   refusal names the new key and where it goes. `refusalFixes`,
   `conflictResolutions` and `newAttempts` written inside a dispatch's own
   `limits:` are refused by name, as `rounds` was. The constants live in
   `packages/domain/src/failure/respond.ts`, are never written in a recipe,
   and exist to stop a loop.

   **`attemptCeiling` (`packages/conductor/src/ceiling.ts`) says what the
   bounds buy, and says which runs it counts.** `implement` runs at most
   `(newAttempts + 1) × (1 + refusalFixes + conflictResolutions + stepRedos) + personAsks`
   times a ticket, each within `run.wall` and, where declared, `run.usd`. That
   is `implement` alone, not every run a ticket makes: `design`, `review`, a
   judge and triage each run agents too, each a bounded number of times
   (`review` once after each `implement`, and once more after a
   `mergeBaseBranch` that touched the branch's files), and the ceiling lists
   them by step rather than summing them into one figure. `landingRetries`,
   `baseBranchMerges` and `commandReruns` run no agent. The day's spend
   ceiling (0126) stops new attempts and is no substitute for any of these.

9. **A minor finding does not refuse; it is filed.** `verdictFor`
   (`packages/actions/src/agent-action.ts`) refuses on a `blocker` or `major` and
   passes on `minor`. A passing step's findings ride on `StepPassed.findings` and
   collect in the `finding_backlog` projection. A person decides one entry at a
   time with `lingtai backlog` or the board's backlog page; nothing is decided by
   rule. Accepting appends `FindingAccepted` on `bkl-<project>-<key>`, then the
   `TicketStore` opens the issue (`FindingProposed`); declining appends
   `FindingDeclined` (`packages/conductor/src/backlog.ts`). A finding a judge
   voided on a fixer's dispute (§5) is filed the same way.

10. **"Never started" is three facts, never the message.** A receipt is
    `never-started` when it is an error, took at most one turn and cost nothing
    (`neverStarted`, `packages/agent/src/runtime.ts`; for Codex, a `turn.failed`
    with no agent message). The runtime's prose is kept whole as `detail` and is
    never read to classify, and the name is not a guessed cause such as a quota.

11. **An agent that never started locks its runtime's account, not the item.**
    Wherever it happens — the implementer, a design agent, a reviewer, a fixer,
    a judge — the step ends `never-ran` (`StepNeverRan`) and the attempt
    stops: no action, no judge, no question for a person. The attempt appends
    `AccountLimitReached` on `acct-{runtime}`, for the runtime that agent ran on,
    with an `until` ([0126](0126-a-stop-is-a-lock-and-an-unlock.md) §2);
    `standDown` (`packages/domain/src/failure/respond.ts`) reads a reset time out
    of the message (an ISO instant, a dated clock, or a wall clock, at most a week
    out) and falls back to `source.backoff`. A lock already holding is left alone.
    The lock holds every project whose recipe uses that runtime, is lifted by the
    guard once `until` has passed or by a person (0126 §7), and names which agent
    met the wall. **A run that started and met the account's limit locks the
    account the same way** — a crash whose detail is the runtime's own
    account-limit sentence (`wallOf`: Claude Code's *You've hit your … limit*,
    Codex's *You have hit your usage limit*) appends the same
    `AccountLimitReached`, and if it was `implement` its WIP is committed
    first (§20). Then the ticket is released `AccountLimit{ runId, step,
    runtime }` — the lock first, so nothing claims it into the wall — and no
    wait is written. **The first claim after the lock lifts continues the same
    attempt**: the worktree is re-cut at the saved head and the cut-off step is
    redone there, as `redoStep` does it (§12), but without spending
    `stepRedos`. This path has no count: waiting costs nothing and runs no
    agent, and a limit with no reset — a monthly spend — is lifted by a person.
    Where the saved head cannot be continued, the attempt starts over if
    `newAttempts` is left (§7), and is `askPerson(limit)` otherwise. A
    person's moves on the queued ticket are `lingtai close` and
    `lingtai account lift`.

12. **A step that did not finish is redone whole, from its head: `redoStep`.**
    A crash, a missing receipt, an answer that could not be read, or a run
    that met `run.turns` or `run.wall` ends the step `did-not-finish`
    (`StepDidNotFinish`). It judged nothing, buys no `fixRefusal`, and does not
    pause the conductor, because a crash is local.
    - **Which rule answers it.** A transient API error, a crash no rule
      recognises, a missing receipt and an unreadable answer are each
      `redoStep` by rule. A run that met `run.turns` or `run.wall` goes to
      triage, which answers `Unfinished` (`redoStep`) or `TicketTooBig` (§6).
      A crash that is the account's limit is §11.
    - **What it does.** The worktree is reset to the attempt's head — which
      includes the WIP Lingtai committed for a cut-off `implement` (§20) —
      and whatever else was uncommitted is dropped. The step runs again from
      its first action, never from the action that was cut off. An agent's
      brief ends with one paragraph: *this step was interrupted (why); it began
      at `<sha>` and is committed to `<head>`, including any unfinished work
      Lingtai saved for you; carry on, and do not redo what is committed.* A
      `review` redone gets no such paragraph: it reads only what is
      committed, so nothing of it was lost.
    - **Where.** `redoStep` is used at `prepared`, `design`, `implement` and
      `review`. `merge` has `retryLanding` (§15); `end`'s actions keep their
      completion records (§23).
    - **Waits and bound.** Each redo waits 1, 5 and then 15 minutes and spends
      one `stepRedos`, counted over the whole attempt rather than over
      consecutive failures; with none left, the next one is
      `askPerson(limit)`. Continuing a step after a person answered its
      question (§22) is done the same way but spends `personAsks`, not
      `stepRedos`. A person's `RedoStep` resolution (the CLI's and the
      board's move to redo the step on the saved work, #1218, #1219) is a decision outside the
      automatic bound and spends nothing.
    - **Which sentences are transient** is a row of the failure module's
      table (§19), matched on the runtime's own words. The list's evidence is
      [doc/design/platform-errors.md](../design/platform-errors.md), and it
      holds two rules from there: the edge's refusal page is matched on its
      title, never as *a 403*, because every 403 either API documents is
      repeatable; and a 429 that names a spend or billing limit — Anthropic's
      `enforced_spend_limit_reached` (sent with no `retry-after`), OpenAI's
      billing `error.code`s — is not transient, since it fails until a person
      or the month changes it. A runtime's sentence for an error is listed
      only once a run has printed it. A crash not on the list is still
      `redoStep`; the list decides only whether the redo is expected to work.
    - A step that stopped to ask a question is a different ending
      (`StepAsked`) and goes to the router (§22).

13. **A refusal the base shares buys nothing.** Before a `build` refusal buys a
    `fixRefusal`, the refused command is run on the attempt's base commit. If it
    fails there too, the refusal is not about the diff: nothing is bought, and
    the attempt stops without a wait: its branch is published at its head, and
    the item goes back to the queue keeping its place and that head. A fix
    agent does not fix what it did not break, and a person has nothing to
    decide about this ticket — the base is someone's to fix, and who is not
    Lingtai's to guess. **The queue passes the item over as `base-red` while
    the recorded result for the current base commit is red**, and the board and
    `lingtai status` show it in the queue with the check that is red, the same
    way they show `blocked-by`. The base's result is recorded on the log, keyed
    by the base commit, the command and the boundary it ran under
    (`unsandboxed`, or a fingerprint of the sandbox policy; 0127 §15) — an
    answer under one boundary never answers a question under another — so
    attempts in flight and every queued ticket reuse it; when the base moves
    the check runs once on the new commit — no agent, no claim — and a green
    result lets every item it held be taken again. **Taken again, it continues
    from its saved head, not from the base**: the new base is merged in by
    `mergeBaseBranch` and `build` runs again, then `review` and `proposed` as
    after any base merge; nothing is implemented again, and it is the same
    attempt continued, so its counters stand. Only a head that can no longer
    be continued starts over from the base (§7). Lingtai opens no ticket about
    a red base.

    **A base that moved is merged in by the system: `mergeBaseBranch`.** When
    the base moved on files the branch also changed, the system merges it in
    itself — no agent — and the attempt builds and reviews again; when it
    moved only elsewhere, the merged tree is built again and the review
    stands (#1210). That is a choice about cost, not a guarantee: files that
    do not overlap can still disagree in behaviour (a base that changed an
    API's default, a branch that changed a caller in another file), and then
    `build` is the only check. A review carried across a move is bound to the
    head, the base and the checks it read. At most `baseBranchMerges` times
    an attempt; then `askPerson(limit)`.

14. **A diff the reviewer cannot read whole buys no reviewer.** Before
    `review`, the diff the reviewer would be handed is measured the way it is
    clipped, against `runtime.budget.diff`. When it is longer, no reviewer and
    no judge is paid, and no `fixRefusal` is offered, because a fixer cannot
    make a change smaller without dropping what the ticket asked for. Triage
    answers instead: `TicketTooBig` with a plan is `splitTicket`, and anything
    else is `askPerson(limit)` naming the size and the limit (`DiffTooLarge`).
    The person may `Approve`, which runs the review on the clipped diff and
    records that the reviewer read only the first part, so the summary and the
    task page say so.

15. **A landing the remote refused for a transient reason is retried from its
    saved head, not built again: `retryLanding`.** The lane already retries a
    push that GitHub answered with a 5xx in place (`remote-error`, #1125). When
    those retries are spent too, the work is finished and only the landing is
    owed: the branch is published at its head, and after a wait that grows (as
    in §12) the rule continues the attempt into the merge lane from that
    recorded head — the same continuation a person's `Approve` makes (0118 §11),
    with the recorded head as its `onSha` — spending one `landingRetries`, a
    count of its own and never `stepRedos`. Nothing is implemented, built or
    reviewed again unless the base moved meanwhile, and then the lane's own
    rules apply: a clean move is `mergeBaseBranch`, a conflict is
    `resolveConflict`. **Only when the head cannot be continued** — the branch
    is gone or no longer at the recorded sha — does the ticket start over from
    the base (§7). A refusal the remote will repeat — a 4xx, a protected branch
    (`GH006`, `GH013`), push protection, a declined pre-receive hook, a file or
    a push over GitHub's size limits — is `askPerson(environment)` at once,
    because retrying it buys nothing
    ([doc/design/platform-errors.md](../design/platform-errors.md) §2). git's
    *the remote end hung up unexpectedly* is both a dropped connection and
    GitHub's sign of a push over 2 GiB, so it is retried as transient, and the
    wait that follows its spent retries names both causes rather than only
    *origin could not be reached*.

16. **A rule comes before a judgement, and an agent names a cause but never
    acts.** What is only mechanical or only transient (§11, §12, §13, §15,
    §17) is answered by a rule, which costs nothing and runs no agent, and no
    judge or triage is asked about it. What needs a judgement is a judge's or
    triage's cause (§6), and what the system does with it is the table's, not
    the agent's. A person is asked only where the table ends in `askPerson`:
    `limit`, `unclear` or `environment` (0118 §1). Whatever the system did
    instead of asking is still shown: the card or the task page carries one
    line — what was done and why — and the answer it acted on.

17. **A red check is run twice before it is believed, and a flaky red that is
    not this diff's does not stop it: `rerunCommand`.** When a check refuses —
    `build`, a declared check (`check-refused`), or the base check (§13) — the
    same command runs once more on the same commit, at once. Red twice is red,
    and goes where red goes. Red then green is flaky, and it lets the attempt
    go on only when all three hold: (1) the second run is green; (2) no failing
    test's file is in this ticket's diff; (3) that test has failed on the base
    before — the base check's record or the backlog already names it as
    flaky. Then the attempt continues, and the flaky test is recorded as a
    backlog finding (§9) for a person to decide; Lingtai opens no ticket for
    it. If any of the three fails, or the failing test cannot be named from
    the command's output, it is red: a test this diff added or touched, or one
    never seen failing on the base, is this diff's until shown otherwise. On
    the base check, red then green is green. The rerun runs no agent; it costs
    the check's time once. A check that did not run to an exit code — killed,
    timed out — did not finish, and is `redoStep` (§12).

18. **Every reason the router hears has its answer written down.**

    | Reason | What it means | Answered by |
    | --- | --- | --- |
    | `red`, `verify-failed` | A check refused, twice (§17) | The built-in judge: `fixRefusal` |
    | `findings` | The reviewer refused with findings | A declared judge (§6); triage where none is declared |
    | `fixer-disagrees` | A fixer declared `Disputed` (§5) | A declared judge; triage where none is |
    | `already-done` | `implement` declared `AlreadyDone` (§21) | `review` checks the evidence (§21) |
    | `conflict` | The lane could not merge | A rule up to `CONFLICT_ROUND_HUNKS`; triage past it (§6) |
    | `setup-refused` | `prepared` failed before any agent ran | A rule: a transient error in the failure table (a registry's 5xx) is `redoStep`; anything else is triage, usually `SetupBroken` |
    | `check-refused` | A check declared at `proposed` or before the lane refused | A rule: run twice (§17); red with output is answered as `red` |
    | `answer-unreadable` | An agent answered and the machine could not read it | A rule: `redoStep` (§12) |
    | `needs-input` | A step asked a question only a person can answer (§22) | `askPerson(unclear)`, within `personAsks` |

19. **Every failure rule lives in one module, as tables.** `packages/domain/src/failure/`
    holds three pure steps and nothing that does IO: **classify** turns what a
    platform or a tool said — a status, a header, git's stderr, a runtime's
    sentence — into a failure kind, by the error table (platform, match,
    transient / repeatable / account limit, where the wait is read from, and
    the documented source); **respond** turns a failure kind, or a judge's or
    triage's cause, and the attempt's counters into one action from §8's
    table, by §6's table; and **explain** gives the sentence and the move a
    person reads when the action is `askPerson`, and the one line shown when
    it is not. The packages that meet a failure only hand what they saw to
    *classify* and carry out what *respond* says; none keeps a rule of its own.
    The tables are the source of
    [doc/design/platform-errors.md](../design/platform-errors.md) and of this
    ADR's routing, both generated, and a test fails when a generated file is
    stale. A new rule is a row, a test that feeds the row the platform's own
    words, and a regeneration — nothing else.

20. **Committed work is kept; uncommitted work is not, except the code a cut-off
    `implement` left, which Lingtai commits.**
    - A failure never throws away a commit. Only `startNewAttempt` leaves the
      head behind, and it pushes it to an arm first (§7).
    - What was not committed is expected to be lost, and no rule exists to
      keep it: a redo from the head costs at most what the step had not yet
      committed. `implement`'s brief asks the agent to commit each piece that
      works as it finishes it, so an interruption loses little.
    - **The one exception is WIP**: when the agent at `implement` — the first
      run or a `fixRefusal` — ends abnormally (a crash, a timeout, `run.turns`
      or `run.usd` met, or the attempt stopped while it ran), Lingtai commits
      what `git add -A` collects in its worktree, without ignored files or the
      seeded env files, to the attempt's own branch `agent/<n>`, and pushes it.
      The message begins `wip:` for a person to read; `RunKeptUncommitted`
      records the commit's sha, and the sha — never the message — is how code
      tells a WIP commit from the agent's own.
    - No WIP is made at `design`, `review` or `merge` (they write no code), in
      `resolveConflict` (redoing it merges again and gets the conflict markers
      back), for an agent that ended normally with nothing committed (that is
      an outcome, §21), or for one that never started.
    - **The lane lands a branch with WIP commits on it.** What lands is always
      the head `build` and `review` checked (#1209), merged with a merge
      commit, so every point on `main`'s first-parent line is a checked one;
      an agent's own intermediate commits are no more guaranteed to compile
      than a WIP commit is.
    - **No work is carried to a new attempt.** A redo in the same attempt
      starts from the head, which already holds the WIP; a new attempt is
      `startNewAttempt`, which by its meaning takes nothing of the old.

21. **`implement` ends in one of five outcomes: the agent declares it, and the
    facts correct only a declaration that contradicts them.** The agent states
    its outcome in its final answer. The facts are the sha the step first
    started at, the head now, and the commits between (WIP commits counted,
    known by `RunKeptUncommitted`'s sha).

    | Outcome | Meaning | Taken when | Next |
    | --- | --- | --- | --- |
    | `Implemented` | done | declared, and the head moved since the step first started (a WIP commit counts) | `build`, not the router |
    | `AgentFailed` | not finished | the run ended abnormally; or nothing was declared; or `Implemented` was declared and the head did not move | WIP committed if any (§20), then `redoStep` |
    | `Disputed` | a fixer holds a finding wrong | declared, naming which finding and why | the router, `fixer-disagrees` (§5) |
    | `AlreadyDone` | the base already does what the ticket asks | declared, the head did not move, and each `## Done when` item is answered with what satisfies it | the router, `already-done`: `review` checks it |
    | `Unclear` | the ticket cannot be done as written | declared, with questions in §22's shape; commits or not | the router, `needs-input`: `askPerson(unclear)` |

    - **The declaration decides the path; commits do not overrule it.** An
      agent that committed part of the work and then met a decision only a
      person can make is `Unclear`, and its commits stay on the branch. The two
      corrections are the only ones: `Implemented` with an unmoved head is
      `AgentFailed`, and `AlreadyDone` with a moved head is `Implemented`.
    - **`AlreadyDone` is checked, not taken on trust.** It skips `build` and
      `merge`, having nothing to land, but not `review`: the reviewer is given
      the ticket's `## Done when` as written, the agent's per-item evidence and
      the base's sha, and judges each item. All met: the ticket ends
      `satisfied`, and `TicketSatisfied` records the base sha it was checked
      at, the body's version and each item's evidence. Any not met: those
      items are findings, and the answer is `fixRefusal`. A parent ticket after
      a split ends this way on its own (0118 §12); any other `satisfied` — a
      duplicate, a ticket another one fixed in passing — is
      `askPerson` to confirm before the ticket closes.
    - The same five outcomes are the fixer's in `fixRefusal` and the agent's in
      `resolveConflict`: an agent resolving a conflict that meets a hunk only a
      person can decide — a permission, retention, an amount — declares
      `Unclear`.
    - `nothing-produced` is not a reason: a run that committed nothing and
      said nothing is `AgentFailed`.

22. **A question to a person has one shape, and asking is bounded.** A
    `design` agent's question (`AgentQuestion`), `implement`'s `Unclear` and
    triage's `UndecidedQuestion` all use triage's `TriageQuestion`
    (`packages/domain/src/triage.ts`): at most five questions, each one
    sentence with two to four answers that say what choosing them does, and a
    recommended answer. The page draws them with the recommended answer first,
    and a person may write their own. The answers are written into the body's
    answers section (0118 §6, `triageAnswersText`), then the step that asked
    is continued as §12 does it. Each stop to ask spends one `personAsks`;
    with none left the ticket is `askPerson(limit)` and nothing continues on
    its own. **A spent `personAsks` never lets an agent decide in a person's
    place**: the person edits the body, closes the ticket, or redoes the step.

23. **Redoing a step whole is safe because every action in it is.** An action
    writes nowhere, or only into the attempt's own worktree and branch, or
    outside them; each plugin declares which (`replay: safe | external`).
    - **Safe** is a check, a reviewer, an agent writing to the worktree, a
      `file:` or `file-brief:` written to a fixed path, `run: pnpm install`:
      the worktree is reset to the head first, the same path is overwritten,
      and the result depends only on the head and the body.
    - **External** is the lane's landing, `end`'s `close`, `labels` and
      `refs`, and opening a split's children. None is ever redone by
      `redoStep`: the landing has `retryLanding`, which pushes only the sha
      that was checked; a split has its markers and its reconciliation
      (0118 §12); and `end`'s actions keep their completion records, so an
      `end` entered again skips what it already did.
    - A recipe that declares an `external` action at `prepared`, `design`,
      `implement` or `review` is refused by name when it resolves. A `run:`
      a person writes is one Lingtai cannot see into: written at those four
      steps, it must be safe to run twice, and one that is not belongs at
      `end`.
    - Redoing `design` makes a new design, which is harmless: nothing has read
      the old one. A redo of `implement` does not redo `design`; it reads the
      committed one.

## Consequences

- A person is asked three kinds of question — a bound is spent, a requirement
  is unclear, the environment is broken — and every other failure is answered
  without them, with a line saying what was done.
- Every automatic path ends: each action has a bound counted on the log, a
  split happens at most once per root ticket, and asking is bounded too.
- An attempt never re-implements work it committed, on disk or on its saved
  head; only a judged approach or a lost head buys a fresh attempt.
- Recovery is simpler than resuming at the cut-off action: a step is redone
  whole, and the price is the step's uncommitted work, which the chunked
  commits keep small.
- `satisfied` means a reviewer checked every `Done when` item at a named base
  sha; a closed child or an agent's say-so alone is never enough.
- The release reason carries the step, the ending and the runtime's own words
  (`TicketReleased.reason`). The next attempt's brief quotes it, so changing
  that wording changes what the next agent reads.
- A misread reset time costs a wasted attempt, never a wrong decision: resuming
  early meets the wall and locks again.
- A recipe with the old limit names stops resolving until it is edited, and
  the refusal says how.

## Not built yet

Everything in this rewrite is decided and is to be built in 0.15.0. What is
built today is the 2026-11-13 state: one `rounds` for fixes and conflicts,
`restarts`, `TRANSIENT_RETRIES_LIMIT` shared by reruns and landings, a rerun
that resumes at the cut-off action (#1201), WIP carried as a diff to the next
attempt (#1170), triage that only advises, and a split a person approves.
What changes:

- **Names and bounds (§8).** The recipe's grouped `limits` and the refusal of
  the old names; `refusalFixes` and `conflictResolutions` apart;
  `landingRetries` apart from `stepRedos`; `personAsks` replacing
  `designAsks` (2); `ticketSplits` and `triageRetries`; `attemptCeiling`'s
  new product and its per-step list.
- **The renames on the log.** `StepRerunInPlace` → `StepRedone`;
  `ReleaseCause.Restart` → `NewAttempt`; the route's `FixRound` and
  `MergeBase` → `FixRefusal` and `MergeBaseBranch`; the resolutions
  `GrantFixRound`, `RerunStep`, `Requeue`, `EditBodyAndRequeue` →
  `FixRefusal`, `RedoStep`, `StartNewAttempt`, `EditBodyAndStartNewAttempt`.
  A renamed event type joins `RETIRED` and the reducer reads both names with
  one meaning, as `PassRouted` beside `ProposalRouted`
  (`packages/domain/src/attempt.ts:597`); a renamed tag inside a payload
  bumps the type's `SCHEMA_VER` with an upcaster, as `WaitTriaged` (#591).
  Every projection rebuilt from empty gives the same answer before and after.
  The board's and the CLI's words follow.
- **WIP on the branch (§20).** `keepUncommittedWork` commits to `agent/<n>`;
  the lane's `wip-commit` refusal (`packages/repo/src/integrate.ts:520-536`)
  goes; #1170's carry (`RunAppliedKeptWork`) is removed.
- **`redoStep` (§12, §23).** The whole step from the head with the brief's
  paragraph, replacing #1201's resume at the cut-off action (`ranBefore`,
  per-action rerun marks, `startedAt`, `fixDiffSeen`); `replay` declared by
  every plugin and checked when the recipe resolves; an unknown crash, a
  missing receipt and an unreadable answer redone by rule (#1205's
  `askedAgainOn` goes); a person's rerun (#1218, #1219) becomes `RedoStep`.
- **`implement`'s outcomes (§21).** The declared outcome, the two
  corrections, `already-done` at the router, the review of `AlreadyDone`,
  `TicketSatisfied` and the `satisfied` ending; `nothing-produced` (#1198)
  removed.
- **Questions (§22).** One shape at `design`, `implement` and triage, and
  `personAsks`.
- **Causes and the protocol (§6).** A judge's and triage's answer as a cause;
  `Unfinished`; the cause→action table in `respond`; `ifVersion` required;
  the append-then-act protocol for `by: judge` and `by: triage`; a run that
  met `run.turns` or `run.wall` sent to triage.
- **`backlog:` does not set the bar.** The plugin is declared in
  `packages/recipe/src/recipe.ts`, but the `minor` bar is still a literal in
  `verdictFor` and in the backlog reduce. Wiring it means handing one value to
  both.

---
*Replaces archived 0025, 0031, 0038, 0039, 0040, 0041, 0057 in [decisions-archive](../decisions-archive/).*
