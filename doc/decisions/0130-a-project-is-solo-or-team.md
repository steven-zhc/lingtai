# 0130 — A project is solo or team: a team's tickets land on the person's own branch, and that branch reaches `main` as a PR with a life of its own

**Status** proposed · 2026-11-20, revised the same day three times (a cold review; the PR given its own lifecycle and board; then made simpler: one PR at a time, the sync only when a PR is submitted or reworked); §5 and §6 moved to [0131](0131-a-pr-goes-from-draft-to-merged.md) on 2026-11-22 · not yet built (0.16.0)

A project's recipe says `mode: solo` or `mode: team`. **Solo** is how Lingtai
has always run: every ticket with a kind label and no hold is taken, and the
work lands on `branch.main`. **Team** takes only the tickets assigned to the
person and lands each on the person's own branch, `branch.personal` — **a
ticket's life is the same in both modes; only the branch it lands on differs.**
What happens between that branch and `main` is not a ticket's: it is a **PR**,
with a lifecycle and a board of its own — a draft of what has landed, Lingtai
bringing `main` in and building, a wait for a person when it cannot, the PR in
review on the code host, and merged. In team mode Lingtai never pushes
`branch.main`.

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
names both, and gives what lies between that branch and `main` its own
lifecycle rather than a state of every ticket: a ticket is one piece of work, a
PR is a person deciding a body of work is ready for the team.

## Decision

1. **`mode` is a recipe key, `solo` or `team`, and it decides four things.**
   **A recipe that names no mode is `solo`**, so a project made before this
   decision keeps doing what it did. `lingtai add` and `lingtai init` ask for
   the mode and default to `team`.

   | | `solo` | `team` |
   |---|---|---|
   | `take` | `all` (or as written) | `mine`, and only `mine` (§3) |
   | The cut and the landing | `branch.main` | `branch.personal` |
   | A ticket ends | `landed`, on `branch.main`, closed | `landed`, on `branch.personal`, left open on the tracker until its PR merges (§4) |
   | Reaching `branch.main` | the landing itself | a PR, on its own board (§5) |

   **The mode cannot change while it would strand work**: switching from team to
   solo is refused by name while any ticket has landed on `branch.personal` and
   not yet reached `main`, or a PR is open, since solo has no PR board for them.

2. **`branch` names the branches, and it replaces `base`.** `branch.main` is the
   trunk; `branch.personal` is the person's branch, required in team mode and
   refused in solo. `admit`'s `worktree:` and the merge lane read the landing
   branch from `branchOf` — `branch.personal` in team, `branch.main` in solo —
   the one value that flows where `base` flowed (0104 §5); the lane has no key
   of its own, so the mode alone decides where it lands.

   **`base` and `repo.base` are migrated once and then refused.** `lingtai
   doctor` names a recipe that still writes them, and `lingtai doctor --fix`
   rewrites it to `branch.main` as a new recipe change on the log; a recipe
   change already on the log is never rewritten (its `source` and `sourceHash`
   are the text a person wrote, `packages/domain/src/events.ts:2417`), so the
   resolver reads an old one's `base` as `branch.main` when it replays history
   and refuses `base` in any recipe written after. `ProjectConfigured.base` and
   `TicketLanded.base` keep their names: they are history, not recipe syntax.

   **Where the personal branch comes from.** It is made from
   `origin/<branch.main>`, after asking, by `lingtai add` or `init` when it does
   not exist; an existing one is used as it is, and the first submit's sync (§6)
   brings `main` into it. For a local team project (`add --local`, `init --local`)
   `branch.main` is the branch checked out when the project is added, and
   `branch.personal` defaults to `lingtai-base`; a local solo project lands on
   `lingtai-base` as before (0104 §15).

   **One personal branch is one machine's.** The conductor lock is a file on one
   machine ([0102](0102-one-conductor-holds-the-lock.md)), and a conductor that
   takes it releases every claim another worker recorded (0109 §5): two machines
   on one log would release each other's claims, and two on one personal branch
   would push over each other. Two people on one Postgres log is not supported,
   and the documentation says so. A person with two machines has two personal
   branches and submits each draft from its own.

   **The default name is made safe, and every name is checked.** The default is
   `<login>/<machine>` — the GitHub login, or the local user's name on a local
   project — the machine part made from the host name as the system reports it: `.local`
   dropped, lower-cased, every character outside `a-z`, `0-9` and `-` replaced
   by `-`, runs of `-` collapsed, trimmed of `-` at either end, cut to 24
   characters, and `machine` if nothing is left — `Steven's MacBook Pro.local`
   becomes `steven-zhc/steven-s-macbook-pro` for the login `steven-zhc`. `lingtai add` shows it and the person
   may change it. Whatever its source, `branch.personal` is refused by name when
   the recipe resolves if it breaks `git check-ref-format --branch`'s rules —
   checked by a pure copy of those rules, held to real git by a test, so resolve
   stays free of IO — or if it
   equals `branch.main` ignoring case — a case-insensitive filesystem holds the
   two as one ref.

