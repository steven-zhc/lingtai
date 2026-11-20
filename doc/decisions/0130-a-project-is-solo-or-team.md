# 0130 — A project is solo or team: a team takes the person's own tickets, puts them in review on their personal branch, and lands them on `main` only through a PR the person submits

**Status** proposed · 2026-11-20 · not yet built (0.16.0)

A project's recipe says `mode: solo` or `mode: team`. **Solo** is how Lingtai
has always run: every ticket with a kind label and no hold is taken, and the
work lands on `branch.main`. **Team** takes only the tickets assigned to the
person, merges each into the person's own branch, `branch.personal`, where it
is **in review**, keeps that branch current with `branch.main`, collects what is
in review into a PR draft, and opens a PR to `branch.main` only when the person
submits it. **Landed means on `branch.main` in both modes**: in team mode a
ticket lands when the PR does. In team mode Lingtai never pushes `branch.main`.

## Context

Lingtai's defaults were written for one person on a repository that is theirs.
On a shared tracker those defaults make one person's tool a duty for everyone
else: a teammate's bug is taken, paid for and merged before they hear of it,
and the only way to stop it is a hold label *they* must remember. A team needs
the failure that costs nothing — a ticket not taken — and a review it already
knows, a colleague's PR.

Two facts made the shape cheap. `queue.assignee` already filters by assignee
(`assigneeSkip`, `packages/conductor/src/discover.ts:284`), and a local project
already lands on a branch of its own, `lingtai-base`, never the person's
checked-out branch ([0104](0104-the-recipe-is-the-pipeline.md) §15). Team mode
names both and adds what lies between that branch and `main`.

## Decision

1. **`mode` is a recipe key, `solo` or `team`, and it sets defaults.** It decides
   `queue.assignee.take`, where the merge lane merges, and what that merge
   means. A value written explicitly is kept, except where §6 refuses it.
   `lingtai add` asks for the mode and defaults to `team`; `add --local` writes
   `team` as well. **A recipe that names no mode is `solo`**, so a project made
   before this decision keeps doing what it did; only `add` writes `team`.

   | | `solo` | `team` |
   |---|---|---|
   | `take` | `all` | `mine` |
   | The cut and the landing | `branch.main` | `branch.personal` |
   | The merge lane ends in | `landed` | `in-review` — not terminal (§5) |
   | Reaching `branch.main` | the landing itself | a PR the person submits (§6) |
   | The ticket, until then | — | open, labelled `lingtai:in-review` |

2. **`branch` names the branches, and it replaces `base`.** `branch.main` is the
   trunk; `branch.personal` is the person's branch, required in team mode and
   refused in solo. `branch.personal` equal to `branch.main` is refused by name.
   `admit`'s `worktree:` and the merge lane read the landing branch from
   `branchOf` — `branch.personal` in team, `branch.main` in solo — the one value
   that flows where `base` flowed (0104 §5). `base` and `repo.base` are no longer
   accepted. For `add --local`, `branch.personal` defaults to `lingtai-base`,
   made from the branch checked out when it does not exist (0104 §15).

3. **Team takes the person's tickets.** `take` is `all`, `mine` or `unassigned`
   (`both` is renamed `all`). Team mode takes `mine`. *Mine* is the source's
   answer: on GitHub, an issue whose assignees include `queue.assignee.login`;
   on the local store, **every ticket** — local tickets are one person's — so
   team mode works there whole and is the way to try it with nothing shared.
   `take: unassigned` on the local store matches nothing and is refused by name.
   The board's Queued column shows what this machine would take, by the same
   rule.

