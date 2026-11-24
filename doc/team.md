# Team mode

*Team mode — two more tickets, one PR, one merge into `main`*

Chapter 1 left one change on `lingtai-base` and its ticket open. This chapter
finishes the day on the same Chapter Garden project, in the same home: two more
tickets land, you submit them as one PR, and you merge it into `main`.

## Why team

Your tickets land on your own branch, `lingtai-base`, and `main` moves only
through a PR you chose to submit. Nobody has to watch each landing, and one bad
ticket is one `git revert` in the PR rather than a hole in `main`. A team
project is the default for every new project, even for one person, because the
review you would want from a colleague is the review of one PR, and the
history stays readable: one merge commit per PR.

## Two more tickets

Pick two other stories from the bookshelf, one for each ticket, so the two
changes touch different files. Run each once: another run is another ticket and
another paid attempt, a writer and a reviewer.

```sh
lingtai ticket new --title "Add the next chapter to <first story>" --label feature \
  --body "Find the latest chapter of this story and write one new chapter that continues it. Follow the story's existing language, chapter numbering, and Markdown layout. Keep earlier chapters unchanged."
lingtai ticket new --title "Add the next chapter to <second story>" --label feature \
  --body "Find the latest chapter of this story and write one new chapter that continues it. Follow the story's existing language, chapter numbering, and Markdown layout. Keep earlier chapters unchanged."
```

Keep `lingtai start` running and watch `lingtai board` until both cards are
**Landed**. If two tickets do change the same file, an agent resolves the
conflict; chapter 7 has the details.

## The draft

```sh
lingtai pr
```

```text
draft: 3 ticket(s) landed on lingtai-base
```

The draft is the project's next PR, not yet submitted. It holds the tickets
landed on `lingtai-base` since the last PR was frozen, here all three.

## Submit

```sh
lingtai pr submit
```

This needs a running conductor, so leave `lingtai start` up. It freezes
`lingtai-base` at one commit, pushes that commit to a branch of its own and
runs the build. It also buys one more paid agent run, which writes the PR's
title and summary. With nothing landed, or with a PR already open, it refuses
and says why. A refused submit returns the PR to the draft.

If `lingtai start` is not running, the submit is not served; start it and
submit again. Run `lingtai pr` again for the PR's number, its branch and its steps. The board
shows the same PR as one of five states: Draft, In progress, Waiting on you,
In review, Merged.

```text
PR <n>: in-review — lingtai-base-pr-<n>
```

`<n>` is the PR's number, which `lingtai pr` prints. Your checkout is the remote, so the branch is pushed into it and no pull request
is opened anywhere. The description `lingtai pr` prints under that line is there
to read, and you review the PR as a diff:

```sh
git -C chapter-garden diff main...lingtai-base-pr-<n>
```

## Merge it

Merge the PR's branch, not `lingtai-base`, which may already hold landings that
belong to the next draft. Do it on `main`, with a merge commit:

```sh
git -C chapter-garden switch main
git -C chapter-garden merge --no-ff lingtai-base-pr-<n>
```

There is no `git push`, because your checkout's `main` is the remote's `main`.
Stay on `main` afterwards: Lingtai then merges `main` back into `lingtai-base`,
and a push into a branch you have checked out is refused.

Never squash. Lingtai marks a PR Merged when the PR's last pushed commit is an
ancestor of `main`, and a squash commit does not contain it, so the PR would
stay In review for good. Keep `lingtai start` running for this step too: the
running conductor notices the merge.

```sh
lingtai pr
```

```text
PR <n>: merged by git at 2026-11-24T10:00:00.000Z
```

The PR is Merged and its three tickets close, the first one from chapter 1
included. Lingtai also prints a line saying `lingtai-base` has caught up with
`main`. Each new ticket from here is one more paid attempt, and each submit one
more paid summary, so the cost follows the tickets you open, not the days that
pass. `main` now holds everything the
PR held, `lingtai-base` has caught up with it, and the next ticket starts the
next draft.

## Next

Next: [Connect GitHub](connect-github.md) — the same day on a shared remote.