3. **Team takes the person's tickets, and nothing else.** `take` is `all`,
   `mine` or `unassigned` (`both` is renamed `all`, migrated with `base` in §2).
   Team mode takes `mine`; `all` or `unassigned` in a team recipe is refused by
   name. *Mine* is the source's answer: on GitHub, an issue whose assignees
   include `source.assignee.login` (or `queue.assignee.login` at `claim`), which `lingtai add` asks for when Lingtai
   acts as a GitHub App and knows no person's login; on the local store, **every
   ticket** — local tickets are one person's — so team mode works there whole
   and is the way to try it with nothing shared. A solo machine passes over an
   issue labelled `lingtai:landed`: it is somebody's work waiting on a PR.
   The board's Queued column shows what this machine would take, by the same
   rule.

4. **A team's ticket lands on the personal branch, as any ticket lands.** The
   merge lane merges it into `branch.personal` and appends `TicketLanded { base:
   <branch.personal> }` and, in the same transaction, adds the ticket to the
   draft PR ([0131](0131-a-pr-goes-from-draft-to-merged.md) §1); `landed` is terminal as 0109 §11 says, so the queue never
   takes it again, and every reducer, column and page reads it as they read any
   landing. What differs is the tracker:
   - **The ticket stays open on its tracker** until its code reaches `main`: in
     team mode `end`'s `close` does not run on `landed`, and the ticket carries
     `lingtai:landed`, computed from its state as `lingtai:working` is
     (`labelsFor`, 0109 §5). A solo machine passes such an issue over (§3).
   - **It is closed when its PR merges** (§5): Lingtai closes every ticket the
     merged PR held, on every source, whether or not the PR's `Closes #…` already
     did (it does only when the PR targets the repository's default branch).
   - **A blocker stays a blocker until it is closed**: a ticket blocked by one
     that has landed on `branch.personal` waits until that one's PR merges, as a
     team's ticket waits for its blocker's PR.
   - **The board and the task page** show a team's landed ticket as landed *on
     your branch*, with the PR that holds it or *not in a PR yet*, and *merged*
     once its PR is.
   - **Closed by a person before its PR merges**: it stays closed; its code is on
     `branch.personal` and goes into the PR with the rest, listed without
     `Closes #…`.
   - **Satisfied** (0108 §21) keeps its meaning against the cut: a ticket whose
     want is already true on `branch.personal` ends satisfied.

5. **A PR has its own lifecycle, on its own board** — its states, the ten
   steps of *In progress*, CI, the `lingtai:pr-fix` ticket, the merge back into
   `branch.personal` and how Lingtai learns what the team did are
   [0131](0131-a-pr-goes-from-draft-to-merged.md).

6. **`main` is brought in when a PR is submitted or reworked, and once more
   into `branch.personal` after the PR merges** — the sync, its build and the
   agent that resolves a conflict are
   [0131](0131-a-pr-goes-from-draft-to-merged.md) §3, and the catch-up after
   the merge is 0131 §10, *Merged*. Nothing else brings it in.

7. **In team mode nothing Lingtai does pushes `branch.main`.** The merge lane,
   the sync, `lingtai pr` and every other path push `branch.personal` or a PR
   branch and nothing else, and a test holds that.

## Consequences

- A ticket's lifecycle, its reducers, the home page's four columns and the task
  page are the same in both modes; team mode adds a branch, a label and a page.
- A new user's first project is a team project on local tickets: nothing on a
  shared tracker, nothing on `main`, and the whole team flow to read. The first
  tutorial's `lingtai-base` is the personal branch by its default name.
- The team reviews one PR a person chose to submit, holding several tickets, not
  one PR per ticket. Merged with a merge commit — the lane's own merges are
  `--no-ff` (`packages/repo/src/integrate.ts:539`) — one ticket the team refuses
  is one `git revert`; a squash merge loses that, and the documentation says so.
- Team mode on a tracker other than GitHub or the local store waits for that
  source (`doc/milestone/later/ticket-sources.md`).
- `lingtai:landed` is a label Lingtai writes and `lingtai:pr-fix` one a person
  sets, both under 0116 §5's prefix.
- After a PR is recorded merged, the tip of `origin/<branch.main>` — not only
  the merge commit — is merged into `branch.personal` once, built, and pushed to
  that branch alone, with the merge back's rules (0131 §10, *Merged*).
- The PR's events, on its own stream `pr-{project}-{n}`, are 0131's. No ticket
  event is added — a `lingtai:pr-fix` ticket's claim records the PR branch it is
  cut from, as a field of the claim; `TicketLanded` gains no new position.
- This repository is a team project, since 2026-11-22: tickets assigned to
  `steven-zhc` land on `steven-zhc/studio` unattended, and `main` moves only when
  the operator submits and merges a PR (CLAUDE.md, *Running Lingtai on
  Lingtai*).
- Left for later (`doc/milestone/later/`): watching `main`'s own CI (a red
  `main` named before a submit, and on the board); following every move of
  `main` into `branch.personal` (the one catch-up after a merge is done, below);
  a blocker that has landed on the branch
  no longer blocking; a revert ticket. What is later for a PR is listed in 0131.
