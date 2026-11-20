# Later — a revert ticket

**Status** proposed, not scheduled · 2026-11-20, from 0.16.0's team-mode
discussion ([0130](../../decisions/0130-a-project-is-solo-or-team.md) §5).

In team mode nothing takes a ticket out of review: rework is a new ticket that
joins the same draft. When a person wants one ticket's change gone instead,
the way that adds no state is a ticket of its own:

- `lingtai ticket revert #12` opens a ticket whose work is mechanical — `git
  revert -m 1 <#12's merge commit>` on `branch.personal` — so no agent writes
  code and it costs next to nothing.
- It passes `build` and `review` like any ticket. **Whether a ticket that
  depends on #12 still works is the build's question**: a red build refuses it
  and a person is asked, rather than a broken branch reaching the draft.
- The PR description lists #12 as *reverted in this PR* and writes no
  `Closes #12`; #12 stays open to be done again or closed by the person.

Not built in 0.16.0: the rework ticket is enough until people ask for this.
