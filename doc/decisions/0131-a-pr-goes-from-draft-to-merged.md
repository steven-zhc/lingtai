# 0131 — A PR goes from draft to merged in ten steps, and waits on a person only where Lingtai cannot go on by itself

**Status** proposed · 2026-11-22 · not yet built (0.16.0). Takes over [0130](0130-a-project-is-solo-or-team.md) §5 and §6, which now point here.

In team mode a ticket lands on the person's own branch, `branch.personal`
(0130). What happens between that branch and `main` is a **PR**: a person
deciding a body of work is ready for the team. This ADR is the PR's whole life —
its states and board, the ten steps Lingtai takes between *Submit* and the
team's review, where each step goes when it cannot finish, how a change the
review asks for comes back through them, and how Lingtai learns what the team
did. The flow is drawn in
[`doc/milestone/0.16.0/team-mode/pr-lifecycle.html`](../milestone/0.16.0/team-mode/pr-lifecycle.html),
and what each state does to the three branches — `main`, the PR branch and
`branch.personal` — in
[`doc/milestone/0.16.0/team-mode/pr-branches.html`](../milestone/0.16.0/team-mode/pr-branches.html),
the drawing a PR's page shows.

## Context

0130 decided that a team project has PRs and gave them their own lifecycle. Its
§5 and §6 held the PR's rules, and they grew past the rest of the ADR, whose
topic is what *solo* and *team* mean. The PR is a topic of its own: the push and
the code host's draft, the project's CI, other people pushing to the PR's
branch, the review's changes, and the merge back. One topic, one ADR.

## Decision

