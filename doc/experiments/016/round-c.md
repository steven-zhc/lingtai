# 016 · Round C — a fork of `ai/nanoid`, Node / pnpm, GitHub through `gh`

Part of [016, the v0.10.0 first-time path](../016-the-v0.10.0-first-time-path.md): how to fill this in, the shared environment ([0.4](../016-the-v0.10.0-first-time-path.md#04-a-clean-state-every-terminal)), the Record and After are there.

This round also carries **the once-only `gh` checks**. Do them in the order
written, because each one sets up the state the next one needs.

**Terminal 1**. **A new terminal for this round, or set it again here.** A terminal left from the last round still has its `ROUND`, and `init` then runs in that round's home: in round B it printed `home /Users/steven/lingtai-trial/a` and asked nothing (B1). `echo $LINGTAI_HOME` must print this round's letter.

**C.1**

```fish
set -gx ROUND c
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
mkdir -p $LINGTAI_HOME $TRIAL_SRC
echo $LINGTAI_HOME
gh auth status
```

*C.1 output:*

```paste
❯ set -gx ROUND c
  set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
  set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
  set -gx TRIAL_SRC $HOME/lingtai-trial/src
  mkdir -p $LINGTAI_HOME $TRIAL_SRC
  echo $LINGTAI_HOME
  gh auth status
/Users/steven/lingtai-trial/c
You are not logged into any GitHub hosts. To log in, run: gh auth login
```

- [x] **C.1-a** It says you are not logged in. That is expected, because
  `$GH_CONFIG_DIR` is new. If it shows a login, the export did not take.
  → Yes: "You are not logged into any GitHub hosts."

**`--defaults` with no `--project` refuses at once (#700).** Use a throwaway
home so that a refusal which writes something cannot spoil this round's:

**C.2**

```fish
rm -rf $HOME/lingtai-trial/c-defaults
env LINGTAI_HOME=$HOME/lingtai-trial/c-defaults lingtai init --store sqlite --defaults </dev/null
echo "exit: $status"
ls -la $HOME/lingtai-trial/c-defaults
rm -rf $HOME/lingtai-trial/c-defaults
```

(`$status` is fish's exit code of the command before it.) **`</dev/null` is the
point**: it is a script with no terminal. At a terminal the project question
is *asked*, not defaulted, which is #700's design as well ("A durable choice
is never defaulted": `github` would start an App's creation and a browser);
the first paste below shows that, and it is right. Without a terminal there is
nobody to ask, so it must refuse by name.

*C.2 output:*

```paste
❯ env LINGTAI_HOME=$HOME/lingtai-trial/c-defaults lingtai init --store sqlite --defaults
  echo "exit: $status"
  ls -la $HOME/lingtai-trial/c-defaults
init
│
Machine
  git          git version 2.50.1 (Apple Git-155)
  claude-code  signed in via claude.ai
  codex        Logged in using ChatGPT
  home         /Users/steven/lingtai-trial/c-defaults — nothing yet
Store
  store  SQLite, /Users/steven/lingtai-trial/c-defaults/lingtai.db ← /Users/steven/lingtai-trial/c-defaults/config.yml
  SQLite is the whole log, in one file under ~/.lingtai — no server, and no second machine: nothing outside this one can read it, and switching stores later starts a new, empty log and moves nothing from this one
GitHub App
  app  none yet — the board's first screen creates it through GitHub's manifest flow
│
■  a GitHub project, or one on this machine only
│  github
│

stopped at the question — its answer was not written, and running the command again asks it here
exit: 130
total 120
drwxr-xr-x@ 6 steven  staff    192 Oct 29 22:56 ./
drwxr-xr-x@ 5 steven  staff    160 Oct 29 22:56 ../
-rw-------@ 1 steven  staff     26 Oct 29 22:56 config.yml
-rw-r--r--@ 1 steven  staff   4096 Oct 29 22:56 lingtai.db
-rw-r--r--@ 1 steven  staff  32768 Oct 29 22:56 lingtai.db-shm
-rw-r--r--@ 1 steven  staff  16512 Oct 29 22:56 lingtai.db-wal
└
```

*C.2 output, with no terminal:*

```paste

```

- [x] **C.2-a0** At a terminal (first paste): it stops at "a GitHub project,
  or one on this machine only" with nothing chosen, and no browser opened.
  Ctrl+C there. It then said "stopped at the question — its answer was not
  written, and running the command again asks it here", exit 130, and the home
  held `config.yml` (26 bytes) and `lingtai.db` (C1).
- [ ] **C.2-a** With no terminal (`</dev/null`): it refuses immediately, by name,
  with a non-zero exit, and no browser opened.
  → **Not run** (the no-terminal paste is empty).

**Signed out: `init` offers to sign in, and Ctrl+C returns to the choice
(#712):**

**C.3**

```fish
lingtai init --store sqlite --project github --port 17830
```

When it asks how to reach GitHub, choose the `gh` login. It offers to sign in:
accept. It hands the terminal to `gh auth login --web`. **Press Ctrl+C before
finishing in the browser.**

*C.3 output:*

```paste

```

- [ ] **C.3-a** Ctrl+C returns you to the choice and does not end `init`.
  → **Not run**: the operator completed the sign-in without pressing Ctrl+C.

Now quit `init` (Ctrl+C at the choice) and check that nothing was written:

**C.4**

```fish
gh auth status
cat $LINGTAI_HOME/config.yml
```

*C.4 output:*

```paste

```

- [ ] **C.4-a** There is no `gh` login, and `config.yml` has no GitHub key.
  → **Not run**, for the same reason.

**Signed out, completing the sign-in:**

**C.5**

```fish
lingtai init --store sqlite --project github --port 17830
```

Choose `gh`, accept the sign-in, and complete it in the browser this time:

*C.5 output:*

```paste

```

- [ ] **C.5-a** `init` continues on its own after the browser step.
- [ ] **C.5-b** Doctor's short view is readable (#701), and init ends with a single
  `next:` line (#702). No output cites an ADR, an issue number or a source
  path (#703).
  → **Not pasted.** The sign-in did complete: C.8 shows `gh` signed in as steven-zhc with `repo` and `workflow`.
  → **Not pasted.**

**The fork.** Forks have issues turned off, and Lingtai's tickets here are
issues:

**C.6**

```fish
gh repo fork ai/nanoid --clone=false
set -gx FORK (gh api user --jq .login)/nanoid
gh repo edit $FORK --enable-issues
gh repo view $FORK --json defaultBranchRef --jq .defaultBranchRef.name
gh label create feature -R $FORK --color 0e8a16 --force
```

*C.6 output:*

```paste

```

**Add it, interactively, letting it detect:**

**C.7**

```fish
date
lingtai add $FORK
date
```

**The answers**, in the order `add` asks (same prompts as round B's table,
plus `source.ts:150` for tickets, since a GitHub project is asked where they
live). Enter means take what it offers. A question not in this list is a
finding: write it down with its words.

| #   | It asks                                                                                                 | Answer                                | Why                                                                             |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | the branch this project's recipe governs and merges into                                                | Enter if it offers `main`             | if it insists on `--base` instead, write that down as stuck and give `main`     |
| 2   | use every default?                                                                                      | `no`                                  | `yes` refuses at the writer while Claude Code and Codex are both signed in (B8) |
| 3   | which agent writes the change (claude-code, codex)                                                      | `claude-code`                         |                                                                                 |
| 4   | which model (empty for the runtime's own default)                                                       | Enter                                 |                                                                                 |
| 5   | does a cold reviewer read it, and which agent (…, or none)                                              | `claude-code`                         |                                                                                 |
| 6   | on which model (empty for the runtime's own default)                                                    | Enter                                 |                                                                                 |
| 7   | the install command                                                                                     | Enter if it offers a `pnpm install …` |                                                                                 |
| 8   | run these before review? yes, or no to write your own                                                   | `yes` if it lists `pnpm test`         | nanoid's `test` runs its `test:*` scripts                                       |
| 8a  | a command that must pass before review — empty when done                                                | `pnpm test` ⏎, then an empty line ⏎   | only if 8 is not asked: nothing was detected                                    |
| 9   | run these once against the base before writing them?                                                    | `yes`                                 | the trial build                                                                 |
| 10  | where this project's tickets come from — github (this repository's issues), or db (Lingtai's own table) | `github`                              |                                                                                 |
| 11  | which labels are work, comma-separated, first = taken first                                             | Enter                                 | `bug, feature, documentation`                                                   |
| 12  | land this on which branch, or "hold" to hold every pass for a person                                    | `hold`                                |                                                                                 |
| 13  | how many times a pass sends the agent back …                                                            | Enter                                 |                                                                                 |
| 14  | what one agent run may take, like 30m or 2h                                                             | Enter                                 |                                                                                 |
| 15  | a dollar ceiling per agent run, like $5, or "none" for no ceiling                                       | Enter                                 |                                                                                 |
| 16  | register with the checks and landing above?                                                             | `yes`                                 | if asked                                                                        |

If it asks how this machine reaches GitHub, answer `gh`: C.5 already chose it,
so being asked again is itself a finding.

*C.7 output:*

```paste
❯ date
  lingtai add $FORK
  date
Thu Oct 29 23:52:47 CDT 2026
│
◇  use every default?
│  no
which agent's pass this is
which agent writes the change
which agent, if any, reads it cold before it moves on
│
◇  which agent writes the change (claude-code, codex)
│  claude-code
│
◇  which model (empty for the runtime's own default)
│
│
◇  does a cold reviewer read it, and which agent (claude-code, codex, or none)
│  pnpm install
pnpm install is not a runtime — sign in to it, or choose one of claude-code, codex, or none
│
◇  does a cold reviewer read it, and which agent (claude-code, codex, or none)
│  claude-code
│
◇  on which model (empty for the runtime's own default)
│
getting the worktree ready before the agent starts
what must pass before review
install: pnpm install --frozen-lockfile — pnpm-lock.yaml is at the root
build (test): pnpm test — `test` runs `pnpm run /^test:/`
│
◇  the install command
│  pnpm install
│
◇  run these before review? yes, or no to write your own
│  yes
│
◇  run these once against the base before writing them?
│  yes
running the trial build — this can take minutes
cutting a throwaway worktree at main — the first time this clones the repository
where this project's tickets live
│
◇  where this project's tickets come from — github (this repository's
│  issues), or db (Lingtai's own table)
│  github
tickets       github
which labels are work, most wanted first
│
◇  which labels are work, comma-separated, first = taken first
│  bug, feature, documentation
kinds         bug, feature, documentation
what the agent's environment is filtered to
the branch this project governs, and where it pushes
what happens once a pass is ready to land
│
◇  land this on which branch, or "hold" to hold every pass for a person
│  hold
landing       hold — every pass stops at proposed for a person
what one pass may spend before it comes back to you
│
◇  how many times a pass sends the agent back — 0 means every refusal goes straight to
 you
│  2
│
◇  what one agent run may take, like 30m or 2h
│  2h
│
◇  a dollar ceiling per agent run, like $5, or "none" for no ceiling
│  none
  a pass    up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
Before registering nanoid
  checks   pnpm test
  review   claude-code
  landing  held — every pass stops at proposed for a person
  change   lingtai add steven-zhc/nanoid
A role with no model is priced by the model its runtime reports on the first run.
github       gh — github.auth
│
reading /Users/steven/lingtai-trial/c/nanoid/recipe.yml — the recipe is this machine's, and nothing is read from the repository (0046 §3)
base: main — the recipe's repo.base
  runtime.agent            claude-code ← /Users/steven/lingtai-trial/c/nanoid/recipe.yml
  runtime.limits.turns     300 ← default
  runtime.limits.wall      2h ← default
  runtime.limits.rounds    2 ← default
  runtime.limits.restarts  0 ← default
  runtime.limits.usd       (none) ← default
  steps.implement.agent    claude-code ← /Users/steven/lingtai-trial/c/nanoid/recipe.yml
  steps.review.agent       claude-code ← /Users/steven/lingtai-trial/c/nanoid/recipe.yml
  runtime.budget.evidence  2000 ← default
  runtime.budget.attempts  5 ← default
  runtime.budget.findings  5 ← default
  runtime.budget.diff      400000 ← default
  runtime.assignee.take    both ← default
  runtime.assignee.login   (none) ← default
recipe: /Users/steven/lingtai-trial/c/nanoid/recipe.yml for main@35ea7d0 — hash ded28c60186b
  claim     (skipped)
  admit     (skipped)
  prepared  install
  design    (skipped)
  implement write the change
  build     test
  review    review
  proposed  hold every pass
  merge     (skipped)
  end       (skipped)
  a pass    up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
  runtime claude-code, kinds bug > feature > documentation
  tier guarded
added nanoid — tier guarded, 5 action(s) across 5 steps
Fri Oct 30 00:09:25 CDT 2026

```

- [x] **C.7-a** Only the questions it must ask. The base branch is detected.
- [x] **C.7-b** Install and build are detected for pnpm (`pnpm install …` and the
  repository's test script).
- [ ] **C.7-c** The trial build runs and reports, and it leaves no worktree behind (the
  board's run log, or `lingtai doctor --verbose`, shows where it ran; that
  directory is gone afterwards).
- [ ] **C.7-d** No output cites an ADR, an issue number or a source path.
  → Yes: the base was not asked (detected, "base: main — the recipe's repo.base"), and nothing about the store or machine.
  → Yes: "install: pnpm install --frozen-lockfile — pnpm-lock.yaml is at the root", "build (test): pnpm test". (The operator typed `pnpm install` over the offered install.)
  → **Runs, does not report** (B4 again); whether it left a worktree was not checked. `add` took 23:52:47 → 00:09:25.
  → **No**: "reading …/nanoid/recipe.yml — the recipe is this machine's, and nothing is read from the repository (0046 §3)" (C2).

**C.8**

```fish
lingtai doctor
lingtai doctor --verbose | grep -i -A2 'github'
```

*C.8 output:*

```paste
❯ lingtai doctor
  lingtai doctor --verbose | grep -i -A2 'github'
doctor

all 28 passed · 11 not checked here · 3 not implemented yet
        a checkout, not an installed copy — git pull is its upgrade, and GitHub was not asked
Store and log
  ✓     store: the machine's written choice <0.1s
--
GitHub
  ✓     github: what we said and did not manage <0.1s
        every issue carries what the log last said about it
  ✓     github: gh login 0.3s
        gh is signed in to github.com as steven-zhc with repo and workflow
  skip  github: app credentials 0.3s
        github.auth is gh — the App is not used for projects, so its credentials are not checked.
Runtimes
  ✓     runtime: nanoid limits 0.3s
--
  skip  github: installation and labels <0.1s
        per repository: lingtai add checks the App's permissions before it records anything, so the gap a startup check would look for stops the one command that can act on it. Labels are computed from the work item's state and written whole, and reconcile converges what did not land (#69) — so label drift has an owner rather than needing a check here
```

- [x] **C.8-a** `github: gh login` reads `ok` and names the trial account (#707).
  → Yes: "gh is signed in to github.com as steven-zhc with repo and workflow".

**The board under `gh` (#713).**

**Terminal 3**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai board` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

**C.9**

```fish
set -gx ROUND c
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx FORK (gh api user --jq .login)/nanoid
echo $LINGTAI_HOME
lingtai board start --port 17830
```

output

```sh
/Users/steven/lingtai-trial/
▲ Next.js 16.3.3
- Local:         http://127.0.0.1:17830
- Network:       http://127.0.0.1:17830
✓ Ready in 0ms
✓ Running next.config took 1.3ms
✓ board on http://127.0.0.1:17830
it serves in this terminal — ctrl-c stops it. Under lingtai service it is a job: pnpm lingtai board stop
```

- [ ] C.9-a** The board's first step asks for no App. Screenshot:
  `doc/img/016/c-board-first.png`.
- [ ] **C.9-b** Its add-repository page points to `lingtai add`. Screenshot:
  `doc/img/016/c-board-add.png`.
  → **Not done**, as C.9-a.

**The ticket:**

**C.10**

```fish
date
gh issue create -R $FORK --label feature \
  --title 'Test that the default id is 21 characters long' \
  --body 'Add one test asserting that nanoid() with no argument returns a string of length 21. Change no library code. Done when the repository test script passes.'
```

*C.10 output:*

```paste
Fri Oct 30 00:12:58 CDT 2026

Creating issue in steven-zhc/nanoid

https://github.com/steven-zhc/nanoid/issues/1
```

- Issue: `#__1__`. Opened at: `__Fri Oct 30 00:12:58 CDT 2026__`

**Run.**

**Terminal 2**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai start` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

**C.11**

```fish
set -gx ROUND c
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx FORK (gh api user --jq .login)/nanoid
echo $LINGTAI_HOME
lingtai start
```

Then approve when the card reaches Waiting on you:

Output:

```shell
/Users/steven/lingtai-trial/c
task_view	following at 1/1
finding_backlog	following at 1/1
spend	following at 1/1
ticket_report	following at 1/1
daemon up — 4 projection(s)
✓ started
running an unrecorded commit — lingtai doctor says how far behind that is
nanoid         recipe ded28c60186b from main
  picks up     bug > feature > documentation   (in priority order)
  excludes     nothing
  assignee     any issue, whoever it is assigned to
  a pass       up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
  retries      after 1h, unless a repair is pending
subscribers: nanoid declares none — nothing about it is told to anybody (recipe: subscribers:)
taking ticket-nanoid-1 — Test that the default id is 21 characters long
recipe ded28c60186b from main, tier guarded
env: nothing declared
claimed ticket-nanoid-1 as pass-3ea46c86-5842-4bcf-958c-30f6aeecc1c4
worktree /Users/steven/lingtai-trial/c/worktrees/nanoid/pass-3ea46c86-5842-4bcf-958c-30f6aeecc1c4 at 35ea7d0

```

**C.12**

```fish
lingtai status --all
lingtai approve nanoid --issue 1
date
lingtai status --all
```

*C.12 output:*

```paste
❯ lingtai status --all
Spend
  today $0.24 + ~$0.00 est. + 0 unknown — no daily ceiling (limits.day_usd)

nanoid

Project
  base      main
  recipe    ded28c60186b from main
  picks up  bug > feature > documentation   (in priority order)
  excludes  nothing
  assignee  any issue, whoever it is assigned to
  a pass    up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
  retries   after 1h, unless a repair is pending

Queue  0 runnable — 1 running
  from GitHub: 1 eligible
  ID  KIND     TITLE                                           STATE
  #1  feature  Test that the default id is 21 characters long  [verifying]

steven in 🌐 foundry in ~
❯ lingtai approve nanoid --issue 1
✓ approved ticket-nanoid-1
  79d968b by human:steven — continues at proposed

steven in 🌐 foundry in ~
❯ date
  lingtai status --all
Fri Oct 30 00:16:16 CDT 2026
Spend
  today $0.53 + ~$0.00 est. + 0 unknown — no daily ceiling (limits.day_usd)

nanoid

Project
  base      main
  recipe    ded28c60186b from main
  picks up  bug > feature > documentation   (in priority order)
  excludes  nothing
  assignee  any issue, whoever it is assigned to
  a pass    up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
  retries   after 1h, unless a repair is pending

Queue  0 runnable — 1 landed
  from GitHub: 1 eligible
  ID  KIND     TITLE                                           STATE
  #1  feature  Test that the default id is 21 characters long  [landed]

```

- [x] **C.12-a** **The first push and the merge succeed with the `gh` token** (the `gho_`
  token in the `x-access-token` header, #706). There is no auth error
  anywhere in terminal 2.
  → Yes: #1 went to `[landed]` after `approve` (00:16:16), and `main` on the fork has the commits (C.13).

**Whose name is on what (0114 §8):**

**C.13**

```fish
gh issue view 1 -R $FORK --comments
gh api repos/$FORK/issues/<n>/events --jq '.[] | "\(.event)  \(.actor.login)"'
gh api repos/$FORK/commits --jq '.[0:3][] | "\(.sha[0:8])  author=\(.commit.author.name) <\(.commit.author.email)>  committer=\(.commit.committer.name)"'
git config user.name
git config user.email
```

*C.13 output:*

```paste
❯ gh issue view 1 -R $FORK --comments
  gh api repos/$FORK/issues/<n>/events --jq '.[] | "\(.event)  \(.actor.login)"'
  gh api repos/$FORK/commits --jq '.[0:3][] | "\(.sha[0:8])  author=\(.commit.author.name) <\(.commit.author.email)>  committer=\(.commit.committer.name)"'
  git config user.name
  git config user.email
Test that the default id is 21 characters long steven-zhc/nanoid#1
Open • steven-zhc opened about 4 minutes ago • 1 comment
Labels: feature


  Add one test asserting that nanoid() with no argument returns a string of length
  21. Change no library code. Done when the repository test script passes.


steven-zhc (Owner) • 2m • Newest comment

  Lingtai is waiting on you.

  the  proposed  step held: Land this? The setup was answered 'hold'.

View the full review: https://github.com/steven-zhc/nanoid/issues/1#issuecomment-6515554493


View this issue on GitHub: https://github.com/steven-zhc/nanoid/issues/1
warning: An error occurred while redirecting file 'n'
warning: Path 'n' does not exist
warning: An error occurred while redirecting file '/events'
open: Read-only file system
102a6b5a  author=Haichao Zhang <steven.zhang031@gmail.com>  committer=Haichao Zhang
79d968be  author=Haichao Zhang <steven.zhang031@gmail.com>  committer=Haichao Zhang
35ea7d02  author=Andrey Sitnik <andrey@sitnik.es>  committer=Andrey Sitnik
Haichao Zhang
steven.zhang031@gmail.com
```

- [x] **C.13-a** Labels, comments and the merge show the `gh` account.
- [x] **C.13-b** The commits show this machine's git identity (`git config` above).
  → Yes for labels and comments: every event on #1 is by steven-zhc (`labeled feature`, `lingtai:working`, `lingtai:waiting`, …, read with `gh api …/issues/1/events` after the round), and the comment "Lingtai is waiting on you." is steven-zhc's. The merge is a `git push`, not a GitHub merge, so it has no actor to show.
  → Yes: `102a6b5a` and `79d968be` are "author=Haichao Zhang <steven.zhang031@gmail.com>", the machine's `git config`.

**Measure:**

**C.14**

```fish
lingtai report --window today
```

*C.14 output:*

```paste
report for 2026-10-30

tickets
  landed  1
  closed  0
  open    0

landed tickets (1)
  passes                mean 1 · median 1
  fix rounds            mean 0 · median 0
  waits                 mean 1 · median 1
  machine time          mean 1m · median 1m
  cost                  mean $0.53 reported · median $0.53
  0 or 1 fix rounds     100%
  5 or more fix rounds  0%

getting past review
  review  at risk  passed  censored  not yet past
  1       1        1       0         0%

spend in the window
  $0.53 reported

by kind
  kind                  feature
  landed                1
  median fix rounds     0
  0 or 1                100%
  5 or more             0%
  mean cost per landed  mean $0.53 reported · median $0.53
  spend                 $0.53 reported

most fix rounds
  ticket-nanoid-1  feature  landed  $0.53 reported
    100% work over 0 fix rounds · 1 pass · waited once (SignoffRequired)
    spent on: Work 100%
    wait: SignoffRequired · cause — · resolved Approve
```

- [x] **C.14-a** `status`, `/spend` and `/report` show the run; an unknown run names its
  reason (#692).
  → Yes for `status` and `report` ($0.53 reported, 0 unknown); `/spend` and `/report` were not captured.

**Signed out afterwards, doctor fails by name (#707):**

**C.15**

```fish
gh auth logout --hostname github.com
lingtai doctor
echo "exit: $status"
```

*C.15 output:*

```paste

```

- [x] **C.15-a** `github: gh login` fails, by that name, with a fix.
  → Yes (pasted under C.16 output): "PROBLEM ✗ gh is not signed in to github.com · github / FIX gh auth login".

Sign back in **without `workflow`** for round D:

**C.16**

```fish
gh auth login --hostname github.com --web
gh auth status
```

*C.16 output:*

```paste
❯ gh auth logout --hostname github.com
  lingtai doctor
  echo "exit: $status"
✓ Logged out of github.com account steven-zhc
doctor

2 to fix · 26 passed · 11 not checked here · 3 not implemented yet

 PROBLEM  ✗ gh is not signed in to github.com  · github
          gh has no github.com account
     FIX  gh auth login

 PROBLEM  the daemon cannot say which commit it runs  · daemon
          the running daemon recorded no commit
     FIX  lingtai restart "picking up main"

    NEXT  lingtai doctor --verbose
exit: 1
```

- [ ] **C.16-a** `gh auth status`'s token scopes do not include `workflow`.
  → **Not run**: `gh` is signed out now, so round D starts without the login it needs (D.1).


## Round C summary (2026-10-30)

**Result.** A GitHub project through the operator's own `gh` login works end
to end: `init` signed `gh` in, `add` registered `steven-zhc/nanoid` with
install and checks detected, #1 went from opened (00:12:58) to landed
(00:16:16) in **4 min, 1 min of it machine time, $0.53, 0 fix rounds**, the
push and merge went through on the `gh` token, everything on GitHub is
steven-zhc's and the commits are the machine's git identity. Doctor fails by
name once `gh` is signed out.

**Not tested**: the Ctrl+C during sign-in (C.3, C.4), the headless refusal
(C.2-a), the board under `gh` (C.9: it ran in round B's home), and the
sign-in without `workflow` that round D needs (C.16). Before D.1: sign in
without `workflow`, i.e. run C.16 first.

**Round C stuck:**

- **C2. `add` on a GitHub repository ends in a dump, and cites an ADR.**
  After "Before registering nanoid" it printed "github gh — github.auth", then
  "reading /Users/steven/lingtai-trial/c/nanoid/recipe.yml — the recipe is this
  machine's, and nothing is read from the repository **(0046 §3)**", then every
  resolved setting (`runtime.budget.evidence 2000 ← default`,
  `runtime.assignee.take both ← default`, …), then the ten steps with
  "(skipped)", and only then "added nanoid". #703 is that `add` prints no ADR.
  The local `add` (B.12) printed none of this.
- **C3. doctor calls the installed binary a checkout.** `doctor --verbose`:
  "a checkout, not an installed copy — git pull is its upgrade, and GitHub was
  not asked". This is the v0.10.0 binary in `~/.local/bin`. With A13 and B6,
  the third place the binary is taken for a source checkout.
- **C4. doctor's verbose view cites an issue, and one title says nothing.**
  "skip github: installation and labels … reconcile converges what did not
  land **(#69)**"; and a check titled "github: what we said and did not
  manage".
- **C5. A landed GitHub issue stays open and says nothing about landing.**
  After `[landed]`, #1 is still open, labelled only `feature`; its last event
  is "unlabeled lingtai:working", and its one comment is "Lingtai is waiting on
  you." Someone reading GitHub cannot tell the work is on `main`.
- **C6. A wrong answer to the reviewer question is told to sign in.** Typed
  `pnpm install` at "does a cold reviewer read it, and which agent": "pnpm
  install is not a runtime — sign in to it, or choose one of claude-code,
  codex, or none". It is not something one can sign in to (with B8, B10: the
  runtime messages say "sign in" for every kind of wrong).
- **C7. The doc's own commands**: C.13's `<n>` was run as written, and fish
  read it as a redirect ("An error occurred while redirecting file 'n'"), so
  the events were not shown in the paste (read afterwards over ssh). The
  How-to says to replace `<n>`; a variable (`set -gx ISSUE 1`) would be safer.
- **C8. The board ran in the wrong home, and did not say so.** At 00:10 a
  board on 17830 was started in a terminal still set to round B: it recreated
  `~/lingtai-trial/b` with only `locks/` in it (removed after the round). A
  board started in a home with no `config.yml` served anyway.

- **C1. Ctrl+C at the project question leaves a half-set-up home, and says
  only what it did not write.** After "stopped at the question — its answer
  was not written, and running the command again asks it here", the home held
  `config.yml` (the store, chosen by `--store sqlite`) and a `lingtai.db`
  with its WAL. That is `init` being resumable ("Run it again to continue",
  `doc/cli.md`), and the sentence is true; but a person who pressed Ctrl+C to
  back out is not told that the store was kept, or how to start clean. Not a
  bug; a sentence: "kept: the store (SQLite at …). Delete … to start over."

- 

**Stop round C**: Ctrl+C in terminals 2 and 3. Close the board's browser page first: while a page is open, Ctrl+C does not stop the board (A10).

**Clean up round C**, after its stuck lines are written down. Stop
its processes first (above). In any terminal:

**C.17**

```fish
set -gx ROUND c
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx TRIAL_SRC $HOME/lingtai-trial/src
lsof -nP -iTCP:17830 -sTCP:LISTEN
lsof +D $LINGTAI_HOME 2>/dev/null | head -5
mkdir -p $HOME/lingtai-trial-archive
tar -czf $HOME/lingtai-trial-archive/round-$ROUND.tgz -C $HOME/lingtai-trial $ROUND
rm -rf $LINGTAI_HOME
find $TRIAL_SRC -maxdepth 1 -name "ticket-$ROUND*.md" -delete
ls $HOME/lingtai-trial $TRIAL_SRC $HOME/lingtai-trial-archive
```

*C.17 output:*

```paste
/Users/steven/lingtai-trial:
b/	gh/	src/

/Users/steven/lingtai-trial-archive:
round-a.tgz	round-b.tgz	round-c.tgz

/Users/steven/lingtai-trial/src:
```

- [ ] **C.17-a** Both `lsof` lines printed nothing: no board on 17830, and no process
  holding a file in this round's home. If one did, stop it before `rm`.
- [x] **C.17-b** `round-c.tgz` is in the archive, and `$HOME/lingtai-trial` holds no
  `c/`.
  → **Not pasted.** Done: `round-c.tgz` is in the archive and `~/lingtai-trial/c` is gone.
  → Yes (checked over ssh after the round).
