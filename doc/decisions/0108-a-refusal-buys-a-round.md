# 0108 — Failure, fix rounds and restarts: a refusal buys a round in the same worktree, a wall stops the conductor, and a crash stops the attempt

**Status** accepted · 2026-10-01 · amended 2026-11-13: a rule answers what is only transient, a red base puts the item back in the queue, a red check runs twice, a conflict's budget is `rounds`, the mechanical bounds are constants, and every failure rule is one module

A step that refuses with something an agent can be held to sends the agent back
into the same worktree, carrying the evidence; `runtime.limits.rounds` bounds how
often this happens automatically (depth). A person may explicitly buy one more
round on the preserved branch per decision. A refused *approach* may instead
start the ticket over from the base, bounded by `runtime.limits.restarts`
(breadth). Past the automatic bounds, a person decides. An
agent that never started met something account-wide, so the conductor pauses
until the reset and the item goes back to the queue untouched. An agent that
started and did not finish judged nothing: it buys no round, pauses nothing, and
holds the item for a person — unless what stopped it is only transient (an
API that answered 5xx, an edge that refused the request), which a rule retries
in place, in the same attempt, without a person. Lingtai's own failures never reach an agent at all. A base
that is already red holds nothing for a person: the item goes back to the queue
and is passed over until the base is green. **A person is the floor, not the
default**: whatever a rule or a declared judge can answer is answered there, and
what reaches a person is what neither could.

## Context

An attempt can end badly in four unlike ways: a judgement about the diff, a check
that went red, an account that will not run an agent, and an agent that died
mid-run. They cost different money. A loop that re-buys agents without a bound
never errors, it only spends; an account-wide quota answered item by item walks
the whole queue into the same wall; a crash recorded as a refusal pays a fixer
to answer a question nobody asked. *Where* a refusal goes next (the router at
`proposed`, `judge:`, the offered set) is the pipeline's, ADR [0103](0103-a-pass-is-ten-fixed-steps.md); this ADR
fixes the bounds and the endings that router works inside.

## Decision

1. **Lingtai's own failures never reach an agent.** A recipe that will not
   resolve, a missing GitHub App or env value, no hook binary, an unreachable
   database: nothing in the repository is broken, so nothing an agent could do
   would help. `conduct.ts` answers these before it claims (for example
   `stage: "recipe"`), and `whoseFailure` in `packages/conductor/src/attribution.ts`
   names the owner on the card (`lingtai` or `repository`). The owner decides the
   sentence a person reads, never a purchase.

2. **The worktree is the whole of an attempt.** It is cut `--force --detach` at the
   base's sha from the mirror `~/.lingtai/repos/<project>.git` into
   `~/.lingtai/worktrees/<project>/<runId>` (`provisionWorktree`,
   `packages/repo/src/worktree.ts`), and its scope encloses the merge lane.
   Detached is what makes that possible: no worktree has `agent/<n>` checked out,
   so the lane can fetch and update it. Every refusal therefore happens while the
   work is still on disk, and a new attempt is the answer only to an attempt that ended.

3. **A refusal is answered in that worktree, carrying its own evidence — one
   round.** A round is `implement` again with `fixBrief` (`packages/conductor/src/fix.ts`)
   instead of the ticket prompt, then the attempt walks forward through `build`,
   `review` and `proposed` again. The evidence is one argument with three shapes:
   the reviewer's findings, a command's output (both ends, clipped to
   `runtime.budget.evidence`), or the paths the lane could not merge. The round
   is logged as `FixRequested` then `FixApplied`, on the implementer's runtime.

4. **Only a refusal with a criterion buys an agent.** A finding counts only if it
   carries a `failureScenario`; a command's refusal only if it printed something.
   Each is an acceptance test the fixer did not write: the scenario still happens
   or it does not, and green is green. A refusal with neither, or a reviewer answer
   that would not parse, goes to a person with no round offered. A step before
   any agent has run (`prepared`) cannot offer `implement` however many rounds
   are left.