1. **A PR has its own lifecycle, on its own board.** Its events are on a stream
   of its own, `pr-{project}-{n}`, and the board's **PR page** draws one column
   per state, as the home page draws tickets:

   | Draft | In progress | Waiting on you | In review | Merged |
   |---|---|---|---|---|
   | the PR that is not submitted yet: the tickets landed on `branch.personal` that it holds; it grows as tickets land | Lingtai is taking the ten steps of §2 | a step cannot go on without a person, and says why | open for review on the code host; the team reviews it there | the team merged it into `main`; its tickets are closed |

   **The draft is a PR in the `draft` state, not a list computed on a read.**
   It is the highest-numbered PR while that PR is in `draft`; when the highest
   is in any other state, the draft has no stream yet and its number is the
   highest plus one. No event creates a draft and no process keeps one in
   existence. Its tickets are events on its own stream, `PrDraftTicketAdded {
   ticket, mergeCommit, from }`, where `from` is the PR that handed the ticket
   back, or null for a landing. Adding a ticket twice is adding it once, and the
   later merge commit stands.
   - **A landing on `branch.personal` writes two streams in one transaction**:
     `TicketLanded` on the ticket's and `PrDraftTicketAdded` on the draft's
     ([0129](0129-one-module-owns-each-aggregate.md) §5,
     [0100](0100-one-append-only-log.md) §3). The target is the highest PR while
     it is in `draft` or `requested`, and the next number otherwise. A version
     conflict on the target's stream is answered by finding the target again and
     writing again, with no limit and one log line each time: the push has
     happened, and the landing must be recorded.
   - A ticket an open PR already holds that lands on `branch.personal` again is
     added to the draft like any landing; the next PR carries the second landing.
   - A landing on a PR branch (§8) and a solo project's landing write nothing
     on a draft.

   **A PR is a release of a body of work**: what reaches *In review* has passed
   the unit build on `main`'s latest, has no conflict with it, holds every commit
   others pushed to its branch, and has passed the project's own CI. Later steps
   (an agent fixing a red CI run; a *verify* step that checks the code against
   the tickets' wants — 0.17) join the same sequence.

2. **Only the person submits, and *In progress* is ten steps in a fixed order.**
   *Submit* (a button on the draft card, or `lingtai pr submit`) is a request on
   the draft's own stream and moves it to *In progress*. With no ticket in the
   draft there is no stream, and *Submit* is refused at once and records
   nothing. A *Submit* the conductor refuses after it was recorded — nothing the
   frozen commit holds, the personal branch missing, git failing — returns the
   PR to `draft` with its tickets and the reason; it uses no number. Lingtai
   never submits on its own and never merges. A step
   either goes on by itself, buys an agent's round, or moves the PR to *Waiting
   on you* — and only the outcomes named so in this table wait on a person:

   | # | Step | What it does | When it cannot go on |
   |---|---|---|---|
   | 1 | Freeze | fixes `branch.personal` at one commit as the PR's content; keeps the draft's tickets whose merge commit that commit holds, and hands the rest to the next draft in the same transaction | — |
   | 2 | Bring `main` in | nothing when `main` is already an ancestor; otherwise merged in the merge lane's turn (§3) | a conflict → the conflict agent; its rounds spent → **waiting on you** |
   | 3 | Build | the result is built before it is pushed | red after a merge → the conflict agent (§3); red with nothing merged → **waiting on you** |
   | 4 | Others' commits | fetches the remote PR branch and merges in what others pushed (§4); nothing to do on the first submit | a conflict or a red build → the conflict agent; a force-push or a deleted branch → **waiting on you** |
   | 5 | Title and summary | the `pr:` agent writes them (§5) | the project locked → no summary; the first ticket's title, and the PR says why |
   | 6 | Push | pushes `<branch.personal>-pr-<n>` in the merge lane's turn | an unknown answer → one look at the remote, never a second blind push (#1125) |
   | 7 | Open as a draft | opens the PR on the code host as a **draft** | a code host that cannot open drafts → **waiting on you**, never opened ready |
   | 8 | CI | reads the checks on the head (§6) | red, none started in 30 minutes, or timed out → **waiting on you**, the failing checks named |
   | 9 | Top up the summary | adds what happened since the summary was written (§5) | nothing new → skipped, nothing spent |
   | 10 | Mark ready | reads the head again; marks the PR ready when it is the commit CI passed (§7) | the head moved → back to step 8, on the new head |

   Then the PR is *In review*, and its branch is merged back into
   `branch.personal` (§9). A restart mid-submit looks for the PR branch and an
   open PR from it before steps 6 and 7, and records what it finds, so a retry
   never opens a second PR.

   **Waiting on you** says why, and stops nothing else: tickets are still claimed
   and land on `branch.personal`. The person ends it from the PR page: *give the
   agent more rounds* (three); resolve it by hand on the PR branch and *check
   again* (`lingtai pr retry`), which takes the head the person pushed — if it
   still holds the frozen commit — and goes on from step 2 (`lingtai pr rounds`
   gives the rounds from a terminal); or *take it back to Draft*, which closes the
   PR on the code host and hands its tickets to the draft, for the next one.

3. **`main` is brought in when a PR is submitted or reworked, and once more
   into `branch.personal` after the PR merges (§10).**
   The sync is PR work: it runs on the PR branch, as step 2, at *Submit* and at
   each rework (§8) — never on a claim or a sweep. Between those points
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
     spend counts against the day's ceiling.
   - **A red build after a clean merge goes to the same agent.** Both sides were
     right alone and are wrong together — `main` changed a signature the
     person's new code still calls. The agent is handed the build's output, the
     commits merged and the person's tickets they meet, and does what it does
     for a conflict: makes both intents hold. It spends the same rounds; its
     change passes `build` and `review` or the next round is bought. A red build
     with nothing merged is the person's branch, not the sync, and waits on
     them.
   - An agent's round runs outside the merge lane; only its push takes the
     lane's turn. Findings the sync's review raises go to the backlog under the
     PR, not under a ticket.

4. **Commits others push to the PR branch are merged in before Lingtai pushes
   it.** Taking a review suggestion, *Update branch* and a plain push are the
   team working; the code host runs CI on the new head and Lingtai follows it
   (§7). Before every push of the PR branch — step 6, and a `lingtai:pr-fix`
   ticket's landing on it (§8) — Lingtai fetches the remote PR branch, with one
   function for both:
   - absent (the first submit) → nothing to merge;
   - the commit Lingtai last pushed, or an ancestor of it → push as before;
   - commits on top of what Lingtai last pushed → merged into what Lingtai is
     about to push, and **built before the push**, as after the sync;
   - a conflict, or a red build after the merge → the conflict agent and its
     rounds, as in §3;
   - Lingtai's last push no longer in the branch's history (a force-push) → not
     merged, **waiting on you**: merging could bring back commits somebody
     removed on purpose;
   - the branch deleted on the remote → **waiting on you**.

   A pr-fix ticket's landing is the merge lane's, inside the ticket's attempt, so
   it takes the ticket's road rather than the PR's: the lane merges the ticket
   into the PR branch as fetched, others' commits included; a conflict is the
   ticket's merge conflict, resolved by its own fix round, which merges the PR
   branch in first; only a force-push or a deleted branch is refused. The PR's
   own round then builds and checks the result from step 2.

5. **The summary is written before the draft opens, and topped up after CI.**
   The description is generated from the log — under a summary the `pr:` agent
   writes, one `Closes #a, Closes #b, …` line (GitHub links only an issue with its own keyword) for the GitHub tickets still open, and a
   footer with the ticket count; with no summary, one `- <title> (#n)` line per
   ticket first. It carries no spend, no merge commit and no per-ticket sha: spend
   is for the operator, and stays on the board's PR page. The summary is a short
   title (60 characters at most) and one bullet per area saying what is now true,
   with its ticket numbers; the syncs of §3 are never listed.
   - **Step 5** writes the title and summary before the push, so the draft opens
     with them and the code host's notifications carry the real title. The
     summary does not depend on CI. With the project locked (paused, the day's
     ceiling, an account limit) the PR opens with no summary, titled as its
     first ticket, and says why. A rework does not rewrite it.
   - **Step 9** adds only what happened since: the commits others pushed that
     step 4 merged, and each `lingtai:pr-fix` ticket that landed — what the review
     asked for (the ticket) and what changed (its commits). With nothing new it
     is skipped. It does not read the review's comments on the code host
     (§11).
   - Only the summary is the person's to edit, on the PR page, at any time; an
     edit is pushed to the code host.
   - **`pr:` is the summary agent's block**, beside `discuss:` and for the same
     reason — it spends outside any attempt: `{ agent, model, prompt, limits }`,
     the agent one that can run with no tools, as `discuss:`'s is, defaulting to
     `runtime.agent` where that one can, `limits` to 20 turns and `5m`, and
     carrying no `usd` (0104 §6). Each run counts against the day's ceiling.

6. **CI is the project's own, run on a draft pull request.**
   - 0.16 reads GitHub Actions; Jenkins is next. The PR is opened as a **draft
     pull request**, so the project's own `pull_request` workflows run on it
     unchanged. When every check on its head has finished, green goes on to
     step 9 and red waits on you with the failing checks named. Reading the
     checks needs the App's `checks: read` and `statuses: read`, added to its
     permissions for every project, solo too — one list, as `workflows` was —
     and to 0114 §3's table in the same change; every installation is asked to
     approve them once, and a repository whose installation has not is refused
     when it is added, by name.
   - A project with no workflow on pull requests has no CI step, and the PR page
     says so; no check started within 30 minutes of the push waits on you. A red
     run is the person's in 0.16: they re-run it on the code host and *check
     again*; Lingtai never re-runs a workflow (that would need `actions:
     write`).
   - **CI is a provider behind one interface**, as runtimes are
     (`packages/agent/src/runtime.ts`): `CiProvider` declares its capabilities
     (triggered by the push, or started through an API; can re-run; can read
     logs) and answers `detect` (is CI configured for this project), `start` (a
     no-op for a provider the push triggers) and `observe(sha)` (the checks on a
     commit, each with its state and link), with `failureExcerpt` optional.
     What a verdict is — green, red, running, none started, filtered to the
     checks the recipe counts — and when Lingtai looks and what each verdict does
     to the PR are Lingtai's, written once and shared by every provider. 0.16
     builds the interface and `github-actions`; Jenkins is designed for and built
     next, once the interface has been used for real.
   - **`pr.ci` in the recipe**: `provider` (`github-actions`, `jenkins` or
     `none`; absent, a workflow on pull requests means `github-actions`),
     `required` (the checks that count; absent, every check on the head) and
     `timeout` (`60m`), and for Jenkins a `jenkins: { url, job }` that 0.16
     refuses by name, saying the adapter is next. Credentials are never in a
     recipe: they are `~/.lingtai/config.yml`'s (`jenkins.user`,
     `jenkins.token`), per [0117](0117-configuration-is-config-yml-and-the-environment.md).

