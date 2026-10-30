# 016 · Round D — a fork of `pallets/itsdangerous`, Python / uv (#695, #336)

Part of [016, the v0.10.0 first-time path](../016-the-v0.10.0-first-time-path.md): how to fill this in, the shared environment ([0.4](../016-the-v0.10.0-first-time-path.md#04-a-clean-state-every-terminal)), the Record and After are there.

## Before D: what round C left out

Round C did not press Ctrl+C during the sign-in (C.3, C.4) and did not sign
back in without `workflow` (C.16). `gh` is signed out now, which is exactly
the state C.3 needs, so both happen here, in this order. A throwaway home,
`c-signin`, so nothing of round D's is touched.

**D.0a: Ctrl+C during the sign-in returns to the choice and writes nothing
(C.3, C.4, #712).** Choose the `gh` login, accept the sign-in, and when it hands
the terminal to `gh auth login --web`, **press Ctrl+C before finishing in the
browser**. Then Ctrl+C once more at the choice to leave `init`.

| #   | It asks                                                                          | Answer                                   |
| --- | -------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | sign-in, to sign gh in now (`gh auth login …`) — or app, a GitHub App of its own | `sign-in`                                |
| 2   | (`gh auth login --web` takes the terminal and opens the browser)                 | **Ctrl+C**, do not finish in the browser |
| 3   | the same question again, if it returns to it (D.0a-b)                            | **Ctrl+C**, to leave `init`              |

The store and the project kind are not asked: `--store sqlite --project github`.

```fish
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
env GH_CONFIG_DIR=$GH_CONFIG_DIR gh auth status
rm -rf $HOME/lingtai-trial/c-signin
env LINGTAI_HOME=$HOME/lingtai-trial/c-signin lingtai init --store sqlite --project github --port 17830
echo "exit: $status"
gh auth status
cat $HOME/lingtai-trial/c-signin/config.yml
```

*D.0a output:*

```paste
❯ set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
  env GH_CONFIG_DIR=$GH_CONFIG_DIR gh auth status
  rm -rf $HOME/lingtai-trial/c-signin
  env LINGTAI_HOME=$HOME/lingtai-trial/c-signin lingtai init --store sqlite --project github --port 17830
  echo "exit: $status"
  gh auth status
  cat $HOME/lingtai-trial/c-signin/config.yml
You are not logged into any GitHub hosts. To log in, run: gh auth login
init
│
Machine
  git          git version 2.50.1 (Apple Git-155)
  claude-code  signed in via claude.ai
  codex        Logged in using ChatGPT
  home         /Users/steven/lingtai-trial/c-signin — nothing yet
Store
  store  SQLite, /Users/steven/lingtai-trial/c-signin/lingtai.db ← /Users/steven/lingtai-trial/c-signin/config.yml
  SQLite is the whole log, in one file under ~/.lingtai — no server, and no second machine: nothing outside this one can read it, and switching stores later starts a new, empty log and moves nothing from this one
GitHub App
  app  none yet — the board's first screen creates it through GitHub's manifest flow
github       gh cannot be used yet — gh has no github.com account — run `gh auth login`
│
■  sign-in, to sign gh in now (`gh auth login --hostname github.com --web
│  --scopes workflow`) — or app, a GitHub App of its own
│  sign-in
│

stopped at the question — its answer was not written, and running the command again asks it here
exit: 130
You are not logged into any GitHub hosts. To log in, run: gh auth login
database:
  store: sqlite
```

- [ ] **D.0a-a** The first `gh auth status` says not logged in.
- [ ] **D.0a-b** Ctrl+C in the browser step returns to "how this machine
  reaches GitHub" and does not end `init`.
- [ ] **D.0a-c** After leaving, `gh auth status` still says not logged in, and
  `config.yml` has no `github` key (the store line is expected: C1).

**D.0b: sign in without `workflow` (C.16).** No `--scopes`, so the token has
`gh`'s default scopes and not `workflow`. Round D's first check needs exactly
that.

```fish
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
rm -rf $HOME/lingtai-trial/c-signin
gh auth login --hostname github.com --web
gh auth status
```

*D.0b output:*

```paste
❯ set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
  rm -rf $HOME/lingtai-trial/c-signin
  gh auth login --hostname github.com --web
  gh auth status
? What is your preferred protocol for Git operations on this host? SSH
? Upload your SSH public key to your GitHub account? /Users/steven/.ssh/id_ed25519.pub
? Title for your SSH key: GitHub CLI

! First copy your one-time code: 51D0-12E7
Press Enter to open https://github.com/login/device in your browser...
✓ Authentication complete.
- gh config set -h github.com git_protocol ssh
✓ Configured git protocol
! Authentication credentials saved in plain text
✓ SSH key already existed on your GitHub account: /Users/steven/.ssh/id_ed25519.pub
✓ Logged in as steven-zhc
github.com
  ✓ Logged in to github.com account steven-zhc (/Users/steven/lingtai-trial/gh/hosts.yml)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo'
```

- [ ] **D.0b-a** `gh auth status` shows the account, and its token scopes do
  not include `workflow`.

## Round D

**Terminal 1**. **A new terminal for this round, or set it again here.** A terminal left from the last round still has its `ROUND`, and `init` then runs in that round's home: in round B it printed `home /Users/steven/lingtai-trial/a` and asked nothing (B1). `echo $LINGTAI_HOME` must print this round's letter. `GH_CONFIG_DIR` is the same as round C's, now signed in without `workflow`.

**D.1**

```fish
set -gx ROUND d
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
mkdir -p $LINGTAI_HOME $TRIAL_SRC
echo $LINGTAI_HOME
lingtai init --store sqlite --project github --port 17830
```

| #   | It asks                                                                                                                                                                       | Answer                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| 1   | first a line "github gh cannot be used yet — …" naming the missing `workflow` scope, then: sign-in, to sign gh in now (`gh auth refresh …`) — or app, a GitHub App of its own | `sign-in`, then finish in the browser |
| 2   | anything after the sign-in                                                                                                                                                    | write it down with its words          |

The store and the project kind are not asked: `--store sqlite --project github`.
If the first line does not name `workflow`, or the command in it is not
`gh auth refresh`, that is D.1-a failing.

*D.1 output:*

```paste
❯ set -gx ROUND d
  set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
  set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
  set -gx TRIAL_SRC $HOME/lingtai-trial/src
  mkdir -p $LINGTAI_HOME $TRIAL_SRC
  echo $LINGTAI_HOME
  lingtai init --store sqlite --project github --port 17830
/Users/steven/lingtai-trial/d
init
│
Machine
  git          git version 2.50.1 (Apple Git-155)
  claude-code  signed in via claude.ai
  codex        Logged in using ChatGPT
  home         /Users/steven/lingtai-trial/d — no config.yml · no projects
Store
  store  SQLite, /Users/steven/lingtai-trial/d/lingtai.db ← /Users/steven/lingtai-trial/d/config.yml
  SQLite is the whole log, in one file under ~/.lingtai — no server, and no second machine: nothing outside this one can read it, and switching stores later starts a new, empty log and moves nothing from this one
GitHub App
  app  none yet — the board's first screen creates it through GitHub's manifest flow
github       gh cannot be used yet — gh is signed in as steven-zhc without workflow — run `gh auth refresh --hostname github.com --scopes workflow`
│
◇  sign-in, to sign gh in now (`gh auth refresh --hostname github.com
│  --scopes repo,workflow`) — or app, a GitHub App of its own
│  sign-in
github       handing the terminal to gh: gh auth refresh --hostname github.com --scopes repo,workflow

! First copy your one-time code: D5DB-338E
Press Enter to open https://github.com/login/device in your browser...
✓ Authentication complete.
github       gh, signed in as steven-zhc
the recipe is written once a repository is picked — it asks its questions at the terminal
next: lingtai add <owner>/<repo>
doctor

all 24 passed · 10 not checked here · 3 not implemented yet
Board
no board was started
```

- [ ] **D.1-a** `init` notices the missing `workflow` scope and runs
  `gh auth refresh`, then continues.

**D.2**

```fish
gh auth status
```

*D.2 output:*

```paste
github.com
  ✓ Logged in to github.com account steven-zhc (/Users/steven/lingtai-trial/gh/hosts.yml)
  - Active account: true
  - Git operations protocol: ssh
  - Token: gho_************************************
  - Token scopes: 'admin:public_key', 'gist', 'read:org', 'repo', 'workflow'

```

- [ ] **D.2-a** `workflow` is now among the scopes.

**The fork:**

**D.3**

```fish
gh repo fork pallets/itsdangerous --clone=false
set -gx FORK (gh api user --jq .login)/itsdangerous
gh repo edit $FORK --enable-issues
gh repo view $FORK --json defaultBranchRef --jq .defaultBranchRef.name
gh label create feature -R $FORK --color 0e8a16 --force
date
lingtai add $FORK
date
```

**The answers**, in the order `add` asks. The project is named after the
repository, `itsdangerous`.

| #   | It asks                                                              | Answer                                  | Why                                                                             |
| --- | -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | the branch this project's recipe governs and merges into             | Enter if it offers `main`               | if it insists on `--base`, write that down and give `main`                      |
| 2   | use every default?                                                   | `no`                                    | `yes` refuses at the writer while Claude Code and Codex are both signed in (B8) |
| 3   | which agent writes the change (claude-code, codex)                   | `claude-code`                           |                                                                                 |
| 4   | which model (empty for the runtime's own default)                    | Enter                                   |                                                                                 |
| 5   | does a cold reviewer read it, and which agent (…, or none)           | `claude-code`                           |                                                                                 |
| 6   | on which model (empty for the runtime's own default)                 | Enter                                   |                                                                                 |
| 7   | the install command                                                  | Enter if it offers `uv sync`            | #695: a uv project (`uv.lock` at the root)                                      |
| 8   | run these before review? yes, or no to write your own                | `yes` if it lists a `uv run pytest`     | #695; write down exactly what it lists                                          |
| 8a  | a command that must pass before review — empty when done             | `uv run pytest` ⏎, then an empty line ⏎ | only if 8 is not asked: nothing was detected, and D.3-a fails                   |
| 9   | run these once against the base before writing them?                 | `yes`                                   | the trial build                                                                 |
| 10  | where this project's tickets come from — github … or db …            | `github`                                |                                                                                 |
| 11  | which labels are work, comma-separated, first = taken first          | Enter                                   | `bug, feature, documentation`                                                   |
| 12  | land this on which branch, or "hold" to hold every pass for a person | `hold`                                  |                                                                                 |
| 13  | how many times a pass sends the agent back …                         | Enter                                   |                                                                                 |
| 14  | what one agent run may take, like 30m or 2h                          | Enter                                   |                                                                                 |
| 15  | a dollar ceiling per agent run, like $5, or "none" for no ceiling    | Enter                                   |                                                                                 |
| 16  | register with the checks and landing above?                          | `yes`                                   | if asked                                                                        |

**Choice or typed**: a question drawn with ●/○ is a choice, answered with the
arrow keys and Enter. One drawn with an empty line is typed: type the answer
exactly as the table writes it, e.g. `claude-code`, and Enter. The agent and
model questions are typed (C9).

A question not in this table is a finding: write it down with its words.

*D.3 output:*

```paste
gh repo fork pallets/itsdangerous --clone=false
  set -gx FORK (gh api user --jq .login)/itsdangerous
  gh repo edit $FORK --enable-issues
  gh repo view $FORK --json defaultBranchRef --jq .defaultBranchRef.name
  gh label create feature -R $FORK --color 0e8a16 --force
  date
  lingtai add $FORK
  date
! steven-zhc/itsdangerous already exists
✓ Edited repository steven-zhc/itsdangerous
main
✓ Label "feature" created in steven-zhc/itsdangerous
Fri Oct 30 10:17:02 CDT 2026
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
│  claude-code
│
◇  on which model (empty for the runtime's own default)
│
getting the worktree ready before the agent starts
what must pass before review
install: uv sync --frozen — uv.lock is at the root
build (format): uv run ruff format --check . — [tool.ruff] is in pyproject.toml
build (lint): uv run ruff check . — [tool.ruff] is in pyproject.toml
build (typecheck): uv run mypy . — [tool.mypy] is in pyproject.toml
build (test): uv run pytest — [tool.pytest.ini_options] is in pyproject.toml
│
◇  the install command
│  uv sync --frozen
│
◇  run these before review? yes, or no to write your own
│  no
│
◇  a command that must pass before review — empty when done
│   uv run pytest
│
◇  a command that must pass before review — empty when done
│
│
◇  run these once against the base before writing them?
│  yes
running the trial build — this can take minutes
cutting a throwaway worktree at main — the first time this clones the repository
where this project's tickets live
│
◇  where this project's tickets come from — github (this repository's issues), or db (Lingtai's own table)
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
◇  how many times a pass sends the agent back — 0 means every refusal goes straight to you
│  2
│
◇  what one agent run may take, like 30m or 2h
│  2h
│
◇  a dollar ceiling per agent run, like $5, or "none" for no ceiling
│  none
  a pass    up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
Before registering itsdangerous
  checks   uv run pytest
  review   claude-code
  landing  held — every pass stops at proposed for a person
  change   lingtai add steven-zhc/itsdangerous
A role with no model is priced by the model its runtime reports on the first run.
github       gh — github.auth
│
reading /Users/steven/lingtai-trial/d/itsdangerous/recipe.yml — the recipe is this machine's, and nothing is read from the repository (0046 §3)
base: main — the recipe's repo.base
  runtime.agent            claude-code ← /Users/steven/lingtai-trial/d/itsdangerous/recipe.yml
  runtime.limits.turns     300 ← default
  runtime.limits.wall      2h ← default
  runtime.limits.rounds    2 ← default
  runtime.limits.restarts  0 ← default
  runtime.limits.usd       (none) ← default
  steps.implement.agent    claude-code ← /Users/steven/lingtai-trial/d/itsdangerous/recipe.yml
  steps.review.agent       claude-code ← /Users/steven/lingtai-trial/d/itsdangerous/recipe.yml
  runtime.budget.evidence  2000 ← default
  runtime.budget.attempts  5 ← default
  runtime.budget.findings  5 ← default
  runtime.budget.diff      400000 ← default
  runtime.assignee.take    both ← default
  runtime.assignee.login   (none) ← default
recipe: /Users/steven/lingtai-trial/d/itsdangerous/recipe.yml for main@672971d — hash f68914aa4089
  claim     (skipped)
  admit     (skipped)
  prepared  install
  design    (skipped)
  implement write the change
  build     check-1
  review    review
  proposed  hold every pass
  merge     (skipped)
  end       (skipped)
  a pass    up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
  runtime claude-code, kinds bug > feature > documentation
  tier guarded
added itsdangerous — tier guarded, 5 action(s) across 5 steps
Fri Oct 30 10:21:03 CDT 2026
```

- [ ] **D.3-a** **Install and build are detected as uv** (#695): an install such as
  `uv sync` and a build such as `uv run pytest`. This box is #336's
  acceptance.
- [ ] **D.3-b** The base branch is detected; only the questions it must ask; the trial
  build runs and leaves no worktree; doctor's short view and one `next:`
  line; no ADR, issue number or source path in the output.

**Ticket, run, approve, measure:**

Terminal 1:

**D.4**

```fish
gh issue create -R $FORK --label feature \
  --title 'Test that URLSafeSerializer round-trips a non-ASCII string' \
  --body 'Add one test: URLSafeSerializer("secret").loads(s.dumps("héllo wörld ✓")) returns the same string. Change no library code. Done when the test suite passes.'
set -gx ISSUE (gh issue list -R $FORK --label feature --limit 1 --json number --jq '.[0].number')
echo "issue: $ISSUE"
date
```

**Terminal 2**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai start` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

```shell
Creating issue in steven-zhc/itsdangerous

https://github.com/steven-zhc/itsdangerous/issues/1
issue:
Fri Oct 30 10:21:36 CDT 2026
```

**D.5**

```fish
set -gx ROUND d
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx FORK (gh api user --jq .login)/itsdangerous
echo $LINGTAI_HOME
lingtai start
```

**Terminal 3**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai board` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

```shell
/Users/steven/lingtai-trial/d
task_view	following at 1/1
finding_backlog	following at 1/1
spend	following at 1/1
ticket_report	following at 1/1
daemon up — 4 projection(s)
✓ started
running an unrecorded commit — lingtai doctor says how far behind that is
itsdangerous   recipe f68914aa4089 from main
  picks up     bug > feature > documentation   (in priority order)
  excludes     nothing
  assignee     any issue, whoever it is assigned to
  a pass       up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
  retries      after 1h, unless a repair is pending
subscribers: itsdangerous declares none — nothing about it is told to anybody (recipe: subscribers:)
taking ticket-itsdangerous-1 — Test that URLSafeSerializer round-trips a non-ASCII string
recipe f68914aa4089 from main, tier guarded
env: nothing declared
claimed ticket-itsdangerous-1 as pass-6ee8b909-4e6a-4303-a99d-527a71e6ceb9
worktree /Users/steven/lingtai-trial/d/worktrees/itsdangerous/pass-6ee8b909-4e6a-4303-a99d-527a71e6ceb9 at 672971d

```

**D.6**

```fish
set -gx ROUND d
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx FORK (gh api user --jq .login)/itsdangerous
echo $LINGTAI_HOME
lingtai board start --port 17830
```

When the card is waiting on you, in terminal 1:

```shell
/Users/steven/lingtai-trial/d
▲ Next.js 16.3.3
- Local:         http://127.0.0.1:17830
- Network:       http://127.0.0.1:17830
✓ Ready in 0ms
✓ Running next.config took 1.6ms
✓ board on http://127.0.0.1:17830
it serves in this terminal — ctrl-c stops it. Under lingtai service it is a job: pnpm lingtai board stop
```

**D.7**

```fish
lingtai status --all
lingtai approve itsdangerous --issue $ISSUE
date
lingtai report --window today
```

*D.7 output:*

```paste
❯ lingtai status --all
  lingtai approve itsdangerous --issue $ISSUE
  date
  lingtai report --window today
Spend
  today $0.51 + ~$0.00 est. + 0 unknown — no daily ceiling (limits.day_usd)

itsdangerous

Project
  base      main
  recipe    f68914aa4089 from main
  picks up  bug > feature > documentation   (in priority order)
  excludes  nothing
  assignee  any issue, whoever it is assigned to
  a pass    up to 3 agent runs — the work, then 2 round(s) back to the agent carrying what refused it. 2h and 300 turns each, so at most 6h. A pass whose rounds are spent goes to you (runtime.limits.restarts: 0)
  retries   after 1h, unless a repair is pending

Queue  0 runnable
  from GitHub: 1 eligible
  ID  KIND     TITLE                                                       STATE
  #1  feature  Test that URLSafeSerializer round-trips a non-ASCII string  [waiting for your review]

Waiting on you
  ● #1  feature  Test that URLSafeSerializer round-trips a non-ASCII string — waiting for your review: the `proposed` step held: Land this? The setup was answered 'hold'.
      your judgement is needed
      the `proposed` step held: Land this? The setup was answered 'hold'.
      (the failure itself is on the log, and on the card)
'' is not a integer

Fri Oct 30 10:23:14 CDT 2026
report for 2026-10-30

tickets
  landed  0
  closed  0
  open    1

landed tickets (0)
  passes                mean — · median —
  fix rounds            mean — · median —
  waits                 mean — · median —
  machine time          mean — · median —
  cost                  mean — reported · median —
  0 or 1 fix rounds     —
  5 or more fix rounds  —

getting past review
  review  at risk  passed  censored  not yet past
  1       1        1       0         0%

spend in the window
  $0.51 reported

by kind
  kind     landed  median fix rounds  0 or 1  5 or more  mean cost per landed        spend
  feature  0       —                  —       —          mean — reported · median —  $0.51 reported

most fix rounds
  ticket-itsdangerous-1  feature  open  $0.51 reported
    100% work over 0 fix rounds · 1 pass · waited once (SignoffRequired)
    spent on: Work 100%
    wait: SignoffRequired · cause — · unresolved
```

- [ ] **D.7-a** One ticket landed; `status`, `/spend` and `/report` show it; an unknown
  run names its reason.

**Round D stuck:**

- 

**Stop round D**: Ctrl+C in terminals 2 and 3. Close the board's browser page first: while a page is open, Ctrl+C does not stop the board (A10).

**Clean up round D**, after its stuck lines are written down. Stop
its processes first (above). In any terminal:

**D.8**

```fish
set -gx ROUND d
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

*D.8 output:*

```paste
/Users/steven/lingtai-trial:
gh/	src/

/Users/steven/lingtai-trial-archive:
round-a.tgz	round-b.tgz	round-c.tgz	round-d.tgz

/Users/steven/lingtai-trial/src:
```

- [ ] **D.8-a** Both `lsof` lines printed nothing: no board on 17830, and no process
  holding a file in this round's home. If one did, stop it before `rm`.
- [ ] **D.8-b** `round-d.tgz` is in the archive, and `$HOME/lingtai-trial` holds no
  `d/`.