5. **The fixer gets the findings, the diff and the ticket, not the reasoning,
   and may decline.** Each `failureScenario` is passed verbatim with the diff
   (clipped at `runtime.budget.diff`), the ticket's body as it reads at the round
   (what the cold reviewer held the change to — context, and the findings stay
   the criterion), and, on a round a person granted, the `FixableLines` advice
   triage gave for the wait they granted it on, marked as what they accepted. No
   plan, transcript or session of the implementer's. The re-review is handed the same findings
   (`ActionContext.recheck`) and asked whether those sequences still happen, so
   silencing a finding does not pass. `fixBrief` tells the fixer that if the
   refusal is wrong or not this diff's, it changes nothing and commits nothing;
   a round with no new commit stops the attempt and holds the item for a person
   with the fixer's final message.

6. **What buys a round by default is mechanical; a judgement needs a declared
   judge.** A red check (`red`) and a re-verify that went red on a moved base
   (`verify-failed`) are answered by the built-in `same-worktree` judge: back to
   `implement` while a round is left, else a person. `findings`, `conflict` and
   `needs-input` go to a person unless the recipe declares a `judge:` at
   `proposed` for that `when:`. So a finding buys an agent before it buys a
   person's attention exactly when the recipe says so — this repository declares
   `judge: claude-code` at `findings`. A judge chooses only from the set the
   workflow offers and never sees the ceilings.

7. **A restart starts the ticket over from the base, and only a judgement earns
   one.** It is the `claim` destination: offered only for `findings` and only
   while `restarts` are left. An attempt held by a declared `human:` or `watch:`
   action stops for that person and never reaches the router. A red check or a conflict never
   restarts, whatever a recipe or a judge says, because their work is still
   there. The approach being abandoned is pushed to its arm
   `agent/<n>-attempt-<k>` first; then `PassRestarted` (arm, head sha, rounds
   spent, every finding) goes on the work item's stream; then the claim is
   released. If the arm is not on origin, no restart is spent and the attempt ends
   as `failed`. A restarted item waits out `source.backoff` like any release.

