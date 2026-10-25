# Glossary

## What happens next

Seven words say what happens next to a ticket, and one question decides what
each costs: does it **continue the saved branch**, or **cut a new branch from
the base**? This section describes what is built. Where it and the code
disagree, the code is right and this is corrected.

| | Continues the saved branch | Cuts a new branch from the base |
|---|---|---|
| **The machine** | **fix round** (修复轮) — another `design` or `implement` in the same worktree, carrying what refused it. Code: `FixRound` (`packages/domain/src/pass-next.ts`). Bounded by `runtime.limits.rounds`. | **restart** (重来) — the ticket is released and claimed again. Code: `Requeued{cause: Restart}` as a `PassNext`, `TicketReleased{cause: Restart}` on the log (`packages/domain/src/events.ts`, `packages/conductor/src/conduct.ts`). Bounded by `runtime.limits.restarts`. |
| **A person** | **GrantFixRound** (批一轮) — one more `implement` on the saved head, then build → review → proposed; ends at a person. Board: *Continue fixing current work*; CLI: `lingtai grant-fix-round` (`apps/cli/src/grant-fix-round.ts`).<br>**Approve** (批准) — no new work; continue past the refusal. Board: *Approve and continue*; CLI: `lingtai approve` (`apps/cli/src/approve.ts`). | **Requeue** (重新排队) — `TicketReleased{cause: ByPerson}`; spends no restart, because only `cause: Restart` is counted. Board: *Start over from base*; CLI: `lingtai requeue` (`apps/cli/src/requeue.ts`).<br>**EditBodyAndRequeue** — write into the body, then requeue. Board: *Add to the ticket and start over*; CLI: `lingtai requeue --into-body`. |

- **Continuation** (续跑) is the umbrella for every move a person makes in the
  left column: the conductor calls `runPass({ from: … })`, which still starts
  at `admit` and runs `prepared`, then jumps to the step the move resumes at
  rather than walking the steps between (`packages/conductor/src/pass.ts`;
  scheduled by `requestContinuation` in
  `packages/conductor/src/resolve-wait.ts`). The machine's fix round is not
  one: it stays inside the same `runPass` loop. Neither move in the right
  column is one; each starts a new pass.
- A requeued pass is still told about earlier attempts and where their commits
  are (`attemptBrief` and the arms on origin, `packages/conductor/src/prompt.ts`),
  so it can reuse that work — but it is new development and goes through build
  and review again.
- A person's moves are the `Resolution` type of
  [0118](decisions/0118-a-hold-explains-itself.md) §1; the granted round is
  [0108](decisions/0108-a-refusal-buys-a-round.md) §8 and restart counting is
  0120 §5.
- [The pass](the-pass.html) shows where each of these arrives from.