7. **A PR is marked ready only on the head CI passed.** After CI is green,
   step 10 reads the PR's head: the commit CI checked → marked ready, *In
   review*; another commit (somebody pushed) → not marked, and back to step 8 on
   the new head — following the team's push is not a failure and waits on
   nobody. A PR already ready on the code host (a rework) is left as it is. The
   moment between the read and the mark is accepted; nothing marks it and
   converts it back.

8. **A change the review asks for is a `lingtai:pr-fix` ticket, and its landing
   takes the PR round again from step 2.**
   - Opened from the PR's page the label is put on for the person; on the
     tracker a person adds it. It is a kind of its own and **ranks ahead of every
     kind the recipe names** — ahead of `bug` — because the team is waiting on
     it; it needs no other kind label. When it is claimed while a PR is open,
     **it is cut from that PR's branch and lands on it**, not on
     `branch.personal`, and the claim records the branch, so a retry, a fix
     round or a restart keeps it. Claimed with no PR open (merged or closed
     meanwhile), it is an ordinary ticket on `branch.personal`, and its page says
     why.
   - The review's comments stay on the code host and Lingtai does not read them
     (§11): the PR stays *In review* while the team comments and while the
     ticket is worked. Its landing merges in others' commits first (§4) and
     pushes; then the PR is *In progress* again, **from step 2**, because `main`
     may have moved while the PR was open:

     | Step | In a rework |
     |---|---|
     | 1 Freeze | not taken: the PR's content is its branch; tickets landed on `branch.personal` since stay out of it |
     | 2 Bring `main` in | taken |
     | 3 Build | taken |
     | 4 Others' commits | taken — the remote branch exists now |
     | 5 Title and summary | not taken: the summary stands |
     | 6 Push | only when step 2 or 4 merged something |
     | 7 Open as a draft | not taken: the PR is found by its branch |
     | 8 CI | taken, on the new head |
     | 9 Top up the summary | taken: the pr-fix ticket and others' commits |
     | 10 Mark ready | nothing to do on a ready PR; the page shows *In review* |

   - **The PR is not converted back to a draft for a rework.** The code host
     runs CI on the new head where the team sees it, and a draft toggle would
     notify every reviewer twice.

