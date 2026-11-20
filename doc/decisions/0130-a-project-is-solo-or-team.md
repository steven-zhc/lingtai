# 0130 — A project is solo or team: a team takes the person's own tickets, puts them in review on their personal branch, and lands them on `main` only through a PR the person submits

**Status** proposed · 2026-11-20, revised the same day after a cold review · not yet built (0.16.0)

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

1. **`mode` is a recipe key, `solo` or `team`, and it decides four things.**
   **A recipe that names no mode is `solo`**, so a project made before this
   decision keeps doing what it did. `lingtai add` and `lingtai init` ask for
   the mode and default to `team`.

   | | `solo` | `team` |
   |---|---|---|
   | `take` | `all` (or as written) | `mine`, and only `mine` (§3) |
   | The cut and the landing | `branch.main` | `branch.personal` |
   | The merge lane ends in | `landed` | `TicketInReview` — not an ending (§5) |
   | Reaching `branch.main` | the landing itself | a PR the person submits (§6) |

   **The mode cannot change while it would strand work**: switching between
   solo and team is refused by name while any ticket is in review or a PR is
   open, since solo has no `branch.personal` for them to land from.

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
   not exist; an existing one is used as it is, and the first sync (§4) brings
   `main` into it. For a local team project (`add --local`, `init --local`)
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
   becomes `steven/steven-s-macbook-pro`. `lingtai add` shows it and the person
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
   include `queue.assignee.login`, which `lingtai add` asks for when Lingtai
   acts as a GitHub App and knows no person's login; on the local store, **every
   ticket** — local tickets are one person's — so team mode works there whole
   and is the way to try it with nothing shared. A solo machine passes over an
   issue labelled `lingtai:in-review`: it is somebody's work waiting on a PR.
   The board's Queued column shows what this machine would take, by the same
   rule.

4. **The personal branch is kept current with `main`.** Lingtai checks before
   each claim, on every sweep (`SWEEP_MS`, five minutes,
   `packages/daemon/src/work-loop.ts:167`) so that a merged PR lands even when
   nothing is being claimed, and once more when a PR is prepared. When
   `origin/<branch.main>` is already an ancestor of `branch.personal`
   (`git merge-base --is-ancestor`) nothing is done. Otherwise it is merged into
   `branch.personal` in the merge lane's own turn, so a sync and a landing never
   push the branch at once, and **the result passes `build` before it is
   pushed**: a red build is a wait for a person and nothing is pushed, so a red
   `main` never becomes the base every ticket is cut from.

   **A conflict is resolved by an agent, as an attempt's is.** It is
   [0108](0108-a-refusal-buys-a-round.md) §8's `resolveConflict`, run on a
   worktree of `branch.personal` merging `origin/<branch.main>`, handed what each
   side meant: the tickets in review whose code conflicts, and the commits on
   `branch.main` that brought the other side. The resolution passes `build`, and
   `review` reads the resolution's own diff; a refusal of either goes back to the
   agent as the next round. Rounds are counted per `main` commit being merged,
   bounded by `attempt.conflictResolutions`, and the agent's spend counts against
   the day's ceiling as any run's does. When the rounds are spent the sync is a
   wait for a person — *the personal branch conflicts with `main`; claiming is
   paused* — and nothing is claimed for the project until it ends. The wait is a
   lock ([0126](0126-a-stop-is-a-lock-and-an-unlock.md) §2, `BranchSyncHeld`),
   as a red build or a vanished branch is, so every gate, the banner, `status` and
   `doctor` read it as they read a pause; a red build's hold lifts itself when
   `main` moves and the next sync pushes green. A sync's rounds are recorded on a
   stream of their own per `main` commit. The person
   ends it one of two ways: *give the agent more rounds* (three, from the board
   or `lingtai sync --rounds 3`), or resolve it by hand and run `lingtai sync`,
   which checks that `main` is now an ancestor, builds, and resumes.

   **A personal branch rewritten or deleted by hand** is found by the next sync:
   a ticket in review whose merge commit is no longer on `branch.personal` is a
   wait for a person, and nothing is claimed until it ends.

