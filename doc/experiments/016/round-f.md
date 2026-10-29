# 016 · Round F (if there is time) — a fork of `dtolnay/itoa`, Rust, commands typed

Part of [016, the v0.10.0 first-time path](../016-the-v0.10.0-first-time-path.md): how to fill this in, the shared environment ([0.4](../016-the-v0.10.0-first-time-path.md#04-a-clean-state-every-terminal)), the Record and After are there.

As in round E, with `cargo fetch` for install and `cargo test` for build. Its
default branch is `master`. **Write down the trial build's time**: it is a cold
compile, and the minutes a new user waits in silence are what matter here.

**Terminal 1**. **A new terminal for this round, or set it again here.** A terminal left from the last round still has its `ROUND`, and `init` then runs in that round's home: in round B it printed `home /Users/steven/lingtai-trial/a` and asked nothing (B1). `echo $LINGTAI_HOME` must print this round's letter.

**F.1**

```fish
set -gx ROUND f
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
mkdir -p $LINGTAI_HOME $TRIAL_SRC
echo $LINGTAI_HOME
gh repo fork dtolnay/itoa --clone=false
set -gx FORK (gh api user --jq .login)/itoa
gh repo edit $FORK --enable-issues
gh label create feature -R $FORK --color 0e8a16 --force
lingtai init --store sqlite --project github --port 17830
date
lingtai add $FORK
date
```

*F.1 output:*

```paste

```

- Cold trial build, start → report: `____ min`. Any stretch with no output
  longer than 30 s: `____`

**F.2**

```fish
gh issue create -R $FORK --label feature \
  --title 'Test that u128::MAX formats correctly' \
  --body 'Add one test asserting itoa::Buffer::new().format(u128::MAX) equals u128::MAX.to_string(). Change no library code. Done when cargo test passes.'
```

**Terminal 2**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai start` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

**F.3**

```fish
set -gx ROUND f
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx FORK (gh api user --jq .login)/itoa
echo $LINGTAI_HOME
lingtai start
```

When the card is waiting on you, in terminal 1:

**F.4**

```fish
lingtai status --all
lingtai approve <project> --issue <n>
lingtai report --window today
```

*F.4 output:*

```paste

```

**Round F stuck:**

- 

**Stop round F**: Ctrl+C in terminal 2.

**Clean up round F**, after its stuck lines are written down. Stop
its processes first (above). In any terminal:

**F.5**

```fish
set -gx ROUND f
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

*F.5 output:*

```paste

```

- [ ] **F.5-a** Both `lsof` lines printed nothing: no board on 17830, and no process
  holding a file in this round's home. If one did, stop it before `rm`.
- [ ] **F.5-b** `round-f.tgz` is in the archive, and `$HOME/lingtai-trial` holds no
  `f/`.
