# 0130 — A project is solo or team: a team's tickets land on the person's own branch, and that branch reaches `main` as a PR with a life of its own

**Status** proposed · 2026-11-20, revised the same day three times (a cold review; the PR given its own lifecycle and board; then made simpler: one PR at a time, the sync only when a PR is submitted or reworked) · not yet built (0.16.0)

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
   include `queue.assignee.login`, which `lingtai add` asks for when Lingtai
   acts as a GitHub App and knows no person's login; on the local store, **every
   ticket** — local tickets are one person's — so team mode works there whole
   and is the way to try it with nothing shared. A solo machine passes over an
   issue labelled `lingtai:landed`: it is somebody's work waiting on a PR.
   The board's Queued column shows what this machine would take, by the same
   rule.

4. **A team's ticket lands on the personal branch, as any ticket lands.** The
   merge lane merges it into `branch.personal` and appends `TicketLanded { base:
   <branch.personal> }`; `landed` is terminal as 0109 §11 says, so the queue never
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

5. **A PR has its own lifecycle, on its own board.** A PR is the person saying a
   body of work on their branch is ready for the team. Its events are on a
   stream of its own, `pr-{project}-{n}`, and the board's **PR page** draws one
   column per state, as the home page draws tickets:

   | Draft | In progress | Waiting on you | In review | Merged |
   |---|---|---|---|---|
   | what has landed on `branch.personal` and no PR holds yet; it grows as tickets land | Lingtai is working on it, in order: bringing `main` in, building, an agent resolving a conflict, **the project's CI**, the summary | Lingtai could not go on alone: a conflict the agent could not resolve, a red build, **a red CI run**, a branch rewritten by hand | open for review on the code host; the team reviews it there | the team merged it into `main`; its tickets are closed |

   **A PR is a release of a body of work**: what reaches *In review* has passed
   the unit build on `main`'s latest, has no conflict with it, and has passed the
   project's own CI. Later steps (an agent fixing a red CI run; a *verify* step
   that checks the code against the tickets' wants — 0.17) join the same
   sequence.

   - **Only the person submits.** *Submit* (a button on the draft card, or
     `lingtai pr submit`) freezes `branch.personal` at one commit and moves the PR
     to *In progress*, whose steps run in this order: bring `main` in (§6),
     build, resolve a conflict with an agent, push the PR branch, open it as a
     draft pull request, **run the project's CI**, write the title and summary,
     mark it ready — then it is *In review*. Anything it cannot finish moves
     it to *Waiting on you*, saying why, and nothing is offered for review.
     Lingtai never submits on its own and never merges.
   - **CI** (0.16: GitHub Actions; Jenkins next). The PR is opened on GitHub as a
     **draft pull request**, so the project's own `pull_request` workflows run
     on it unchanged; when every check on its head has finished, green moves it
     to *In review* by marking it *ready for review*, and red moves it to
     *Waiting on you* with the failing checks named. Reading the checks needs the
     App's `checks: read` and `statuses: read`, added to its permissions for
     every project, solo too — one list, as `workflows` was — and to 0114 §3's
     table in the same change; every installation is asked to approve them once,
     and a repository whose installation has not is refused when it is added, by
     name. A project with no workflow on pull requests has no CI step, and the
     PR page says so; no check started within 30 minutes of the push waits on
     you. A red run is the person's in 0.16: they re-run it on the code host and
     *check again*; Lingtai never re-runs a workflow (that would need
     `actions: write`), and an agent fixing a red run is later. A repository
     that cannot open draft pull requests waits on you rather than opening one
     ready for review.
   - **A change the review asks for is a `lingtai:pr-fix` ticket.** Opened from
     the PR's page the label is put on for the person; on the tracker a person
     adds it. It is a kind of its own and **ranks ahead of every kind the recipe
     names** — ahead of `bug` — because the team is waiting on it; it needs no
     other kind label. When it is claimed while a PR is open, **it is cut from
     that PR's branch and lands on it**, not on `branch.personal` — the one
     change to a ticket's life — and the claim records the branch, so a retry,
     a fix round or a restart keeps it. Claimed with no PR open (merged or
     closed meanwhile), it is an ordinary ticket on `branch.personal`, and its
     page says why. Its landing takes the PR through *In progress* again (§6's
     sync, build, CI) and back to *In review*, and the PR branch is then merged
     back into `branch.personal` — once, so the next PR carries the change.
     Landing on a PR branch refuses, saying so, when somebody else pushed to it
     on the code host and it is no longer what Lingtai last pushed.
   - **The description** is generated from the log — the tickets, `Closes #…` for
     each GitHub ticket still open, each merge commit and its spend; the syncs of
     §6 are never listed — under a summary the `pr:` agent writes. Only the
     summary is the person's to edit, on the PR page, at any time; an edit is
     pushed to the code host.
   - **Closed without merging**: the PR moves back to *Draft*; its tickets stay
     on `branch.personal`; nothing is reverted. A closed PR reopened on the code
     host is not followed.
   - **One PR at a time, and work never stops for it.** While a PR is open —
     in progress, waiting on you or in review — Lingtai goes on taking tickets
     and landing them on `branch.personal`; they gather in *Draft*, and *Submit*
     is refused, saying which PR is open, until that one is merged or closed.
     Stacked PRs — a second PR based on the first, sent for review before the
     first merges — are later (`doc/milestone/later/`): a PR closed under
     another would carry its refused tickets up, a squash merge below leaves the
     one above with duplicate commits, and every rework below ripples up.
   - **The code host**: GitHub in 0.16, through the GitHub App
     (`pull_requests: write`, `packages/github/src/app.ts:269`; opening a PR
     needs no new permission — only CI's two above). On any other remote — GitLab, or a local checkout — submitting
     pushes the frozen branch and prints the description for the person to open
     by hand; the PR goes to *In review* unfollowed, and is *Merged* when git
     finds its head on `main`.
   - **A restart mid-submit** looks for the PR branch and an open PR from it
     before pushing or opening anything, and records what it finds, so a retry
     never opens a second PR.
   - **Solo mode has no PR page**: `lingtai pr` refuses, saying the project lands
     on `branch.main` itself.

   **A PR has two ids.** Lingtai numbers a personal branch's PRs from 1 — the id
   on the log and the PR branch's name, `<branch.personal>-pr-<n>`
   (`steven-zhc/foundry-pr-7`): the personal branch's name keeps two people's
   apart on the shared remote, and a `-` rather than a `/` because git cannot hold
   a branch and a directory of the same name. The code host's number (GitHub's
   `#88`) exists once it is opened, and is recorded beside it. Cards show the
   code host's number once there is one.

   **How Lingtai learns what the team did** — no webhook needed:
   - **merged**: from git, when the PR's head is reachable from
     `origin/<branch.main>`, **or** from the code host reporting it merged — a
     squash or rebase merge leaves nothing reachable, and it is merged all the
     same;
   - **closed without merging**: read on the daemon's sweep timer (`SWEEP_MS`,
     five minutes, `packages/daemon/src/work-loop.ts:167`) — a read of its own on
     that timer, not inside the pass, since today the sweep only kicks a pass and
     a paused conductor skips the pass — one request for the one open PR, stopped
     early when it has not changed since the last read; the same read gives a
     draft PR's checks;
   - **the PR page asks the code host when it renders**, as the Queued column
     does, and links to the review there. Review state and comments are not read
     in 0.16 (`doc/milestone/later/`).

   A webhook (`pull_request`) is an optional speed-up where the App has a public
   address; adding events to the App asks every installation to approve the
   change, so nothing above depends on it.

   **`pr:` is the summary agent's block**, beside `discuss:` and for the same
   reason — it spends outside any attempt: `{ agent, model, prompt, limits }`,
   the agent one that can run with no tools, as `discuss:`'s is, defaulting to
   `runtime.agent` where that one can, `limits` to 20 turns and `5m`, and
   carrying no `usd` (0104 §6). It writes the PR's title and summary; one run at
   submit and one at each `lingtai:pr-fix` landing, extending the current summary
   (with no run the title is the first ticket's); both count against the day's ceiling. Where
   the project is locked (paused, the day's ceiling, an account limit) the PR
   opens without a summary and says why.

6. **`main` is brought in when a PR is submitted or reworked, and only then.**
   The sync is PR work: it runs on the PR branch, as a step of *In progress*,
   at *Submit* and at each `lingtai:pr-fix` landing — never on a claim or a
   sweep — and the PR branch is then merged back into `branch.personal`, so the
   person's branch is current after every submit. Between submits
   `branch.personal` may fall behind `main`; tickets are cut from it as it is,
   and what conflicts is met at the next submit.
   - When `origin/<branch.main>` is already an ancestor of the PR branch
     (`git merge-base --is-ancestor`) nothing is done. Otherwise it is merged in
     the merge lane's own turn ([0122](0122-several-passes-share-one-conductor.md)
     §3), so a sync and a landing never push a branch at once, and **the result
     passes `build` before it is pushed**.
   - **A conflict is resolved by an agent, as an attempt's is**:
     [0108](0108-a-refusal-buys-a-round.md) §8's `resolveConflict`, on a worktree
     of the PR branch, handed what each side meant — the tickets whose code
     conflicts, and the commits on `main` that brought the other side. The
     resolution passes `build`, and `review` reads its own diff; a refusal of
     either is the next round. Rounds are counted per `main` commit merged, on
     the PR's stream, bounded by `attempt.conflictResolutions`; the agent's
     spend counts against the day's ceiling. Merging the PR branch back into
     `branch.personal` is resolved the same way when the tickets landed since
     conflict with it.
   - **When it cannot finish** — rounds spent, a red build, a branch rewritten
     or deleted by hand — **the PR waits on you**, saying why, and nothing else
     stops: tickets are still claimed and land on `branch.personal`. The person
     ends it from the PR page: *give the agent more rounds* (three), or resolve
     it by hand on the PR branch and *check again* (`lingtai pr retry`), which
     takes the head the person pushed — if it still holds the frozen commit —
     brings in whatever of `main` it lacks, builds and goes on
     (`lingtai pr rounds` gives the rounds from a terminal). An agent's round
     runs outside the merge lane; only its push takes the lane's turn. The merge
     back into `branch.personal` is built before it is pushed, as the sync is.
   - Findings the sync's review raises go to the backlog under the PR, not under
     a ticket.

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
- The PR page's *Merged* column is the PR history.
- Team mode on a tracker other than GitHub or the local store waits for that
  source (`doc/milestone/later/ticket-sources.md`).
- `lingtai:landed` is a label Lingtai writes and `lingtai:pr-fix` one a person
  sets, both under 0116 §5's prefix.
- New events, all on the PR's stream `pr-{project}-{n}`: its requests, served
  by the conductor as a discussion's are (submit, retry, more rounds, back);
  its states (in progress, waiting, opened, merged, closed); and its syncs
  (`BranchSynced { mainCommit, how: clean | resolved }`) and their rounds. No
  lock is added: a PR waiting on you stops nothing else. No ticket event is
  added — a `lingtai:pr-fix` ticket's claim records the PR branch it is cut
  from, as a field of the claim; `TicketLanded` gains no new position.
- This repository runs solo: it is Lingtai's own repository and merges its own
  work unattended (CLAUDE.md, *Running Lingtai on Lingtai*).
- Left for later (`doc/milestone/later/`): stacked PRs; bringing `main` into
  `branch.personal` whenever it moves; Jenkins as a CI; an agent fixing a red
  CI run; a *verify* step against the tickets' wants (0.17); review state and
  comments on the PR page; a blocker that has landed on the branch no longer
  blocking; a revert ticket.
