# 016 · Round D — a fork of `pallets/itsdangerous`, Python / uv (#695, #336)

Part of [016, the v0.10.0 first-time path](../016-the-v0.10.0-first-time-path.md): how to fill this in, the shared environment ([0.4](../016-the-v0.10.0-first-time-path.md#04-a-clean-state-every-terminal)), the Record and After are there.

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

Choose the `gh` login.

*D.1 output:*

```paste

```

- [ ] **D.1-a** `init` notices the missing `workflow` scope and runs
  `gh auth refresh`, then continues.

**D.2**

```fish
gh auth status
```

*D.2 output:*

```paste

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

Answers as in round C.

*D.3 output:*

```paste

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
date
```

**Terminal 2**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai start` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

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

**D.7**

```fish
lingtai status --all
lingtai approve <project> --issue <n>
date
lingtai report --window today
```

*D.7 output:*

```paste

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

```

- [ ] **D.8-a** Both `lsof` lines printed nothing: no board on 17830, and no process
  holding a file in this round's home. If one did, stop it before `rm`.
- [ ] **D.8-b** `round-d.tgz` is in the archive, and `$HOME/lingtai-trial` holds no
  `d/`.
