# 0108 — Failure, fix rounds and restarts: a refusal buys a round in the same worktree, a wall stops the conductor, and a crash stops the attempt

**Status** accepted · 2026-10-01 · amended 2026-11-13: a rule answers what is only transient, a red base puts the item back in the queue, a conflict's budget is `rounds`, and the mechanical bounds are constants

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
without a person. Lingtai's own failures never reach an agent at all. A base
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
   ceiling above beyond the `build` and `review` it reruns. **A merge conflict buys its fix round from its own budget** (#653): as many conflict rounds per attempt as `rounds` allows, counted apart from `rounds` and never drawn from it, so a base that moves often cannot spend the rounds a review's findings need. There is no knob of its own: a conflict round runs an agent and costs what a fix round costs, so the recipe's one number bounds both, and the automatic ceiling above counts it — `(restarts + 1) × (2 × rounds + 1) × wall`, and the same for `usd`. Its result passes `build`, `review` and `proposed` again, a review that then refuses buying from `rounds` as usual. Once both are spent a person is reached. **The mechanical bounds are constants, not knobs**: a base merge (`BASE_MERGES_LIMIT`) and a transient retry (`TRANSIENT_RETRIES_LIMIT`, §12, §15) run no agent and cost nothing beyond the checks they rerun, so they are set high in `packages/domain/src/routing.ts`, are never written in a recipe, and exist only to stop a loop. Absent, the
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
    whose detail is the runtime's own account-limit sentence (`metTheAccountWall`:
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
    **A crash that is only transient is requeued by rule, not held.** When the
    runtime's own detail is an API error with a status a retry can clear — a 5xx,
    a 429, or an edge's refusal page (Cloudflare's *Attention Required*, a 403
    that carries it) — the attempt publishes its commits, the item is released
    (`failed`) and keeps its place, exactly as a requeue would, and the next
    attempt starts after `source.backoff`. At most `TRANSIENT_RETRIES_LIMIT` (3)
    such retries follow one another for a ticket; the next transient crash holds
    for a person as above. Which sentences count is a list in one function,
    matched on the runtime's own words like `metTheAccountWall`, and a sentence
    not on it is a crash. A step
    that stopped to ask a question is a different ending (`StepAsked`) and goes
    to the router.


13. **A refusal the base shares buys nothing.** Before a `build` refusal buys
    a round, the refused command is run on the attempt's base commit. If it fails
    there too, the refusal is not about the diff: no round is bought, and the
    attempt ends without a wait: its commits are published, the item is released
    and goes back to the queue, keeping its place. A fix agent does not fix what
    it did not break, and a person has nothing to decide about this ticket — the
    base is someone's to fix, and who is not Lingtai's to guess (in a team's
    repository it is usually not this ticket's author). **The queue passes the
    item over as `base-red` while the recorded result for the current base
    commit is red**, and the board and `lingtai status` show it in the queue
    with the check that is red, the same way they show `blocked-by`. The base's
    result is recorded on the log, keyed by the base commit and the command, so
    attempts in flight and every queued ticket reuse it; when the base moves the
    check runs once on the new commit — no agent, no claim — and a green result
    lets every item it held be taken again. Lingtai opens no ticket about a red
    base.

14. **A diff the reviewer cannot read whole buys nothing.** Before `review`,
    the diff the reviewer would be handed is measured the way it is clipped,
    against `runtime.budget.diff`. When it is longer, no reviewer and no judge
    is paid: the attempt holds for a person (`DiffTooLarge`), naming the size and
    the limit, and no fix round is offered, because a fix agent cannot make a
    change smaller without dropping what the ticket asked for. Triage is asked
    and may advise `Split` with its plan (0118 §12). The person may also
    `Approve`, which runs the review on the clipped diff and records that the
    reviewer read only the first part, so the summary and the task page say so.

15. **A landing the remote refused for a transient reason is retried by rule.**
    The lane already retries a push that GitHub answered with a 5xx in place
    (`remote-error`, #1125). When those retries are spent too, the router does
    not hand the item to a person: it is released and keeps its place, as in
    §12, counting against the same `TRANSIENT_RETRIES_LIMIT`. A refusal the
    remote will repeat — a 4xx (a protected branch, a missing permission), a
    rejected non-fast-forward the lane could not merge — still holds for a
    person, because retrying it buys nothing.

16. **A rule comes before a judge, and triage never acts.** What is only
    mechanical or only transient (§8, §12, §13, §15) is answered by a rule,
    which costs nothing and runs no agent; a judgement is a judge declared at
    `proposed` (§6); what neither answers is a wait. Triage
    ([0118](0118-a-hold-explains-itself.md)) is the report a person reads on
    that wait — it advises and never moves the item, and it is not asked
    about anything a rule or a judge already answered.

## Consequences

- Every refusal is one flow with one ceiling. Only the evidence differs between a
  build, a review and a lane refusal.
- An attempt never re-implements work it still has on disk; only a judge that says
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
  sentences; §13's release with `base-red` in the queue and the check rerun
  per base commit (today the attempt still holds for a person, `base is red:
  <check>`); §15's release after the lane's retries; `BASE_MERGES_LIMIT`
  raised from 2 to 10 and `TRANSIENT_RETRIES_LIMIT` added; the conflict budget
  drawn from `rounds` rather than `CONFLICT_ROUNDS_LIMIT = 2`, and
  `attemptCeiling` counting it.

- **`backlog:` does not set the bar.** The plugin is declared in
  `packages/recipe/src/recipe.ts`, but the `minor` bar is still a literal in
  `verdictFor` and in the backlog reduce. Wiring it means handing one value to both.

---
*Replaces archived 0025, 0031, 0038, 0039, 0040, 0041, 0057 in [decisions-archive](../decisions-archive/).*
