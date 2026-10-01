# 0108 — Failure, fix rounds and restarts: a refusal buys a round in the same worktree, a wall stops the conductor, and a crash stops the pass

**Status** accepted · 2026-10-01

A step that refuses with something an agent can be held to sends the agent back
into the same worktree, carrying the evidence; `runtime.limits.rounds` bounds how
often (depth). A refused *approach* may instead start the ticket over from the
base, bounded by `runtime.limits.restarts` (breadth). Past both, a person. An
agent that never started met something account-wide, so the conductor pauses
until the reset and the item goes back to the queue untouched. An agent that
started and did not finish judged nothing: it buys no round, pauses nothing, and
holds the item for a person. Lingtai's own failures never reach an agent at all.

## Context

A pass can end badly in four unlike ways: a judgement about the diff, a check
that went red, an account that will not run an agent, and an agent that died
mid-run. They cost different money and need different answers. A retry that is
not told what refused it pays again for the same result, and a loop that re-buys
agents without a bound spends money without ever producing an error. An
account-wide quota answered item by item walks the whole queue into the same
wall in seconds. And a crash recorded as a refusal sends a fixing agent to answer
a question nobody asked. This ADR fixes what each ending costs. *Where* a refusal
goes next — the router at `proposed`, `judge:`, the offered set — is the
pipeline's (ADR 0103); this one fixes the bounds and the endings that router works
inside.

## Decision

1. **Lingtai's own failures never reach an agent.** A recipe that will not
   resolve, a missing GitHub App or env value, no hook binary, an unreachable
   database: nothing in the repository is broken, so nothing an agent could do
   would help. `conduct.ts` answers these before it claims (for example
   `stage: "recipe"`), and `whoseFailure` in `packages/conductor/src/attribution.ts`
   names the owner on the card (`lingtai` or `repository`). The owner decides the
   sentence a person reads, never a purchase.

2. **The worktree is the whole of a pass.** It is cut `--force --detach` at the
   base's sha from the mirror `~/.lingtai/repos/<project>.git` into
   `~/.lingtai/worktrees/<project>/<runId>` (`provisionWorktree`,
   `packages/repo/src/worktree.ts`), and its scope encloses the merge lane.
   Detached is what makes that possible: no worktree has `agent/<n>` checked out,
   so the lane can fetch and update it. Every refusal therefore happens while the
   work is still on disk, and a new run is the answer only to a pass that ended.

3. **A refusal is answered in that worktree, carrying its own evidence — one
   round.** A round is `implement` again with `fixBrief` (`packages/conductor/src/fix.ts`)
   instead of the ticket prompt, then the pass walks forward through `build`,
   `review` and `proposed` again. The evidence is one argument with three shapes:
   the reviewer's findings, a command's output (both ends, clipped to
   `runtime.budget.evidence`), or the paths the lane could not merge. The round
   is logged as `FixRequested` then `FixApplied` on the run's stream, and runs on
   the same runtime as the implementer.

4. **Only a refusal with a criterion buys an agent.** A finding counts only if it
   carries a `failureScenario`; a command's refusal only if it printed something.
   Each is an acceptance test the fixer did not write: the scenario still happens
   or it does not, and green is green. A refusal with neither, or a reviewer answer
   that would not parse, goes to a person with no round offered. A step before
   any agent has run (`prepared`) cannot offer `implement` however many rounds
   are left.

5. **The fixer gets the findings and the diff, not the reasoning.** Each
   `failureScenario` is passed verbatim, with the diff `base...HEAD` clipped at
   `runtime.budget.diff`, and no plan, transcript or session of the implementer.
   It is told to change nothing beyond the refusal. The re-review is handed the
   findings the round was bought on (`ActionContext.recheck`) and asked whether
   those sequences still produce those outcomes, so deleting a line or renaming a
   symbol does not pass.

6. **The fixer may decline, and declining is committing nothing.** `fixBrief`
   says so in as many words: if the refusal is wrong or is not this diff's,
   change nothing and commit nothing. A round with no new commit stops the pass
   and holds the item for a person with the fixer's final message. No approval is
   offered on that card, because nothing judged a diff.

7. **What buys a round by default is mechanical; a judgement needs a declared
   judge.** A red check (`red`) and a re-verify that went red on a moved base
   (`verify-failed`) are answered by the built-in `same-worktree` judge: back to
   `implement` while a round is left, else a person. `findings`, `conflict` and
   `needs-input` go to a person unless the recipe declares a `judge:` at
   `proposed` for that `when:`. So a finding buys an agent before it buys a
   person's attention exactly when the recipe says so — this repository declares
   `judge: claude-code` at `findings`. A judge chooses only from the set the
   workflow offers and never sees the ceilings.

