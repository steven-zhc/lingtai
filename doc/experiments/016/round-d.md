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

| # | It asks | Answer |
|---|---|---|
| 1 | sign-in, to sign gh in now (`gh auth login …`) — or app, a GitHub App of its own | `sign-in` |
| 2 | (`gh auth login --web` takes the terminal and opens the browser) | **Ctrl+C**, do not finish in the browser |
| 3 | the same question again, if it returns to it (D.0a-b) | **Ctrl+C**, to leave `init` |

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

| # | It asks | Answer |
|---|---|---|
| 1 | first a line "github gh cannot be used yet — …" naming the missing `workflow` scope, then: sign-in, to sign gh in now (`gh auth refresh …`) — or app, a GitHub App of its own | `sign-in`, then finish in the browser |
| 2 | anything after the sign-in | write it down with its words |

The store and the project kind are not asked: `--store sqlite --project github`.
If the first line does not name `workflow`, or the command in it is not
`gh auth refresh`, that is D.1-a failing.

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

**The answers**, in the order `add` asks. The project is named after the
repository, `itsdangerous`.

| # | It asks | Answer | Why |
|---|---|---|---|
| 1 | the branch this project's recipe governs and merges into | Enter if it offers `main` | if it insists on `--base`, write that down and give `main` |
| 2 | use every default? | `no` | `yes` refuses at the writer while Claude Code and Codex are both signed in (B8) |
| 3 | which agent writes the change (claude-code, codex) | `claude-code` |  |
| 4 | which model (empty for the runtime's own default) | Enter |  |
| 5 | does a cold reviewer read it, and which agent (…, or none) | `claude-code` |  |
| 6 | on which model (empty for the runtime's own default) | Enter |  |
| 7 | the install command | Enter if it offers `uv sync` | #695: a uv project (`uv.lock` at the root) |
| 8 | run these before review? yes, or no to write your own | `yes` if it lists a `uv run pytest` | #695; write down exactly what it lists |
| 8a | a command that must pass before review — empty when done | `uv run pytest` ⏎, then an empty line ⏎ | only if 8 is not asked: nothing was detected, and D.3-a fails |
| 9 | run these once against the base before writing them? | `yes` | the trial build |
| 10 | where this project's tickets come from — github … or db … | `github` |  |
| 11 | which labels are work, comma-separated, first = taken first | Enter | `bug, feature, documentation` |
| 12 | land this on which branch, or "hold" to hold every pass for a person | `hold` |  |
| 13 | how many times a pass sends the agent back … | Enter |  |
| 14 | what one agent run may take, like 30m or 2h | Enter |  |
| 15 | a dollar ceiling per agent run, like $5, or "none" for no ceiling | Enter |  |
| 16 | register with the checks and landing above? | `yes` | if asked |

**Choice or typed**: a question drawn with ●/○ is a choice, answered with the
arrow keys and Enter. One drawn with an empty line is typed: type the answer
exactly as the table writes it, e.g. `claude-code`, and Enter. The agent and
model questions are typed (C9).

A question not in this table is a finding: write it down with its words.

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
set -gx ISSUE (gh issue list -R $FORK --label feature --limit 1 --json number --jq '.[0].number')
echo "issue: $ISSUE"
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
lingtai approve itsdangerous --issue $ISSUE
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
