# 016 · Round C — a fork of `ai/nanoid`, Node / pnpm, GitHub through `gh`

Part of [016, the v0.10.0 first-time path](../016-the-v0.10.0-first-time-path.md): how to fill this in, the shared environment ([0.4](../016-the-v0.10.0-first-time-path.md#04-a-clean-state-every-terminal)), the Record and After are there.

This round also carries **the once-only `gh` checks**. Do them in the order
written, because each one sets up the state the next one needs.

**Terminal 1**. **A new terminal for this round, or set it again here.** A terminal left from the last round still has its `ROUND`, and `init` then runs in that round's home: in round B it printed `home /Users/steven/lingtai-trial/a` and asked nothing (B1). `echo $LINGTAI_HOME` must print this round's letter.

```fish
set -gx ROUND c
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
mkdir -p $LINGTAI_HOME $TRIAL_SRC
echo $LINGTAI_HOME
gh auth status
```

```paste

```

- [ ] It says you are not logged in. That is expected, because
  `$GH_CONFIG_DIR` is new. If it shows a login, the export did not take.

**`--defaults` with no `--project` refuses at once (#700).** Use a throwaway
home so that a refusal which writes something cannot spoil this round's:

```fish
env LINGTAI_HOME=$HOME/lingtai-trial/c-defaults lingtai init --store sqlite --defaults
echo "exit: $status"
ls -la $HOME/lingtai-trial/c-defaults
```

(`$status` is fish's exit code of the command before it.)

```paste

```

- [ ] It refuses immediately, by name, with a non-zero exit, and no browser
  opened.

**Signed out: `init` offers to sign in, and Ctrl+C returns to the choice
(#712):**

```fish
lingtai init --store sqlite --project github --port 17830
```

When it asks how to reach GitHub, choose the `gh` login. It offers to sign in:
accept. It hands the terminal to `gh auth login --web`. **Press Ctrl+C before
finishing in the browser.**

```paste

```

- [ ] Ctrl+C returns you to the choice and does not end `init`.

Now quit `init` (Ctrl+C at the choice) and check that nothing was written:

```fish
gh auth status
cat $LINGTAI_HOME/config.yml
```

```paste

```

- [ ] There is no `gh` login, and `config.yml` has no GitHub key.

**Signed out, completing the sign-in:**

```fish
lingtai init --store sqlite --project github --port 17830
```

Choose `gh`, accept the sign-in, and complete it in the browser this time:

```paste

```

- [ ] `init` continues on its own after the browser step.
- [ ] Doctor's short view is readable (#701), and init ends with a single
  `next:` line (#702). No output cites an ADR, an issue number or a source
  path (#703).

**The fork.** Forks have issues turned off, and Lingtai's tickets here are
issues:

```fish
gh repo fork ai/nanoid --clone=false
set -gx FORK (gh api user --jq .login)/nanoid
gh repo edit $FORK --enable-issues
gh repo view $FORK --json defaultBranchRef --jq .defaultBranchRef.name
gh label create feature -R $FORK --color 0e8a16 --force
```

```paste

```

**Add it, interactively, letting it detect:**

```fish
date
lingtai add $FORK
date
```

Answer: tickets **github**, agent and reviewer **claude-code**, landing
**hold**, trial build **yes**. If it insists on `--base`, give it the default
branch printed above and write that down as stuck.

```paste

```

- [ ] Only the questions it must ask. The base branch is detected.
- [ ] Install and build are detected for pnpm (`pnpm install …` and the
  repository's test script).
- [ ] The trial build runs and reports, and it leaves no worktree behind (the
  board's run log, or `lingtai doctor --verbose`, shows where it ran; that
  directory is gone afterwards).
- [ ] No output cites an ADR, an issue number or a source path.

```fish
lingtai doctor
lingtai doctor --verbose | grep -i -A2 'github'
```

```paste

```

- [ ] `github: gh login` reads `ok` and names the trial account (#707).

**The board under `gh` (#713).**

**Terminal 3**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai board` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

```fish
set -gx ROUND c
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx FORK (gh api user --jq .login)/nanoid
echo $LINGTAI_HOME
lingtai board start --port 17830
```

- [ ] The board's first step asks for no App. Screenshot:
  `doc/img/016/c-board-first.png`.
- [ ] Its add-repository page points to `lingtai add`. Screenshot:
  `doc/img/016/c-board-add.png`.

**The ticket:**

```fish
date
gh issue create -R $FORK --label feature \
  --title 'Test that the default id is 21 characters long' \
  --body 'Add one test asserting that nanoid() with no argument returns a string of length 21. Change no library code. Done when the repository test script passes.'
```

```paste

```

- Issue: `#____`. Opened at: `____`

**Run.**

**Terminal 2**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai start` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

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

```fish
lingtai status --all
lingtai approve <project> --issue <n>
date
lingtai status --all
```

```paste

```

- [ ] **The first push and the merge succeed with the `gh` token** (the `gho_`
  token in the `x-access-token` header, #706). There is no auth error
  anywhere in terminal 2.

**Whose name is on what (0114 §8):**

```fish
gh issue view <n> -R $FORK --comments
gh api repos/$FORK/issues/<n>/events --jq '.[] | "\(.event)  \(.actor.login)"'
gh api repos/$FORK/commits --jq '.[0:3][] | "\(.sha[0:8])  author=\(.commit.author.name) <\(.commit.author.email)>  committer=\(.commit.committer.name)"'
git config user.name
git config user.email
```

```paste

```

- [ ] Labels, comments and the merge show the `gh` account.
- [ ] The commits show this machine's git identity (`git config` above).

**Measure:**

```fish
lingtai report --window today
```

```paste

```

- [ ] `status`, `/spend` and `/report` show the run; an unknown run names its
  reason (#692).

**Signed out afterwards, doctor fails by name (#707):**

```fish
gh auth logout --hostname github.com
lingtai doctor
echo "exit: $status"
```

```paste

```

- [ ] `github: gh login` fails, by that name, with a fix.

Sign back in **without `workflow`** for round D:

```fish
gh auth login --hostname github.com --web
gh auth status
```

```paste

```

- [ ] `gh auth status`'s token scopes do not include `workflow`.

**Round C stuck:**

- 

**Stop round C**: Ctrl+C in terminals 2 and 3. Close the board's browser page first: while a page is open, Ctrl+C does not stop the board (A10).

**Clean up round C**, after its stuck lines are written down. Stop
its processes first (above). In any terminal:

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

```paste

```

- [ ] Both `lsof` lines printed nothing: no board on 17830, and no process
  holding a file in this round's home. If one did, stop it before `rm`.
- [ ] `round-c.tgz` is in the archive, and `$HOME/lingtai-trial` holds no
  `c/`.