8. **The recipe bounds automatic spending; a person can grant one more round.**
   `runtime.limits` holds `turns` (300) and `wall`
   (`2h`), which bound one agent run, and `rounds` (2) and `restarts` (0), which
   count runs an attempt and attempts a ticket may buy automatically. `rounds: 0`
   sends every refusal to a person; `restarts: 0` sends a spent attempt to a person. `rounds` and
   `restarts` written inside a dispatch's own `limits:` are refused by name.
   The automatic ceiling for a ticket is `(restarts + 1) × (rounds + 1) × wall`, and
   `attemptCeiling` (`packages/conductor/src/ceiling.ts`) is the one function that
   says it, wherever a project's limits are shown (onboarding, the project
   listing, `lingtai doctor`). Since `#370`, the same block may hold `usd` — a
   dollar ceiling on one run, with no default — and where it is declared the
   automatic ceiling gains the dollar product: `(restarts + 1) × (rounds + 1) × usd`,
   printed beside the time figure rather than in place of it. **A third bound
   is free and is not a knob** (#593): when the base moved on files the branch
   also changed, the system merges it in itself and the attempt builds and reviews
   again — no agent runs for the merge and no `round` is spent — at most
   `BASE_MERGES_LIMIT` (10) times per attempt, then a person. It adds nothing to the
   ceiling above beyond the `build` and `review` it reruns. **A merge conflict buys its fix round from its own budget** (#653): as many conflict rounds per attempt as `rounds` allows, counted apart from `rounds` and never drawn from it, so a base that moves often cannot spend the rounds a review's findings need. There is no knob of its own: a conflict round runs an agent and costs what a fix round costs, so the recipe's one number bounds both. Its result passes `build`, `review` and `proposed` again, a review that then refuses buying from `rounds` as usual. Once both are spent a person is reached. **The mechanical bounds are constants, not knobs**: `BASE_MERGES_LIMIT` (a base merge, no agent) and `TRANSIENT_RETRIES_LIMIT` (§12, §15) live in `packages/domain/src/routing.ts`, are never written in a recipe, and exist to stop a loop. **Every automatic path has one total, and it is counted per attempt**: an attempt runs at most `1 + rounds` agent runs that write code for findings and red checks, `rounds` more for conflicts, and `TRANSIENT_RETRIES_LIMIT` reruns of a run a transient error cut off — whatever role that run had — and a ticket has at most `restarts + 1` attempts. So the automatic ceiling is `(restarts + 1) × (2 × rounds + 1 + TRANSIENT_RETRIES_LIMIT) × wall`, and the same product in `usd` where `usd` is declared; `attemptCeiling` says it. None of these counters is reset inside an attempt — not by a transient retry, not by a landing retried from its saved head (§15) — and each starts at zero only with a new attempt, which is either a restart (counted in `restarts`) or a person's `Requeue` (a person's decision, outside the automatic ceiling, 0118 §7). Absent, the
   sentence is unchanged, character for character. A person's `GrantFixRound`
   ([#426](https://github.com/steven-zhc/lingtai/issues/426)) authorizes exactly
   one additional `implement` round on saved work when the wait has a fixable
   refusal with evidence and a recorded remote ref. The ref must still exist at
   the saved head sha; a missing or moved ref refuses the grant. It does not
   change `runtime.limits.rounds`, authorize another automatic round, or waive
   the refusal. The grant and the extra run's spend are recorded and visible;
   another round needs another decision. Each granted run still obeys its own
   `turns`, `wall` and, when declared, `usd` ceilings. Like any round (§3), its
   result passes `build`, `review` and `proposed` again before the merge lane
   may land it ([0118](0118-a-hold-explains-itself.md) §1, §11). A person's
   `Requeue` instead starts a new attempt from base with the recipe's rounds; it
   neither spends nor refunds an automatic restart (0118 §7).

9. **A minor finding does not refuse; it is filed.** `verdictFor`
    (`packages/actions/src/agent-action.ts`) refuses on a `blocker` or `major` and
    passes on `minor`. A passing step's findings ride on `StepPassed.findings` and
    collect in the `finding_backlog` projection. A person decides one entry at a
    time with `lingtai backlog` or the board's backlog page; nothing is decided by
    rule. Accepting appends `FindingAccepted` on `bkl-<project>-<key>`, then the
    `TicketStore` opens the issue (`FindingProposed`); declining appends
    `FindingDeclined` (`packages/conductor/src/backlog.ts`).

10. **"Never started" is three facts, never the message.** A receipt is
    `never-started` when it is an error, took at most one turn and cost nothing
    (`neverStarted`, `packages/agent/src/runtime.ts`; for Codex, a `turn.failed`
    with no agent message). The runtime's prose is kept whole as `detail` and is
    never read to classify, and the name is not a guessed cause such as a quota.

11. **An agent that never started locks its runtime's account, not the item.**
    Wherever it happens — the implementer, a design agent, a reviewer, a fixer,
    an agent judge — the step ends `never-ran` (`StepNeverRan`) and the attempt
    stops: no round, no judge, no question for a person. The attempt appends
    `AccountLimitReached` on `acct-{runtime}`, for the runtime that agent ran on,
    with an `until` ([0126](0126-a-stop-is-a-lock-and-an-unlock.md) §2);
    `standDown` (`packages/conductor/src/never-started.ts`) reads a reset time out
    of the message (an ISO instant, a dated clock, or a wall clock, at most a week
    out) and falls back to `source.backoff`. A lock already holding is left alone.
    The lock holds every project whose recipe uses that runtime, is lifted by the
    guard once `until` has passed or by a person (0126 §7), and names which agent met the wall. The item is released
    (`failed`) and keeps its place; any commits are published first. **A run that
    started and met the account's limit locks the account the same way** — a crash
    whose detail is the runtime's own account-limit sentence (`accountWallOf`:
    Claude Code's *You've hit your … limit*, Codex's *You have hit your usage
    limit*) appends the same `AccountLimitReached`, with the same `until` and
    fallback — but the item is **not** released: it keeps its crash wait (§12),
    and the match adds the lock and changes nothing else.

12. **An agent that started and did not finish judged nothing, and stops only
    the attempt.** A crash, a spent turn budget, a missing receipt, or a fixer that
    committed nothing ends the step `did-not-finish` (`StepDidNotFinish`). It buys
    no round, reaches no judge, is not retried, and does not pause the conductor,
    because a crash is local — except a crash whose detail is the runtime's account-limit
    sentence, which pauses it as §11 says and is still the ticket's wait. The item is blocked for a person; the card offers no
    approval, because no step judged the diff, and the move left is requeue.
    **A run that a transient error cut off is run again in place, not held.**
    When the runtime's own detail is an API error a retry can clear — a 5xx, a
    429, or an edge's refusal page (Cloudflare's *Attention Required*, a 403
    that carries it) — the same attempt reruns that same run: the same role,
    the same brief, the same worktree as the cut-off run left it, after a short
    wait that grows (1, 5, 15 minutes). It is not a requeue and not a restart:
    no new attempt starts, nothing is cut from the base, no `round` and no
    `restart` is spent or reset, and the attempt's other counters stand. Each
    rerun counts against the attempt's `TRANSIENT_RETRIES_LIMIT` (3), which is
    counted over the whole attempt, not over consecutive failures, and is in
    the ceiling (§8). With it spent, the next transient crash holds for a
    person as above. Which sentences count is a row of the failure module's
    table (§19), matched on the runtime's own words, and a sentence not on
    it is a crash. The list's evidence is
    [doc/design/platform-errors.md](../design/platform-errors.md), and it holds
    two rules from there: the edge's refusal page is matched on its title,
    never as *a 403*, because every 403 either API documents is repeatable; and
    a 429 that names a spend or billing limit — Anthropic's
    `enforced_spend_limit_reached` (sent with no `retry-after`), OpenAI's
    billing `error.code`s — is not transient, since it fails until a person or
    the month changes it. A runtime's sentence for an error is listed only once
    a run has printed it. A step
    that stopped to ask a question is a different ending (`StepAsked`) and goes
    to the router.


13. **A refusal the base shares buys nothing.** Before a `build` refusal buys
    a round, the refused command is run on the attempt's base commit. If it fails
    there too, the refusal is not about the diff: no round is bought, and the
    attempt stops without a wait: its branch is published at its head, and the
    item goes back to the queue keeping its place and that head. A fix agent does not fix what
    it did not break, and a person has nothing to decide about this ticket — the
    base is someone's to fix, and who is not Lingtai's to guess (in a team's
    repository it is usually not this ticket's author). **The queue passes the
    item over as `base-red` while the recorded result for the current base
    commit is red**, and the board and `lingtai status` show it in the queue
    with the check that is red, the same way they show `blocked-by`. The base's
    result is recorded on the log, keyed by the base commit, the command and the boundary it
    ran under (`unsandboxed`, or a fingerprint of the sandbox policy; 0127 §15) —
    an answer under one boundary never answers a question under another — so
    attempts in flight and every queued ticket reuse it; when the base moves the
    check runs once on the new commit — no agent, no claim — and a green result
    lets every item it held be taken again. **Taken again, it continues from
    its saved head, not from the base**: the new base is merged in and `build`
    runs again, then `review` and `proposed` as after any base merge (§8,
    counted in `BASE_MERGES_LIMIT`); nothing is implemented again, and it is the
    same attempt continued, so its counters (§8) stand. Only a head
    that can no longer be continued starts over from the base, as a restart
    (§15). Lingtai opens no ticket about a red base.

14. **A diff the reviewer cannot read whole buys nothing.** Before `review`,
    the diff the reviewer would be handed is measured the way it is clipped,
    against `runtime.budget.diff`. When it is longer, no reviewer and no judge
    is paid: the attempt holds for a person (`DiffTooLarge`), naming the size and
    the limit, and no fix round is offered, because a fix agent cannot make a
    change smaller without dropping what the ticket asked for. Triage is asked
    and may advise `Split` with its plan (0118 §12). The person may also
    `Approve`, which runs the review on the clipped diff and records that the
    reviewer read only the first part, so the summary and the task page say so.

15. **A landing the remote refused for a transient reason is retried from its
    saved head, not built again.** The lane already retries a push that GitHub
    answered with a 5xx in place (`remote-error`, #1125). When those retries
    are spent too, the work is finished and only the landing is owed: the
    branch is published at its head, and after a wait that grows (as in §12)
    the rule continues the attempt into the merge lane from that recorded head
    — the same continuation a person's `Approve` makes (0118 §11), with the
    recorded head as its `onSha` — counting against the attempt's
    `TRANSIENT_RETRIES_LIMIT`. Nothing is implemented, built or reviewed again
    unless the base moved meanwhile, and then the lane's own rules apply: a
    clean move is merged and verified again (§8's base merge), a conflict buys
    a conflict round. **Only when the head cannot be continued** — the branch
    is gone or no longer at the recorded sha — may the ticket start over from
    the base, and that is a restart: it is counted in `restarts`, and with none
    left it holds for a person. A refusal the remote will repeat — a 4xx, a
    protected branch (`GH006`, `GH013`), push protection, a declined
    pre-receive hook, a file or a push over GitHub's size limits — holds for a
    person at once, because retrying it buys nothing
    ([doc/design/platform-errors.md](../design/platform-errors.md) §2). git's
    *the remote end hung up unexpectedly* is both a dropped connection and
    GitHub's sign of a push over 2 GiB, so it is retried as transient, and the
    hold that follows its spent retries names both causes rather than only
    *origin could not be reached*.

16. **A rule comes before a judge, and triage never acts.** What is only
    mechanical or only transient (§8, §12, §13, §15) is answered by a rule,
    which costs nothing and runs no agent; a judgement is a judge declared at
    `proposed` (§6); what neither answers is a wait. Triage
    ([0118](0118-a-hold-explains-itself.md)) is the report a person reads on
    that wait — it advises and never moves the item, and it is not asked
    about anything a rule or a judge already answered.

17. **A red check is run twice before it is believed, and a flaky red that is
    not this diff's does not stop it.** When a check refuses — `build`, a
    declared check (`check-refused`), or the base check (§13) — the same
    command runs once more on the same commit, at once. Red twice is red, and
    goes where red goes. Red then green is flaky, and it lets the attempt go on
    only when all three hold: (1) the second run is green; (2) no failing test's
    file is in this ticket's diff; (3) that test has failed on the base before —
    the base check's record or the backlog already names it as flaky. Then the
    attempt continues, and the flaky test is recorded as a backlog finding
    (§9) for a person to decide; Lingtai opens no ticket for it. If any of the
    three fails, or the failing test cannot be named from the command's
    output, it is red: a test this diff added or touched, or one never seen
    failing on the base, is this diff's until shown otherwise. On the base
    check, red then green is green. The rerun runs no agent; it costs the
    check's time once.

18. **Every other reason the router hears has its answer written down.**

    | Reason | What it means | Answered by |
    | --- | --- | --- |
    | `setup-refused` | `prepared` failed before any agent ran (an install, a setup command) | A rule: a transient error in the failure table (a registry's 5xx) reruns the step in place (§12); anything else is a person's, because it is the environment, not the code |
    | `check-refused` | A check declared at `proposed` or before the lane refused | A rule: run twice (§17); red with output is answered as `red` — a round in the same worktree |
    | `answer-unreadable` | An agent answered and the machine could not read it | A rule: the same agent is asked again in place, once, counted as a transient rerun (§12); unreadable again is a person's |
    | `nothing-produced` | `implement`'s first run committed nothing | A judge, where declared: the ticket is unclear (a person's, with triage saying what is missing) or the work is unfinished (one more round); undeclared, a person |
    | `fixer-disagrees` | A fix round committed nothing because the fixer holds the finding wrong | A judge, where declared: rules between the reviewer and the fixer; undeclared, a person. §17 removes the commonest case, a flaky red the fixer rightly refused |
    | `needs-input` | A step asked a question only a person can answer | Always a person |

19. **Every failure rule lives in one module, as tables.** `packages/domain/src/failure/`
    holds three pure steps and nothing that does IO: **classify** turns what a
    platform or a tool said — a status, a header, git's stderr, a runtime's
    sentence — into a failure kind, by the error table (platform, match,
    transient / repeatable / account limit, where the wait is read from, and
    the documented source); **respond** turns a failure kind and the attempt's
    counters into one answer — rerun in place, lock the account, continue from
    the saved head, ask a judge, or a person — within §8's one total; and
    **explain** gives the sentence and the move a person reads when the answer
    is a person. The packages that meet a failure only hand what they saw to
    *classify* and carry out what *respond* says; none keeps a rule of its own.
    The tables are the source of
    [doc/design/platform-errors.md](../design/platform-errors.md) and of this
    ADR's routing, both generated, and a test fails when a generated file is
    stale. A new rule is a row, a test that feeds the row the platform's own
    words, and a regeneration — nothing else.

## Consequences

- Every refusal is one flow with one ceiling. Only the evidence differs between a
  build, a review and a lane refusal.
- An attempt never re-implements work it still has, on disk or on its saved head (§13, §15); only a head that can no longer be continued, counted as a restart, or a judge that says
  *the approach* can buy a fresh attempt.
- The release reason carries the step, the ending and the runtime's own words
  (`TicketReleased.reason`). The next attempt's brief quotes it, so changing
  that wording changes what the next agent reads.
- A misread reset time costs a wasted attempt, never a wrong decision: resuming
  early meets the wall and pauses again.
- A crash at `implement` costs a person's attention, not an agent. Whether the
  implementer deserves a retry of its own is unmeasured and not offered.

## Not built yet

- **The 2026-11-13 amendment.** §12's transient requeue and its list of
  sentences, rerunning the cut-off run in place; §13's release with
  `base-red` in the queue and the check rerun per base commit (today the
  attempt still holds for a person, `base is red: <check>`); §15's landing
  continued from the saved head after the lane's retries; `BASE_MERGES_LIMIT`
  raised from 2 to 10 and `TRANSIENT_RETRIES_LIMIT` added; the conflict budget
  drawn from `rounds` rather than `CONFLICT_ROUNDS_LIMIT = 2`; and
  `attemptCeiling` saying the one total of §8. §17's second run, §18's
  answers, and §19's module — today the rules are in `network.ts`,
  `github/src/app.ts`, `never-started.ts`, `judge.ts`'s `BUILT_IN_FOR`,
  `routing.ts` and `attribution.ts`, and `platform-errors.md` is written by
  hand.

- **`backlog:` does not set the bar.** The plugin is declared in
  `packages/recipe/src/recipe.ts`, but the `minor` bar is still a literal in
  `verdictFor` and in the backlog reduce. Wiring it means handing one value to both.

---
*Replaces archived 0025, 0031, 0038, 0039, 0040, 0041, 0057 in [decisions-archive](../decisions-archive/).*
