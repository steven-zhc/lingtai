# Concepts

*How one attempt goes*

Lingtai works a ticket in an **attempt**: ten steps, always in the same order. This chapter follows one attempt in the tutorial's Chapter Garden project, from claim to the end.

## One ticket, start to finish

You open a story ticket in Chapter Garden. Lingtai takes it from the queue and
runs an **attempt**: ten steps, always in the same order. An agent writes the
change, the recipe's checks run, the AI review reads it, and then the attempt
stops where the recipe says a person decides.

![One Chapter Garden ticket goes through the ten steps. A red build or a refusing review returns to implement in the same worktree. A person at the proposed wait either continues the saved work or starts over from base.](img/concepts.svg)

[Open the diagram at full size](img/concepts.svg).

The ten steps and their order never change. What runs at each step is yours to name in the recipe, and a step you say nothing about is still drawn, as empty.

| Step        | What it is for                                         |
| ----------- | ------------------------------------------------------ |
| `claim`     | which tickets, and in what order                       |
| `admit`     | the requirement, and the worktree it is built in       |
| `prepared`  | getting the worktree ready before the agent starts     |
| `design`    | a document, or none; either is an answer               |
| `implement` | an agent, in that worktree                             |
| `build`     | what must pass before review                           |
| `review`    | reads it cold and hands in findings; it does not decide |
| `proposed`  | the only step that decides what is next                |
| `merge`     | the branch in, verify, push                            |
| `end`       | runs on every outcome                                  |

A card stops at `proposed`, the only step that decides. It stops there when the recipe names a person at it, or when a limit or a question needs one. When the agent asked questions with choices, the board offers *Answer and continue the step*; a question in prose has no answer button, only editing the ticket, starting a new attempt or closing. A question a person raised themselves is answered with **Answer the question**. [When it fails](when-it-fails.md) has what a refusal looks like and what to do at a wait.

## Two ways to go back

A ticket can go round again two ways, and the difference is what matters: **does the next try continue the saved branch, or cut a new one from the base branch?**

|                | Continues the saved branch                                                                                                                                      | Starts over from the base branch                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Lingtai**    | A **fix round**: when `build` goes red or `review` refuses, the agent works again in the same worktree, shown what refused it. The recipe's `runtime.limits.attempt.refusalFixes` caps it. | A **restart**: the ticket is released and claimed again as a new attempt. The recipe's `runtime.limits.ticket.newAttempts` caps it.                                          |
| **You**        | At the wait you choose **Approve and continue** or **Fix the refusal on the saved work**. The saved branch carries on.                                               | At the wait you choose **Start a new attempt from base** or **Add to the ticket and start a new attempt**.                                                                    |

- A fix round is **not** a new attempt. It stays inside the attempt you are in.
- Starting a new attempt from base spends no restart. The board says it plainly: _This neither spends nor refunds an automatic restart._

The home page marks each problem Lingtai got past on its own as **Handled for you**; [when it fails](when-it-fails.md) says how. What an attempt can cost is in [checks and spend](checks-and-spend.md).

## How a ticket ends

- **Landed.** The change merged into the branch the project lands on. In a **solo** project that is `main` and the ticket is closed; in a **team** project it is your own branch, and the ticket stays open until its PR merges ([team](team.md)).
- **Closed.** A person chose **Close the ticket** at a wait, and no further attempt runs.
- **Still waiting.** Nothing is lost while it waits. It can stay as long as you like, and the daemon takes other work meanwhile.

## Next

[The board](board.md) is where you watch an attempt and choose at a wait.