5. **In review is a state, not an ending.** This is how a team already runs a
   ticket: open while its PR waits, *done* only when the code is on the trunk.
   In team mode the merge lane's merge into `branch.personal` appends
   `TicketInReview { mergeCommit, branch }`. It is not one of `end`'s outcomes
   (`TerminalOutcome`, `packages/conductor/src/end-step.ts:63`, is unchanged) and
   `end` does not run on it; the ticket's `lingtai:in-review` label is computed
   from its state, as `lingtai:working` is (`labelsFor`, 0109 §5).
   - **The queue passes it over** as `in-review`, by its state on the log and
     not by the label, so a label a person removes changes nothing on this
     machine.
   - **It lands when its code is on `branch.main`**: the sync of §4 appends
     `TicketLanded { mergeCommit, base: <branch.main> }` for each ticket in
     review whose merge commit is reachable from `origin/<branch.main>`, **or**
     whose PR the code host reports merged — a squash or rebase merge leaves
     nothing reachable, and it lands all the same. `mergeCommit` is the
     ticket's own merge into `branch.personal`. `TicketLanded` is written at the
     sync, outside a pass (`EVENT_AT`'s `outside`), beside `merge` and `end`. `end` then runs on
     `landed` as it does in solo — its `close` closes the ticket on every
     source, whether or not the PR's `Closes #…` already did (it does only when
     the PR targets the repository's default branch). `landed` keeps 0109 §11's
     meaning: terminal, and on the trunk.
   - **A blocker in review still blocks.** A ticket blocked by one in review
     waits until that one lands, as a team's ticket waits for its blocker's PR.
   - **Closed while in review** (`lingtai close`, or by hand on the tracker): it
     stays closed; its code is already on `branch.personal` and goes into the PR
     with the rest, listed without `Closes #…`.
   - **Nothing takes a ticket out of review.** What is in review goes into the
     PR whole. A change the person wants is a new ticket, put in review like any
     other, so it joins the same draft.
   - **Satisfied** (0108 §21) keeps its meaning against the cut: in team mode, a
     ticket whose want is already true on `branch.personal` ends satisfied and
     closes without code of its own.
   - **What each reader shows**: `task_view` shows *in review* and the PR or
     draft that holds the ticket; `ticket_report` counts it open until it lands;
     `spend` is unchanged, being per run.

6. **What is in review becomes one PR, at the person's word.** The PR moves
   through these states, each an event on the project's stream — `PrPrepared`,
   `PrReturnedToDraft`, `PrSubmitted`, `PrUpdated`, `PrMerged`, `PrClosed`.
   A person's *prepare*, *submit* and *update* are requests on that stream
   (`PrPrepareRequested`, `PrSubmitRequested`, `PrUpdateRequested`) that the
   conductor serves, as a discussion is, since preparing syncs and builds in the
   lane's turn; one it cannot serve is answered `PrRequestRefused` with why:

   | State | What is true | How it moves on |
   |---|---|---|
   | **draft** | every ticket in review that no open PR holds; it grows as tickets are put in review | the person *prepares* it |
   | **preparing** | `branch.personal` is frozen at one commit; the `pr:` agent has written a summary; title and description are the person's to edit; the checks have run | the person *submits* it, or goes back to the draft |
   | **submitted** | the frozen commit is pushed as the PR branch and the PR is open on the code host | merged, closed, or *updated* |
   | **merged** | its tickets land (§5) | a new draft begins |

   - **Only the person moves it**: a button on the board's PR page, or `lingtai
     pr prepare` / `back` / `submit` / `update`. Lingtai never submits on its own.
   - **Prepare freezes it**: the PR holds the tickets in review at that commit;
     one put in review after it joins the next draft. *Back to the draft* drops
     the frozen commit and keeps the PR's number for the next prepare.
   - **Before a PR opens, it is checked**: `branch.personal` is current with
     `origin/<branch.main>` (§4) and the frozen commit passes `build`; either
     failing opens nothing and says why.
   - **One open PR per personal branch on GitHub.** While one is submitted,
     tickets go on being put in review and gather in the next draft, but nothing
     new is submitted until the open PR is merged or closed — a second PR from
     the same branch would carry the first one's commits.
   - **A change the review asks for is a rework ticket, then *update***: the
     person opens the ticket; it is put in review like any other; *update*
     pushes `branch.personal`'s head to the PR branch and regenerates the
     description, listing first every ticket that joins. Update refuses, saying
     so, when the PR branch is no longer an ancestor of `branch.personal` —
     somebody pushed to it on the code host — and the person decides.
   - **Closed without merging**: its tickets stay in review and return to the
     draft; nothing is reverted. A closed PR reopened on the code host is not
     followed.
   - **The description** is generated from the log — the tickets, `Closes #…`
     for each GitHub ticket still open, each merge commit and its spend; the
     syncs of §4 are never listed and add nothing to the diff — under the
     summary, which the person may edit before submitting and before each update.
   - **The code host**: GitHub in 0.16, through the GitHub App
     (`pull_requests: write`, `packages/github/src/app.ts:269`; no new
     permission). On any other remote — GitLab, or a local checkout — the frozen
     branch is pushed and the description printed for the person to open by
     hand; Lingtai does not follow that PR — the draft begins again at the next
     number at once — *one open PR* does not apply, and its tickets land by git
     alone (§5), so a squash merge there leaves them in
     review and the documentation says to merge with a merge commit.
   - **A restart mid-submit** looks for the PR branch and an open PR from it
     before pushing or opening anything, and records what it finds, so a retry
     never opens a second PR.
   - **Lingtai never merges the PR.**
   - **Solo mode has no PR**: `lingtai pr` refuses, saying the project lands on
     `branch.main` itself.
   - **One page**: the board's PR page shows whichever state the PR is in.

   **A PR has two ids.** Lingtai numbers a personal branch's PRs from 1 when one
   is first prepared — the id on the log, and the PR branch's name,
   `<branch.personal>-pr-<n>` (`steven/foundry-pr-7`): the personal branch's
   name keeps two people's apart on the shared remote, and a `-` rather than a
   `/` because git cannot hold a branch and a directory of the same name. The
   code host's number (GitHub's `#88`) exists only once it is submitted, and is
   recorded beside it then. The page shows no number before submitting, and the
   code host's after it; the branch name is secondary.

   **How Lingtai learns what the team did** — no webhook needed:
   - **merged**: from git, by the sync of §4, or from the code host reporting the
     PR merged (§5);
   - **closed without merging**: read in the same sweep, one request for the one
     open PR, stopped early when it has not changed since the last read;
   - **the PR page asks the code host when it renders**, as the Queued column
     does, and shows a link to the review there. Review state and comments are
     not read in 0.16 (`doc/milestone/later/`).

   A webhook (`pull_request`) is an optional speed-up where the App has a public
   address; adding events to the App asks every installation to approve the
   change, so nothing above depends on it.

   **`pr:` is the summary agent's block**, beside `discuss:` and for the same
   reason — it spends outside any attempt: `{ agent, model, prompt, limits }`,
   the agent one that can run with no tools, as `discuss:`'s is, defaulting to
   `runtime.agent` where that one can, `limits` to 20 turns and `5m`, and
   carrying no `usd` (0104 §6). One run when a PR is prepared, and one when it is
   updated, extending the person's current summary; both count against the day's
   ceiling. Where the project is locked (paused, the day's ceiling, an account
   limit) a prepare goes on without a summary and says why. Only the summary is
   the person's to edit; the generated list under it is not.