9. **The PR branch is merged back into `branch.personal` after every round of
   *In progress*** — after the first submit and after each rework — so the
   person's branch is current and the next PR carries the change.
   - The merge back is built before it is pushed, as the sync is. A conflict
     with tickets landed since, or a red build of the merge, goes to the
     conflict agent the same way and spends the same rounds.
   - A push whose answer is unclear is recorded `PrMergeBackFailed { why:
     'unknown' }`: **not known whether it landed; still owed**, and looked at
     again on the next serve.
   - Looking at the remote, the merge counts as landed when it is in
     `branch.personal`'s history, not only at its tip. Found there, it is
     recorded as merged back without a rebuild.
   - git's own words (its stderr) are carried into what a PR step records, so
     *waiting on you* says why.

10. **The rest of a PR's life.**
    - **Closed without merging**: the PR is `closed`, and in the same
      transaction each of its tickets is added to the draft, naming the PR it
      came from — a pr-fix ticket a merge back carried onto `branch.personal`
      among them. The code stays on `branch.personal`; nothing is reverted. A closed PR reopened on the code
      host is not followed.
    - **Merged: the personal branch catches up with `main`, once.** After the
      PR is recorded merged, the tip of `origin/<branch.main>`, read after a
      fetch in the landing lane's turn, is merged into `branch.personal` under
      `Merge <main> at <sha7> into <personal> after PR <n>`, built, and pushed to
      `refs/heads/<personal>` and nothing that names `branch.main`. It is the
      merge back's machinery with `main`'s tip as the commit: a push whose record
      was lost is found in the branch's history and recorded; a conflict or a red
      build goes to the conflict agent's rounds (counted as `back`, for that
      commit) and then waits on a person, who gives more rounds or retries
      (`lingtai pr rounds`, `lingtai pr retry`); a read that fails, or a paused
      or locked project, is `unknown` or `locked` and stays owed. `main` already
      in the branch is `PrCaughtUp` with no merge commit. It runs once per PR
      and is never a watcher on `main`.
    - **One PR at a time, and work never stops for it.** While a PR is open —
      in progress, waiting on you or in review — Lingtai goes on taking tickets
      and landing them on `branch.personal`; they gather in the draft, which is
      the next number, and *Submit* is refused, saying which PR is open, until
      that one is merged or closed. A landing recorded after the freeze fails on
      the frozen PR's stream version and is written to the next number.
      Stacked PRs are later (`doc/milestone/later/`): a PR closed under another
      would carry its refused tickets up, a squash merge below leaves the one
      above with duplicate commits, and every rework below ripples up.
    - **The code host**: GitHub in 0.16, through the GitHub App
      (`pull_requests: write`, `packages/github/src/app.ts:269`; opening a PR
      needs no new permission — only CI's two in §6). On any other remote —
      GitLab, or a local checkout — submitting pushes the frozen branch and
      prints the description for the person to open by hand; the PR goes to
      *In review* unfollowed, and is *Merged* when git finds its head on `main`.
      How draft and ready work on another code host is decided when a second one
      is integrated (`doc/milestone/later/`).
    - **Solo mode has no PR page**: `lingtai pr` refuses, saying the project
      lands on `branch.main` itself.
    - **A PR has two ids.** Lingtai numbers a personal branch's PRs from 1 — the
      id on the log and the PR branch's name, `<branch.personal>-pr-<n>`
      (`steven-zhc/foundry-pr-7`): the personal branch's name keeps two people's
      apart on the shared remote, and a `-` rather than a `/` because git cannot
      hold a branch and a directory of the same name. The code host's number
      (GitHub's `#88`) exists once it is opened, and is recorded beside it. Cards
      show the code host's number once there is one.

11. **How Lingtai learns what the team did** — no webhook needed:
    - **merged**: from git, when the PR's head is reachable from
      `origin/<branch.main>`, **or** from the code host reporting it merged — a
      squash or rebase merge leaves nothing reachable, and it is merged all the
      same. Proving which tickets' code a squash merge carried needs the PR's
      last head: when the branch was deleted and the mirror, which fetches only
      `refs/heads/*`, cannot have it by name, it is fetched by
      `refs/pull/<number>/head` — the code host's number, not Lingtai's `n` —
      into a temporary ref and dropped after; with no code host number, or not
      found either way, the tickets are *unproven* and not closed;
    - **closed without merging**: read on the daemon's sweep timer (`SWEEP_MS`,
      five minutes, `packages/daemon/src/work-loop.ts:167`) — a read of its own
      on that timer, not inside the pass, since the sweep only kicks a pass and a
      paused conductor skips the pass — one request for the one open PR, stopped
      early when it has not changed since the last read; the same read gives a
      draft PR's checks;
    - **the PR page asks the code host when it renders**, as the Queued column
      does, and links to the review there. Review state and comments are not
      read in 0.16 (`doc/milestone/later/`).

    A webhook (`pull_request`) is an optional speed-up where the App has a public
    address; adding events to the App asks every installation to approve the
    change, so nothing above depends on it.

## Consequences

- What reaches the team has passed the unit build on `main`'s latest and the
  project's CI, and holds everything others pushed to the PR's branch; a push of
  Lingtai's never overwrites a teammate's commit.
- A person is asked only where a judgement is theirs: a conflict or a red build
  the agent could not mend, a force-push, a deleted branch, a red CI run, a code
  host that cannot open drafts. Following the team's push and an unknown push
  answer are Lingtai's own.
- The conflict agent has two jobs — a conflict and a red build after a merge,
  at the sync, at others' commits and at the merge back — and one budget,
  `attempt.conflictResolutions`, per PR.
- The `pr:` agent runs once at submit and once per rework that brought something
  new; both count against the day's ceiling.
- The PR page's *Merged* column is the PR history.
- New events, all on the PR's stream `pr-{project}-{n}`: its requests, served
  by the conductor as a discussion's are (submit, retry, more rounds, back);
  its tickets while it is a draft (`PrDraftTicketAdded`);
  its states (in progress, waiting, opened, ready, merged, closed); its syncs
  (`BranchSynced { mainCommit, how: clean | resolved }`) and their rounds; and
  the merge back (`PrMergedBack`, `PrMergeBackFailed`) and the catch-up
  (`PrCaughtUp`, `PrCatchUpFailed`). No lock is added: a PR
  waiting on you stops nothing else. No ticket event is added — a
  `lingtai:pr-fix` ticket's claim records the PR branch it is cut from, as a
  field of the claim.
- Left for later (`doc/milestone/later/`): the Jenkins adapter; draft and ready
  on another code host; an agent fixing a red CI run; reading the review's state
  and comments (on the PR page and into the summary); stacked PRs; flaky checks
  recorded; CI minutes in a PR's spend; a *verify* step against the tickets'
  wants (0.17).
