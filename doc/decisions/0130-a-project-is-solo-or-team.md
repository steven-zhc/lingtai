# 0130 — A project is solo or team: a team takes the person's own tickets, lands on their personal branch, and reaches `main` only through a PR the person submits

**Status** proposed · 2026-11-20 · not yet built (0.16.0)

A project's recipe says `mode: solo` or `mode: team`. **Solo** is how Lingtai
has always run: every ticket with a kind label and no hold is taken, and the
work lands on `branch.main`. **Team** takes only the tickets assigned to the
person, lands each on the person's own branch, `branch.personal`, keeps that
branch current with `branch.main`, collects what landed into a PR draft, and
opens a PR to `branch.main` only when the person submits it. In team mode
Lingtai never pushes `branch.main`.

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
   `queue.assignee.take`, where the merge lane lands, and what `end` does on
   `landed`. A value written explicitly is kept, except where §6 refuses it.
   `lingtai add` asks for the mode and defaults to `team`; `add --local` writes
   `team` as well. **A recipe that names no mode is `solo`**, so a project made
   before this decision keeps doing what it did; only `add` writes `team`.

   | | `solo` | `team` |
   |---|---|---|
   | `take` | `all` | `mine` |
   | The cut and the landing | `branch.main` | `branch.personal` |
   | `end` on `landed` | `close: true` | `labels: [lingtai:landed]`, the ticket left open |
   | Reaching `branch.main` | the landing itself | a PR the person submits (§5) |

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
   is made. A conflict appends a wait for a person, is
   never given to an agent, and nothing is claimed for the project until it is
   resolved. `lingtai add` creates `branch.personal` from `origin/<branch.main>`
   and pushes it, after asking, when it does not exist.

   **One personal branch is one machine's.** The conductor lock is a file on
   one machine ([0102](0102-one-conductor-holds-the-lock.md)), and a conductor
   that takes it releases every claim another worker recorded (0109 §5): two
   machines on one log would release each other's claims, and two on one
   personal branch would push over each other. `branch.personal` defaults to a
   name carrying the person and the machine; a person with two machines has two
   personal branches, and submits each draft from its own.

5. **What landed is a PR draft, and the person submits it.** Each ticket landed
   on `branch.personal` joins the project's open draft — its ticket, merge
   commit and spend — on the log, never on the tracker. `lingtai pr` shows it;
   `lingtai pr submit`, or the board's draft page, submits it:
   - the personal branch at that commit is pushed as `lingtai/pr/<n>`, and the
     PR opens from it to `branch.main`, so a ticket landed during review joins
     the next draft and never the PR under review;
   - the description is generated from the log — the tickets, `Closes #…` for a
     GitHub ticket, each merge commit and its spend; the sync merges of §4 are
     never listed, and add nothing to the PR's diff — and opens with a summary an
     agent writes, which the person may edit first (one paid run per PR);
   - taking a ticket out of the draft reverts its merge commit on
     `branch.personal` and reopens the ticket;
   - the PR opens on the code host: GitHub in 0.16; on any other remote the
     frozen branch is pushed and the description printed for the person;
   - Lingtai never merges the PR;
   - a project has one open draft;
   - in solo mode there is no draft, and `lingtai pr` refuses, saying the project
     lands on `branch.main` itself.

   A ticket labelled `lingtai:landed` is closed by its tracker when the PR
   reaches `branch.main` (`Closes #…` on GitHub). A local ticket, which has no
   such word, is closed by the sync of §4 once its merge commit is reachable from
   `origin/<branch.main>`.

6. **In team mode nothing Lingtai does pushes `branch.main`.** The merge lane,
   the sync, `lingtai pr` and every other path push `branch.personal` or
   `lingtai/pr/<n>` and nothing else, and a test holds that. A team recipe
   whose merge lane, `close` at `landed`, or `take: all` would undo §1 is
   refused by name when it resolves.

## Consequences

- A new user's first project is a team project on local tickets: nothing on a
  shared tracker, nothing on `main`, and the whole team flow to read. The first
  tutorial's `lingtai-base` is the personal branch by its default name.
- The team reviews one PR a person chose to submit, holding several tickets, not
  one PR per ticket. Merged with a merge commit, one ticket the team refuses is
  one `git revert`; a squash merge loses that, and the documentation says so.
- Team mode on a tracker other than GitHub or the local store waits for that
  source (`doc/milestone/later/ticket-sources.md`).
- `lingtai:landed` is a fourth label Lingtai writes, under 0116 §5's prefix.
- This repository runs solo: it is Lingtai's own repository and merges its own
  work unattended (CLAUDE.md, *Running Lingtai on Lingtai*).