7. **In team mode nothing Lingtai does pushes `branch.main`.** The merge lane,
   the sync, `lingtai pr` and every other path push `branch.personal` or a PR
   branch and nothing else, and a test holds that.

## Consequences

- A new user's first project is a team project on local tickets: nothing on a
  shared tracker, nothing on `main`, and the whole team flow to read. The first
  tutorial's `lingtai-base` is the personal branch by its default name.
- The team reviews one PR a person chose to submit, holding several tickets, not
  one PR per ticket. Merged with a merge commit — the lane's own merges are
  `--no-ff` (`packages/repo/src/integrate.ts:539`) — one ticket the team refuses
  is one `git revert`; a squash merge loses that, and the documentation says so.
- Team mode on a tracker other than GitHub or the local store waits for that
  source (`doc/milestone/later/ticket-sources.md`).
- `lingtai:in-review` is a label Lingtai writes, under 0116 §5's prefix. The
  board keeps its four columns: in team mode the *Landed* column is split, its
  landed tickets above, compact and folded, and the tickets *in review* below.
- New events: `TicketInReview`; the PR's six; the sync's
  (`BranchSynced { mainCommit, how: clean | resolved }`, and its wait on the
  project's stream). Every reducer of the ticket reads `TicketInReview`
  (0101 §4); `TicketLanded`'s event positions gain the sync; 0109 §11's
  terminal outcomes and §12's audit are unchanged. Findings the sync's review
  raises go to the backlog under the sync, not under a ticket.
- This repository runs solo: it is Lingtai's own repository and merges its own
  work unattended (CLAUDE.md, *Running Lingtai on Lingtai*).
- Left for later (`doc/milestone/later/`): review state and comments on the PR
  page; a blocker in review that no longer blocks (a stacked PR); the PR
  history; a revert ticket.