8. **A restart starts the ticket over from the base, and only a judgement earns
   one.** It is the `claim` destination: offered only for `findings`, only while
   `restarts` are left, and never while something else on the pass is asking a
   person (a `human:` or `watch:` action). A red check or a conflict never
   restarts, whatever a recipe or a judge says, because their work is still
   there. The approach being abandoned is pushed to its arm
   `agent/<n>-attempt-<k>` first; then `PassRestarted` (arm, head sha, rounds
   spent, every finding) goes on the work item's stream; then the claim is
   released. If the arm is not on origin, no restart is spent and the pass ends
   as `failed`. A restarted item waits out `source.backoff` like any release.

9. **The limits are one block.** `runtime.limits` holds `turns` (300) and `wall`
   (`2h`), which bound one agent run, and `rounds` (2) and `restarts` (0), which
   count runs a pass and passes a ticket may buy. `rounds: 0` sends every refusal
   to a person; `restarts: 0` sends a spent pass to a person. `rounds` and
   `restarts` written inside a dispatch's own `limits:` are refused by name.
   What a ticket may cost is `(restarts + 1) × (rounds + 1) × wall`, and
   `passCeiling` (`packages/conductor/src/ceiling.ts`) is the one function that
   says it, wherever a project's limits are shown (onboarding, the project
   listing, `lingtai doctor`).

10. **A minor finding does not refuse; it is filed.** `verdictFor`
    (`packages/actions/src/agent-action.ts`) refuses on a `blocker` or `major` and
    passes on `minor`. A passing step's findings ride on `StepPassed.findings` and
    collect in the `finding_backlog` projection. A person decides one entry at a
    time with `lingtai backlog` or the board's backlog page; nothing is decided by
    rule. Accepting appends `FindingAccepted` on `bkl-<project>-<key>`, then the
    `TicketStore` opens the issue (`FindingProposed`); declining appends
    `FindingDeclined` (`packages/conductor/src/backlog.ts`).

11. **"Never started" is three facts, never the message.** A receipt is
    `never-started` when it is an error, took at most one turn and cost nothing
    (`neverStarted`, `packages/agent/src/runtime.ts`). For Codex it is a
    `turn.failed` with no completed turn and no agent message. The runtime's prose
    is kept whole as `detail` and never read to classify. The outcome is named for
    what is checkable, not for a cause such as a quota.

12. **An agent that never started stops the conductor, not the item.** Wherever
    it happens — the implementer, a design agent, a reviewer, a fixer, an agent
    judge — the step ends `never-ran` (`StepNeverRan`) and the pass stops: no
    round, no judge, no question for a person. The conductor appends
    `ConductorPaused` on `ctl-conductor` with an `until`; `standDown`
    (`packages/conductor/src/never-started.ts`) reads a reset time out of the
    message (an ISO instant, a dated clock, or a wall clock, at most a week out)
    and falls back to `source.backoff`. A pause already holding is left alone, so
    a person's pause is never overwritten. The pause lifts by itself. The item is
    released (`failed`), keeps its place, and any commits are published first.
    The pause sentence names which agent met the wall and whether anything had
    already been paid for.

13. **An agent that started and did not finish judged nothing, and stops only
    the pass.** A crash, a spent turn budget, a missing receipt, or a fixer that
    committed nothing ends the step `did-not-finish` (`StepDidNotFinish`). It buys
    no round, reaches no judge, is not retried, and does not pause the conductor,
    because a crash is local. The item is blocked for a person; the card offers no
    approval, since no step judged the diff, and the move left is requeue. A step
    that stopped to ask a question is a different ending (`StepAsked`) and goes
    to the router.

## Consequences

- Every refusal is one flow with one ceiling. Only the evidence differs between a
  build, a review and a lane refusal.
- A pass never buys a second implementation of work it still has on disk. A
  fresh pass costs one backoff and one claim, and only a declared judge that
  says *the approach* can buy one.
- The release reason carries the step, the ending and the runtime's own words
  (`WorkItemReleased.reason`). The next attempt's brief quotes it, so changing
  that wording changes what the next agent reads.
- A wrongly read reset time only costs a wasted pass. Resuming early meets the
  wall again and pauses again; a reset this build could not parse is said as a
  parser fault.
- A judge that answers outside the offered set is refused by name and the pass
  goes to a person. An agent judge that answers nothing also goes to a person,
  never round again.
- A crash at `implement` costs a person's attention, not an agent. Whether the
  implementer deserves a retry of its own is unmeasured and not offered.

## Not built yet

- **`backlog:` does not set the bar.** The plugin is declared in
  `packages/recipe/src/recipe.ts`, but the `minor` bar is still a literal in
  `verdictFor` and in the backlog fold. Wiring it means handing one value to both.

---
*Replaces archived 0025, 0031, 0038, 0039, 0040, 0041, 0057 in [decisions-archive](../decisions-archive/).*
