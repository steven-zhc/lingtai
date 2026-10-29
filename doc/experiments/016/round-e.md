# 016 · Round E (if there is time) — a fork of `google/uuid`, Go, commands typed

Part of [016, the v0.10.0 first-time path](../016-the-v0.10.0-first-time-path.md): how to fill this in, the shared environment ([0.4](../016-the-v0.10.0-first-time-path.md#04-a-clean-state-every-terminal)), the Record and After are there.

Go has no detection yet (#696), so this round tests **typing the commands by
hand**. Use `init` with the same `GH_CONFIG_DIR`, or `--local` on a clone, and
write down which. Its default branch is `master`.

**Terminal 1**. **A new terminal for this round, or set it again here.** A terminal left from the last round still has its `ROUND`, and `init` then runs in that round's home: in round B it printed `home /Users/steven/lingtai-trial/a` and asked nothing (B1). `echo $LINGTAI_HOME` must print this round's letter.

```fish
set -gx ROUND e
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
mkdir -p $LINGTAI_HOME $TRIAL_SRC
echo $LINGTAI_HOME
gh repo fork google/uuid --clone=false
set -gx FORK (gh api user --jq .login)/uuid
gh repo edit $FORK --enable-issues
gh label create feature -R $FORK --color 0e8a16 --force
lingtai init --store sqlite --project github --port 17830
date
lingtai add $FORK
date
```

When asked, type install `go mod download` and build `go vet ./...`, then
`go test ./...`.

```paste

```

- [ ] With nothing detected, the questions say so and take typed commands
  without fuss; the trial build runs them.

```fish
gh issue create -R $FORK --label feature \
  --title 'Example for NewString' \
  --body 'Add an ExampleNewString function in example_test.go that prints the length of uuid.NewString() (36). Change no library code. Done when go test ./... passes.'
```

**Terminal 2**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai start` runs against `~/.lingtai` instead of this round's home, and `gh` with your everyday login.

```fish
set -gx ROUND e
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx GH_CONFIG_DIR $HOME/lingtai-trial/gh
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx FORK (gh api user --jq .login)/uuid
echo $LINGTAI_HOME
lingtai start
```

When the card is waiting on you, in terminal 1:

```fish
lingtai status --all
lingtai approve <project> --issue <n>
lingtai report --window today
```

```paste

```

**Round E stuck:**

- 

**Stop round E**: Ctrl+C in terminal 2.

**Clean up round E**, after its stuck lines are written down. Stop
its processes first (above). In any terminal:

```fish
set -gx ROUND e
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
- [ ] `round-e.tgz` is in the archive, and `$HOME/lingtai-trial` holds no
  `e/`.
