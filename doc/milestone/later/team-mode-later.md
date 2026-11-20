# Later — team mode, after 0.16

**Status** proposed, not scheduled · 2026-11-20, moved out of 0.16.0 by the
operator after the cold review of [0130](../../decisions/0130-a-project-is-solo-or-team.md).

## Review state and comments on the PR page

0.16 reads only whether the open PR was merged or closed, and links to the
review on the code host. Showing the review's state (approved, changes asked)
and its comments means reading them in the sweep — one request for the one open
PR, stopped early when it has not changed — and drawing them on the PR page, the
home page's in-review box and the task page (the mocks already do). A comment is
shown and never acted on; *new ticket from this comment* opens a rework ticket
only when a person presses it. CI checks would need the App's `checks` or
`statuses` permission, which every installation must approve; leave them out
unless asked.

## A blocker in review that no longer blocks

In 0.16 a ticket blocked by one in review waits until that one lands, as a
team's ticket waits for its blocker's PR. A stacked rule — *a blocker in review
on the same personal branch does not block, since its code is already on the
branch the next ticket is cut from* — needs to know *which* blockers are open:
the GitHub listing carries only a count (`packages/conductor/src/discover.ts:57`,
`:263`), so it costs a request per blocked ticket, and the log answers which of
them are in review.
