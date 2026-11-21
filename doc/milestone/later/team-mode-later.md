# Later — team mode, after 0.16

**Status** proposed, not scheduled · 2026-11-20, moved out of 0.16.0 by the
operator after the cold review of [0130](../../decisions/0130-a-project-is-solo-or-team.md).

## Review state and comments on the PR page

0.16 reads only whether the open PR was merged or closed, and links to the
review on the code host. Showing the review's state (approved, changes asked)
and its comments means reading them in the sweep — one request for the one open
PR, stopped early when it has not changed — and drawing them on the PR page (an earlier
mock showed *li-wei asked for a change*). A comment is shown and never acted on;
*new pr-fix ticket from this comment* opens one only when a person presses it.
(CI's checks are read in 0.16 itself — 0130 §5.)

## A blocker landed on the branch that no longer blocks

In 0.16 a ticket blocked by one that has landed on `branch.personal` waits
until that one is closed, when its PR merges. A stacked rule — *a blocker in review
on the same personal branch does not block, since its code is already on the
branch the next ticket is cut from* — needs to know *which* blockers are open:
the GitHub listing carries only a count (`packages/conductor/src/discover.ts:57`,
`:263`), so it costs a request per blocked ticket, and the log answers which of
them are in review.

## CI beyond GitHub Actions, and after it

0.16 runs a PR's CI on GitHub Actions only (ADR 0130 §5): the PR is opened as a
draft, the project's own `pull_request` workflows run, and green asks for review.
Later, on the same step of the PR's life:

- **Jenkins**: trigger the project's job with the PR branch, poll its result,
  keep its credentials in `~/.lingtai/config.yml` as every other key.
- **An agent fixing a red CI run**, as the conflict agent fixes a sync — rounds,
  build and review — before the PR waits on the person.
- **Verify**: a step after CI that checks the code against what its tickets
  wanted (0.17's verifiable landing).

## Stacked PRs, and keeping the personal branch current

Cut from 0.16 on 2026-11-20 to keep team mode simple (ADR 0130 §5–6):

- **Stacked PRs** — a second PR based on the first, offered for review before
  the first merges. Work does not stop without them (tickets keep landing on
  the personal branch); what they add is earlier review, at the cost of three
  problems to solve first: a PR closed under another carries its refused
  tickets up, a squash merge below leaves duplicate commits above, and every
  `lingtai:pr-fix` below ripples up and re-runs CI above.
- **Bringing `main` into `branch.personal` whenever it moves** — before each
  claim and on the sweep — so tickets are always written on today's code. 0.16
  syncs only at submit and at a fix; doing it always needs a lock that pauses
  claiming while a conflict waits for a person.
