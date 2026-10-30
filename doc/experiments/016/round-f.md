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

**`init` first** (this round's home is new; `gh` is signed in with `workflow`
since D.1):

| # | It asks | Answer |
|---|---|---|
| 1 | gh, signed in as steven-zhc — Lingtai's labels, comments, pull requests and pushes will appear as that account — or app, its own GitHub App | `gh` |

**Then `add`.** The project is named after the repository, `itoa`. Nothing
is detected for this stack, so the install and build are typed:

| # | It asks | Answer | Why |
|---|---|---|---|
| 1 | the branch this project's recipe governs and merges into | Enter if it offers `master` | if it insists on `--base`, write that down and give `master` |
| 2 | use every default? | `no` | `yes` refuses at the writer while Claude Code and Codex are both signed in (B8) |
| 3 | which agent writes the change (claude-code, codex) | `claude-code` |  |
| 4 | which model (empty for the runtime's own default) | Enter |  |
| 5 | does a cold reviewer read it, and which agent (…, or none) | `claude-code` |  |
| 6 | on which model (empty for the runtime's own default) | Enter |  |
| 7 | the install command | type `cargo fetch` ⏎ | nothing is detected, so there is nothing to take |
| 8 | run these before review? yes, or no to write your own | not asked | nothing is detected |
| 8a | a command that must pass before review — empty when done | `cargo test` ⏎, then an empty line ⏎ | one command per answer; the empty one ends the list |
| 9 | run these once against the base before writing them? | `yes` | the trial build |
| 10 | where this project's tickets come from — github … or db … | `github` |  |
| 11 | which labels are work, comma-separated, first = taken first | Enter | `bug, feature, documentation` |
| 12 | land this on which branch, or "hold" to hold every pass for a person | `hold` |  |
| 13 | how many times a pass sends the agent back … | Enter |  |
| 14 | what one agent run may take, like 30m or 2h | Enter |  |
| 15 | a dollar ceiling per agent run, like $5, or "none" for no ceiling | Enter |  |
| 16 | register with the checks and landing above? | `yes` | if asked |

A question not in this table is a finding: write it down with its words.

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
set -gx ISSUE (gh issue list -R $FORK --label feature --limit 1 --json number --jq '.[0].number')
echo \"issue: $ISSUE\"
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
lingtai approve itoa --issue $ISSUE
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
