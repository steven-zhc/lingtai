# The task detail page

**Status** the design the #388 tickets implement · follows
[0118](../decisions/0118-a-hold-explains-itself.md)

The page for one work item. Its order and its moves for an item in the Waiting
lane are [0118](../decisions/0118-a-hold-explains-itself.md)'s, and the mockups
are [`doc/decisions/0118/`](../decisions/0118/index.html); where this document
and 0118 differ, 0118 is the decision. What is here is the rest: the rules the
page keeps whatever lane its item is in, which 0118 does not restate.

## The order

**The ticket · where it is · triage · the moves · the record** (0118 §2).

- **The ticket** — the Problem, Want and Watch out rows of the body, and a link
  to the whole of it.
- **Where it is** — the ten-step rail ([the-card.md](the-card.md)) and one line
  under it: what refused, the rounds spent, the restarts left. Composed from the
  log on every render, never generated.
- **Triage** — `HoldTriaged`'s cause, questions and recommended move, shown only
  while the block it names is the current one (0118 §3, §9). Where the recipe
  declares no `triage:`, this band is absent and the holder's own words stand in
  its place. Discussion sits under it.
- **The moves** — by kind of hold (0118 §1, §6). Unpushed work goes above
  everything else on the page.
- **The record** — History, Diff, Findings, Attempts and Ticket, as tabs.

An item that is not held has no triage and no moves: the ticket, where it is,
and the record. A running attempt is the exception to *the record is closed*:
it opens on load and its run log opens with it, following. Only the running
one — a page with six attempts would otherwise follow six files nobody asked to
see (#110).

## 1. The skeleton is the attempt

The log keeps one stream per run, and the page does not flatten what the log
divided. `TaskDetail.runs` is the attempts, oldest first, each carrying its own
money, prompt, files and verdicts; History is whole and in order, grouped by run
(`apps/board/src/lib/task.ts`). A gate runs once per attempt, so its verdict is
under the attempt that ran it, and money totals because there is something to
total on: `RunFinished` carries `costUsd`, `turns` and `durationMs` on every run.

## 2. Evidence is quoted, and kept in one place

What refused is said in the refuser's own words — `pnpm typecheck && pnpm test
exited 1 after 117.0s`, never *the build gate refused it*. A gate's name is not
a reason: on #121 *the review gate refused it* described a reviewer that never
started. A summary may sit under the quote; it may not stand in for it.

Since 0118 the holder's text — the judge's `why`, git's words, a step's raw
output — is evidence in the record, not the message at the top. Everything else
an attempt holds (its findings, its diff, its other verdicts) is reached through
that attempt and never copied beside it, because two copies of one fact come to
disagree.

## 3. Discussion is a third kind of agent

Not a run agent, not a gate agent; scoped to one work item, and opened with
triage's analysis as its context where there is one (0118 §3).

- **It reads the log, the ticket, and files from the mirror** at the base's and
  each attempt's head. **No command execution**: commands would make it a run,
  and runs have worktrees, hooks and gates for reasons. It says what it cannot
  do — *attempt 2 left no branch; I am reading main* — rather than guessing.
- **Hosted by the daemon**, requested over `ctl-conductor`, off the pass and
  without the lock ([0013](../decisions-archive/0013-daemon-hosts-the-work.md)).
- **The answer arrives as it is written**, over the run-log route
  ([0034](../decisions-archive/0034-the-run-log.md)): a trace named for its
  `chatId`, deleted when `DiscussionAnswered` lands. One file, one turn.
- **No spend limit; a meter.** A discussion is attended and the person is the
  loop, so the running cost is on screen and the total is in the ledger.
- Its conclusion is one of the two carriers the page already has: an edit to the
  next prompt, or a section added to the ticket's body (0118 §6). It introduces
  no third.

## 4. The prompt edit applies to the next run only

`PromptEdited` is on the work item's stream, and the version names the edit
(`ticket@1924+failure@1c5708ba+human@a91f2e`, hashing the final text). It
applies to the next run, whoever starts it. Anything meant to last belongs in
the ticket's body, which is what 0118's *write it into the body & requeue* does.

## 5. What an action ran, from the recipe this run got

Under each attempt's rail, each action opens on its command and its bound, with
the whole recipe one click further — asked while looking at the action, so not a
row of its own.

The recipe is `~/.lingtai/<project>/recipe.yml` and has no history to read a
past one from. So the page shows the file only when it hashes to the run's
`StepsResolved.configHash`, and otherwise says *this run got a different recipe
from the one you have, and its text is not recoverable* — never the local file
as though it were the run's.

## 6. Markdown by source, never by sniffing

| content | render |
|---|---|
| ticket body | **rendered**, sanitised, no raw HTML, remote images blocked |
| the prompt | **raw**, with a rendered view one click away |
| gate output, `RunFailed.detail`, `RepairRequested.detail`, triage's quoted evidence | **never** — markdown eats `_`, `#` and `{}`; a log rendered as markdown is not that log |

A build log is not markdown, and a hand-rolled subset renderer is the wrong tool
for an untrusted issue body (`apps/board/src/lib/markdown.ts`).

## Not decided here

Everything 0118 lists as not decided — the three moves the board does not have,
triage's language, what `lingtai status` carries — and the per-kind table of
trigger, page, move and whether triage runs, which is
`doc/design/the-waiting-lane.md` (#388).
