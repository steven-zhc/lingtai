# How Lingtai thinks about a ticket

The tutorial has you open one ticket and watch it land. This page is the short
model behind that: what Lingtai keeps track of, and why a ticket can run, wait,
carry on, or start again. It uses the tutorial's Chapter Garden project, and it
needs no knowledge of events or internals.

## One ticket, start to finish

You open a story ticket in Chapter Garden. Lingtai takes it from the queue and
runs a **pass**: ten steps, always in the same order. An agent writes the
change, the recipe's checks run, a cold reviewer reads it, and then the pass
stops where the recipe says a person decides.

![One Chapter Garden ticket goes through the ten steps. A red build or a refusing review returns to implement in the same worktree. A person at the proposed wait either continues the saved work or starts over from base.](img/concepts.svg)

[Open the diagram at full size](img/concepts.svg).

The ten steps are `claim`, `admit`, `prepared`, `design`, `implement`, `build`,
`review`, `proposed`, `merge` and `end`. [The pass](the-pass.html) says what
each one does and what you can put there.

## Two ways to go back

A ticket can go round again in two different ways, and the difference is the
most useful thing on this page: **does the next try continue the saved branch,
or cut a new one from the base branch?**

|                | Continues the saved branch                                                                                                                                      | Starts over from the base branch                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Lingtai**    | A **fix round**: when `build` goes red or `review` refuses, the agent works again in the same worktree, shown what refused it. The recipe's `rounds` limit caps it. | A **restart**: the ticket is released and claimed again as a new pass. The recipe's `restarts` limit caps it.                                          |
| **You**        | At the wait you choose **Approve and continue** or **Continue fixing current work**. The saved branch carries on.                                               | At the wait you choose **Start over from base** or **Add to the ticket and start over**. This is a **requeue**, and a new pass begins from the base.   |

Some details that are easy to get wrong:

- A fix round is **not** a new pass. It stays inside the pass you are in.
- When you continue the saved work, Lingtai does start a pass again at `admit`
  and `prepared`, then jumps to the step you resumed at. It is a pass resumed
  on the saved branch, not a fresh one from base, and not the same run carrying
  on.
- A requeue spends no restart. The board says it plainly: _This neither spends
  nor refunds an automatic restart._
- A requeued pass is told about earlier attempts and can reuse their commits,
  but it is new development. It goes through `build` and `review` again.

## What you can do at a wait

When the recipe has a person decide at `proposed`, or when a check refuses and
the pass cannot go on by itself, the ticket **waits**. The board shows what it
is waiting for and offers the moves that make sense:

- **Approve and continue** — carry on from the saved commit. Any refusal at
  this wait is waived.
- **Continue fixing current work** — one more paid fix round on the saved
  branch. `build` and `review` run again, and neither refusal is waived.
- **Answer the question** — give the agent the answer it asked for.
- **Start over from base** — a new pass from the base branch; the saved branch
  is not continued.
- **Add to the ticket and start over** — append your text to the ticket, then
  start a new pass from the base with it.
- **Close the ticket** — end it with no further pass. A reason is required.

## How a ticket ends

- **Landed.** The change merged into the base branch, and the ticket is done.
- **Closed.** A person ended it at a wait.
- **Still waiting.** Nothing is lost while it waits. A ticket can stay at a wait
  for as long as you like; the daemon takes other work meanwhile.

## The words

| Word                              | What it means, in Chapter Garden                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Project, repository, base**     | Chapter Garden is the project. Its repository is where the code lives, and the base branch (`main`) is where finished work lands.    |
| **Ticket and kind label**         | The story you opened in Step 2. Its kind label, such as `feature`, is what puts it in the queue.                                      |
| **Recipe**                        | A local file saying what a pass does for this project: which agent writes, what checks run, and who decides.                          |
| **Pass**                          | One walk of a ticket through the ten steps. A ticket can have several passes.                                                         |
| **Attempt and agent run**         | An attempt is one try at a ticket. An agent run is one session of the agent inside it. A fix round is another run in the same pass.  |
| **Worktree**                      | A disposable checkout of the base branch where the agent works. It is thrown away at the end; the branch it saved is what remains.    |
| **Checks and review**             | The `npm test` the recipe runs at `build`, and a second agent that reads the change cold at `review`. Either can refuse.              |
| **Wait**                          | The ticket stopped at a person, usually at `proposed`, with a plain sentence saying why.                                              |
| **Landing**                       | The merge into the base branch, at `merge`, after nothing is holding it.                                                              |
| **Event log and board**           | Lingtai records everything that happens as a log. The board is that log, drawn: the place to read what a ticket is doing.             |

## Going further

- [The pass](the-pass.html) walks all ten steps and says where a ticket goes
  when one will not let it past.
- [The architecture](architecture.html) shows which process is doing what, and
  where each piece of state lives.
- [The glossary](glossary.md) maps these words to the code, for readers of the
  repository.
- [The recipe guide](recipe.md) shows how to change what a pass does.