4. **The personal branch is kept current, and a conflict stops for a person.**
   Before each claim, when `origin/<branch.main>` is not already an ancestor of
   `branch.personal` (`git merge-base --is-ancestor`), the conductor merges it
   into `branch.personal` and pushes; when it is, nothing is merged and no commit
   is made. The prepare of §6 checks it once more.

   **A conflict is resolved by an agent, as an attempt's is.** It is
   [0108](0108-a-refusal-buys-a-round.md) §8's `resolveConflict`, run on a
   worktree of `branch.personal` merging `origin/<branch.main>`, bounded by
   `attempt.conflictResolutions`, and handed what each side meant: the tickets
   in review whose code conflicts, and the commits on `branch.main` that brought
   the other side. The resolution then passes `build`, and `review` reads the
   resolution's own diff, before `branch.personal` is pushed; it reaches the PR,
   where the team sees it too. Only when the bound is spent or a check refuses
   does it become a wait for a person — *the personal branch conflicts with
   `main`; claiming is paused* — and nothing is claimed for the project until it
   is resolved. `lingtai add` creates `branch.personal` from `origin/<branch.main>`
   and pushes it, after asking, when it does not exist.

   **One personal branch is one machine's.** The conductor lock is a file on
   one machine ([0102](0102-one-conductor-holds-the-lock.md)), and a conductor
   that takes it releases every claim another worker recorded (0109 §5): two
   machines on one log would release each other's claims, and two on one
   personal branch would push over each other. `branch.personal` defaults to a
   name carrying the person and the machine; a person with two machines has two
   personal branches, and submits each draft from its own.

   **The default name is made safe, and every name is checked.** The default is
   `<login>/<machine>`, the machine part made from the host name: `.local`
   dropped, lower-cased, every character outside `a-z`, `0-9` and `-` replaced
   by `-`, runs of `-` collapsed, trimmed of `-` at either end, cut to 24
   characters, and `machine` if nothing is left — `Steven's MacBook Pro.local`
   becomes `steven/steven-s-macbook-pro`. `lingtai add` shows it and the person
   may change it. Whatever its source, `branch.personal` is refused by name when
   the recipe resolves if `git check-ref-format --branch` refuses it, or if it
   equals `branch.main` ignoring case — a case-insensitive filesystem holds the
   two as one ref.

5. **In review is a state, not an ending.** This is how a team already runs a
   ticket: open while its PR waits, *done* only when the code is on the trunk,
   and back to work if the review sends it back. In team mode the merge lane's
   merge into `branch.personal` appends `TicketInReview { mergeCommit, branch }`
   and the attempt ends with the outcome `in-review`, on which `end` runs (its
   default: `labels: [lingtai:in-review]`). The ticket is not terminal:
   - **the queue passes it over** as `in-review`, by its state on the log and
     not by the label, so a label a person removes changes nothing;
   - **it lands when its merge commit is reachable from `origin/<branch.main>`**:
     the sync of §4 appends `TicketLanded` for each such ticket, and `end` runs on
     `landed` — a GitHub ticket is closed by the PR's `Closes #…`, a local ticket
     by `end`'s `close`. `landed` keeps 0109 §11's meaning: terminal, and on the
     trunk;
   - **a ticket blocked only by tickets in review on the same personal branch is
     not blocked**: their code is already on the branch it is cut from, and they
     reach `main` in the same PR, as a stacked PR does;
   - **nothing takes a ticket out of review.** What is in review goes into the
     PR whole. Work the person wants changed is a new ticket, taken, merged into
     `branch.personal` and put in review like any other, so it joins the same
     draft. Taking one out would mean reverting it, finding what depends on it
     and reverting that too — more than anyone has asked for.

