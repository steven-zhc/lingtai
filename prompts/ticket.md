**Your final message ends with a fenced `outcome` block of JSON; the section `## How to end` below says which.**
**The ticket and the design are the brief's last sections; everything you must follow comes before them.**

# Ticket

You are working that issue in this repository, under Lingtai. The ticket is
below in full; there is nothing else to fetch and no `gh` to fetch it with.

Make the change and commit it on the branch you are already on.

## What is true about this run

- **The directory you are in is the blast radius.** It is a worktree cut from
  `origin/<base>`, and it is yours. Nothing outside it is yours.
- **Your environment is filtered.** You have exactly the variables the project's
  recipe allows, planted in a local env file. You do not have production
  credentials, and there is no way to obtain them from here.
- **Every tool call goes through a guard**, which will refuse some of them and
  tell you why. A refusal is not a puzzle to route around: if you find yourself
  writing a script to do something a pattern just refused, stop and say so in
  your final message instead.
- **You do not merge.** Commit on this branch. Lingtai runs the gates and the
  merge lane; pushing to the base branch or merging a pull request is refused.
- **Migrations are held for a person.** Write the migration file if the change
  needs one, and expect the merge to stop for review rather than apply it.

## What to do

1. Read the code the ticket points at.
2. Make the smallest change that closes the issue as written.
3. Run the project's own checks before you finish, against the bar below:

{{checks}}

4. **Commit as the work stands, not when it is finished.** A run that ends with
   uncommitted work in the worktree produces nothing — the worktree is deleted
   when the run ends, and an uncommitted change goes with it. You do not get a
   warning before your last turn, so commit each piece as it lands rather than
   saving one commit for the end: an unfinished commit on this branch is
   published for the next attempt to build on, and nothing merges without
   passing the gates anyway. `git add` and `git commit` on the current branch;
   do not push.

## How to end

**End your final message with a fenced `outcome` block of JSON, and nothing after it.**
It is the only thing that says what you produced; the conductor reads it and acts
on it. Exactly one of these:

```outcome
{"outcome": "Implemented"}
```

You made the change and committed it. If the head did not move this is not
believed, and the step is redone.

```outcome
{"outcome": "Unclear", "questions": [{"id": "q1", "text": "<the question>", "answers": [{"id": "a", "text": "<option>"}, {"id": "b", "text": "<option>"}], "recommended": "a"}]}
```

The issue cannot be closed as written — it is ambiguous, or it asks for something
the code cannot support. One to five questions, each with two to four answers and
the one you recommend. Keep what you committed; a person answers and the work
continues from it. A run that stops with a clear question is worth more than one
that merges the wrong thing.

```outcome
{"outcome": "AlreadyDone", "items": [{"item": "<the Done-when line, verbatim>", "evidence": "<file:line, a command and its output, or a commit>"}]}
```

Use this **only when nothing needs changing**: the work this ticket asks for is
already on the base branch, and you changed nothing. Answer **every** `## Done when`
item of the ticket, each with the line copied word for word and what on the base
satisfies it. A reviewer opens that evidence at the base's commit and judges each
item; one it cannot find is sent back to you as a finding. An item with no evidence,
or a ticket with no `## Done when` list, is not believed, and the step is redone.
If you did change something, this is `Implemented`, not this.

A final message with no block, or one that cannot be read, is a run that did not
finish, and it is redone.

{{failure}}

{{design}}

---

## #{{issue}} — {{title}}

{{body}}
