# 0.18.0: tickets made on the board

Everything written while planning 0.18.0, in one place. The milestone on GitHub
is `0.18.0`. Nothing here is decided or ticketed yet.

## The goal

A person discusses a requirement on the board, over several turns, and the
board turns the conclusion into tickets. The tickets follow what this
repository has learnt about writing them: one pass each, every claim about the
code with a `file:line`, the four-row table, Edges and Out of scope, a *Done
when* a test can check, the chain in *blocked by*.

## What already exists

- **A discussion on a ticket** ([0033](../../decisions-archive/0033-the-third-kind-of-agent.md)):
  the task page's discussion box, an assistant with no tools that reads the code
  from the mirror, and two outputs, *Use for the next run* and *Add to the
  ticket* (`apps/board/src/app/discussion.tsx`, `apps/cli/src/discuss.ts`).
  It discusses a ticket that exists; 0.18.0 starts before there is one.
- **How a ticket is written here**: CLAUDE.md's *Opening an issue* and the
  `write-ticket` procedure (verify, draft, review cold, ask the operator, open).
- **Small tickets are worth more than a better model**: the same evening cost
  $0.92 against $17.24 on ticket size alone.

## To discuss before cutting

- **Where it lives.** A project-level page, not the task page; one discussion
  becoming several tickets.
- **What the assistant may read and do.** 0033's containment (no tools, reads
  the mirror) holds for the talk; verifying a `file:line` needs the code at a
  known commit.
- **The five questions.** `write-ticket` asks the person the decisions that
  change the most; on the board that is the conversation's last turns.
- **Where tickets go.** GitHub issues, or local tickets (#1226, #1227) for a
  project without GitHub; kind label, `agent:hold` by default, *blocked by*.
- **The acceptance from 0.17.0.** A ticket written here can carry what its
  acceptance will check.