6. **What is in review becomes one PR, at the person's word.** A project has
   one PR at a time, and it moves through four states, each recorded on the
   project's log:

   | State | What is true | How it moves on |
   |---|---|---|
   | **draft** | every ticket in review on `branch.personal` that no open PR holds; it grows as tickets are put in review | the person *prepares* it |
   | **preparing** | the `pr:` agent has written a summary; title and description are the person's to edit; the checks below have run | the person *submits* it, or goes back to the draft |
   | **submitted** | `branch.personal` at one commit is pushed as `lingtai/pr/<n>` and the PR is open on the code host; review comments are shown | merged, closed, or *updated* |
   | **merged** | its tickets land (§5) | a new draft begins |

   - **Only the person moves it**: a button on the board's PR page or `lingtai
     pr prepare` / `submit` / `update`. Lingtai never submits on its own.
   - **Before a PR opens, it is checked**: `branch.personal` is current with
     `origin/<branch.main>` (§4) and the frozen commit passes `build`; either
     failing opens nothing and says why.
   - **One open PR.** While one is submitted, tickets go on being put in review
     and gather in the next draft, but nothing new is submitted until the open
     PR is merged or closed — a second PR from the same branch would carry the
     first one's commits.
   - **Review changes are rework tickets, then *update*.** The team's comments
     on the code host are shown on the PR page. A change they ask for is a new
     ticket, put in review on `branch.personal` like any other; *update* pushes
     `branch.personal`'s head to `lingtai/pr/<n>` — always a fast-forward — and
     regenerates the description. Every ticket put in review since the submit
     goes in with it, and the page lists them before the person confirms.
   - **Closed without merging**: its tickets stay in review and return to the
     draft; nothing is reverted.
   - **The description** is generated from the log — the tickets, `Closes #…`
     for a GitHub ticket, each merge commit and its spend; the sync merges of §4
     are never listed and add nothing to the diff — under the summary, which the
     person may edit before submitting and before each update.
   - **No ticket is taken out** of a draft or a PR (§5).
   - **The code host**: GitHub in 0.16, read and written through the GitHub App
     (`pull_requests: write`). On any other remote the frozen branch is pushed
     and the description printed for the person to open by hand.
   - **Lingtai never merges the PR.**
   - **Solo mode has no PR**: `lingtai pr` refuses, saying the project lands on
     `branch.main` itself.
   - **One page**: the board's PR page shows whichever state the PR is in.

   **A PR has two ids.** Lingtai numbers a project's PRs from 1 when one is
   *prepared* — the id on the log, and the frozen branch's name,
   `lingtai/pr/<n>`, which must be pushed before the code host can open a PR
   from it. The code host's number (GitHub's `#88`) exists only once it is
   submitted, and is recorded beside it then. The page shows no number before
   submitting, and the code host's after it; `lingtai/pr/<n>` is secondary.
   *One open PR* is one per personal branch: a team has many open at once, one
   per person and machine, and each Lingtai follows only its own.

   **How Lingtai learns what the team did**, in three layers, none of them a
   webhook:
   - **merged** is read from git: the sync of §4 already fetches
     `origin/<branch.main>`, and a PR whose head is reachable from it has
     landed (§5). No API call, and a missed notification cannot leave tickets
     *in review*;
   - **review state, comments, and closed without merging** are read in the
     daemon's existing sweep (`SWEEP_MS`, five minutes,
     `packages/daemon/src/work-loop.ts:167`): one request for the one open PR,
     stopped early when the PR has not changed since the last read;
   - **the PR page asks the code host when it renders**, as the Queued column
     does, so a person looking sees it current.

   A webhook (`pull_request`, `pull_request_review`, `issue_comment`) is an
   optional speed-up where the App has a public address; adding events to the
   App asks every installation to approve the change, so nothing above may
   depend on it. A comment is shown, never acted on: a person turns it into a
   rework ticket.

   **`pr:` is the summary agent's block**, beside `discuss:` and for the same
   reason — it spends outside any attempt: `{ agent, model, prompt, limits }`,
   the agent defaulting to `runtime.agent`, `limits` to 20 turns and `5m`, and
   carrying no `usd` (0104 §6). One run when a PR is prepared, and one when it is
   updated.

7. **In team mode nothing Lingtai does pushes `branch.main`.** The merge lane,
   the sync, `lingtai pr` and every other path push `branch.personal` or
   `lingtai/pr/<n>` and nothing else, and a test holds that. A team recipe
   whose merge lane targets `branch.main`, or that writes `take: all`, would undo
   §1 and is refused by name when it resolves.

## Consequences

- A new user's first project is a team project on local tickets: nothing on a
  shared tracker, nothing on `main`, and the whole team flow to read. The first
  tutorial's `lingtai-base` is the personal branch by its default name.
- The team reviews one PR a person chose to submit, holding several tickets, not
  one PR per ticket. Merged with a merge commit, one ticket the team refuses is
  one `git revert`; a squash merge loses that, and the documentation says so.
- Team mode on a tracker other than GitHub or the local store waits for that
  source (`doc/milestone/later/ticket-sources.md`).
- `lingtai:in-review` is a label Lingtai writes, under 0116 §5's prefix. The
  board keeps its four columns: in team mode the *Landed* column is split, its
  landed tickets above, compact and folded, and the tickets *in review* below.
- `TicketInReview` and the `in-review` outcome are new;
  every reducer of the ticket reads them (0101 §4), and 0109 §11's terminal
  outcomes are unchanged.
- This repository runs solo: it is Lingtai's own repository and merges its own
  work unattended (CLAUDE.md, *Running Lingtai on Lingtai*).
