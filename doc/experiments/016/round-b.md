# 016 · Round B — Chapter Garden, local, Codex, interactive init

Part of [016, the v0.10.0 first-time path](../016-the-v0.10.0-first-time-path.md): how to fill this in, the shared environment ([0.4](../016-the-v0.10.0-first-time-path.md#04-a-clean-state-every-terminal)), the Record and After are there.

Same repository, fresh home, and **no flags**. Round A tested the tutorial's
command; this one tests what `init` asks a person who does not know the flags.

**Terminal 1**. **A new terminal for this round, or set it again here.** A terminal left from the last round still has its `ROUND`, and `init` then runs in that round's home: in round B it printed `home /Users/steven/lingtai-trial/a` and asked nothing (B1). `echo $LINGTAI_HOME` must print this round's letter.

```fish
set -gx ROUND b
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx TRIAL_SRC $HOME/lingtai-trial/src
mkdir -p $LINGTAI_HOME $TRIAL_SRC
echo $LINGTAI_HOME
set -gx CHAPTER_GARDEN_DIR $TRIAL_SRC/chapter-garden-b
git clone https://github.com/steven-zhc/chapter-garden.git $CHAPTER_GARDEN_DIR
git clone --bare $CHAPTER_GARDEN_DIR $CHAPTER_GARDEN_DIR.git
git -C $CHAPTER_GARDEN_DIR remote set-url origin $CHAPTER_GARDEN_DIR.git
cd $CHAPTER_GARDEN_DIR
date
lingtai init --port 17830
date
```

**The answers**, in the order `init` asks (prompts from
`apps/cli/src/init.ts:827`, `first-project.ts:243,378,454`,
`recipe-flow.ts:272,430`, `agents.ts:180,201,233,280`,
`setup-build.ts:220,251,330`, `source.ts:206`, `landing.ts:163,233,249,270`).
Enter means take what it offers. A question not in this list is itself a
finding: write it down with its words.

| # | It asks | Answer | Why |
|---|---|---|---|
| 1 | a Postgres URL for the log — empty for SQLite | Enter | SQLite |
| 2 | a GitHub project, or one on this machine only | `local` | its default is `github` |
| 3 | the directory of the repository on this machine | `/Users/steven/lingtai-trial/src/chapter-garden-b` | the full path, not `.`: the project is named after the directory |
| 4 | the branch this project's recipe governs and merges into | Enter if it offers `main` | the checklist asks whether it is detected; if it offers nothing, write that down and type `main` |
| 5 | use every default? | `no` | the defaults choose Claude Code; this round is Codex |
| 6 | which agent writes the change (…) | `codex` | |
| 7 | which model (empty for the runtime's own default) | Enter | |
| 8 | does a cold reviewer read it, and which agent (…, or none) | `codex` | |
| 9 | on which model (empty for the runtime's own default) | Enter | |
| 10 | the install command | Enter if it offers `npm ci` | |
| 11 | run these before review? yes, or no to write your own | `yes` if it lists `npm run check` and `npm run build` | |
| 12 | run these once against the base before writing them? | `yes` | the trial build, #436 |
| 13 | which labels are work, comma-separated, first = taken first | Enter | `bug, feature, documentation` |
| 14 | land this on which branch, or "hold" to hold every pass for a person | `hold` | as round A |
| 15 | how many times a pass sends the agent back — 0 means every refusal goes straight to you | Enter | `2` |
| 16 | what one agent run may take, like 30m or 2h | Enter | |
| 17 | a dollar ceiling per agent run, like $5, or "none" for no ceiling | Enter | |
| 18 | register with the checks and landing above? | `yes` | |

Tickets are not asked: a local project keeps them in Lingtai's database. If
the trial build fails, it asks "write them anyway, or edit the list?": write
down the failure and answer `edit`.

Paste the whole session, questions included:

```paste
❯ set -gx CHAPTER_GARDEN_DIR $TRIAL_SRC/chapter-garden-b
  git clone https://github.com/steven-zhc/chapter-garden.git $CHAPTER_GARDEN_DIR
  git clone --bare $CHAPTER_GARDEN_DIR $CHAPTER_GARDEN_DIR.git
  git -C $CHAPTER_GARDEN_DIR remote set-url origin $CHAPTER_GARDEN_DIR.git
  cd $CHAPTER_GARDEN_DIR
  date
  lingtai init --port 17830
  date
Cloning into '/Users/steven/lingtai-trial/src/chapter-garden-b'...
remote: Enumerating objects: 208, done.
remote: Counting objects: 100% (208/208), done.
remote: Compressing objects: 100% (138/138), done.
remote: Total 208 (delta 51), reused 190 (delta 36), pack-reused 0 (from 0)
Receiving objects: 100% (208/208), 98.54 KiB | 1.07 MiB/s, done.
Resolving deltas: 100% (51/51), done.
Cloning into bare repository '/Users/steven/lingtai-trial/src/chapter-garden-b.git'...
done.
Thu Oct 29 12:42:43 CDT 2026
init
│
Machine
  git          git version 2.50.1 (Apple Git-155)
  claude-code  signed in via claude.ai
  codex        Logged in using ChatGPT
  home         /Users/steven/lingtai-trial/a — config.yml · projects: chapter-garden-a
Store
  store  SQLite, /Users/steven/lingtai-trial/a/lingtai.db ← /Users/steven/lingtai-trial/a/config.yml
  SQLite is the whole log, in one file under ~/.lingtai — no server, and no second machine: nothing outside this one can read it, and switching stores later starts a new, empty log and moves nothing from this one
GitHub App
  app  none yet — the board's first screen creates it through GitHub's manifest flow
Projects
  chapter-garden-a — local, /Users/steven/lingtai-trial/src/chapter-garden-a.git
  lingtai add asks GitHub-or-directory for another project; lingtai init --project github sets up the GitHub App on a machine that has only local projects
doctor

all 27 passed · 10 not checked here · 3 not implemented yet
Board
no board was started
next: lingtai board · lingtai ticket new · lingtai run
Thu Oct 29 12:42:46 CDT 2026
```

**That run was in round A's home** (`home /Users/steven/lingtai-trial/a`):
the terminal still had `ROUND=a`, and the block did not set it. It wrote
nothing (round A's `config.yml` is still from 10:58). The clone is fine, so
the rerun skips it:

```fish
set -gx ROUND b
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx TRIAL_SRC $HOME/lingtai-trial/src
mkdir -p $LINGTAI_HOME $TRIAL_SRC
echo $LINGTAI_HOME
set -gx CHAPTER_GARDEN_DIR $TRIAL_SRC/chapter-garden-b
cd $CHAPTER_GARDEN_DIR
date
lingtai init --port 17830
date
```

```paste

```

- [ ] It asks only what it must, in this order: code location, then tickets.
  There is no GitHub question on a local project.
- [ ] The base branch is detected (`main`), not asked for.
- [ ] Install and build are detected (`npm ci`, `npm run check`,
  `npm run build`).
- [ ] The trial build (#436) runs and reports, and afterwards
  `git -C $CHAPTER_GARDEN_DIR worktree list` shows only the checkout:

```fish
git -C $CHAPTER_GARDEN_DIR worktree list
```

```paste
/Users/steven/lingtai-trial/src/chapter-garden-b  f20fcec [main]
```

- [ ] Doctor's short view is readable (#701), and init ends with a single
  `next:` line (#702).
- [ ] No output cites an ADR, an issue number or a source path (#703).

**Ticket, run, approve, measure.** `ROUND=b` in every terminal. The project
is `chapter-garden-b`, unless `init` named it otherwise above: use the name its
`added …` line printed. The story is *The Sun's Ninth Minute*.

Terminal 1:

```fish
printf '%s\n' \
  "Add the next chapter to The Sun's Ninth Minute" \
  "labels: feature" \
  "" \
  "Find the latest chapter of this story and write one new chapter that continues it." \
  "Follow the story's existing language, chapter numbering, and Markdown layout." \
  "Keep earlier chapters unchanged. Done when the new chapter appears on the site." \
  > $TRIAL_SRC/ticket-b.md
cat $TRIAL_SRC/ticket-b.md
date
env VISUAL="cp $TRIAL_SRC/ticket-b.md" lingtai ticket new --project chapter-garden-b
lingtai ticket list --project chapter-garden-b
```

**Terminal 2**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai start` runs against `~/.lingtai` instead of this round's home.

```fish
set -gx ROUND b
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx CHAPTER_GARDEN_DIR $TRIAL_SRC/chapter-garden-b
echo $LINGTAI_HOME
lingtai start
```

**Terminal 3**, a new terminal: set the round's environment first. A new terminal has none of it, and without it `lingtai board` runs against `~/.lingtai` instead of this round's home.

```fish
set -gx ROUND b
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx TRIAL_SRC $HOME/lingtai-trial/src
set -gx CHAPTER_GARDEN_DIR $TRIAL_SRC/chapter-garden-b
echo $LINGTAI_HOME
lingtai board start --port 17830
```

When the card is waiting on you, in terminal 1:

```fish
lingtai status chapter-garden-b --all
lingtai approve chapter-garden-b --issue <n>
date
lingtai status chapter-garden-b --all
lingtai report --window today --project chapter-garden-b
```

```paste

```

- [ ] One ticket landed; `status`, `/spend` and `/report` show the run with
  Codex as its runtime; an unknown run names its reason (#692).

**Optional: the refuse-and-fix step, rewritten** (A9). Round A's ticket did
not refuse: it told the agent "The check wins over this ticket", and the
agent read the schema and wrote `order: 2`. This is the rewrite from the
round A summary: an honest demonstration, with no line telling the agent how
to avoid the mistake. It runs on *The Thirteenth Tower Teaches No Magic*, with
`lingtai start` and the board still running. If it refuses once and then
lands after one round, this text replaces the tutorial's (#611).

Terminal 1:

```fish
printf '%s\n' \
  "Add the next chapter to The Thirteenth Tower Teaches No Magic" \
  "labels: feature" \
  "" \
  "This ticket demonstrates Lingtai's checks. Write one new chapter that" \
  "continues the story, and in its front matter write order as a quoted" \
  'string, order: "2", even though the schema wants a number: the point is' \
  "to watch Lingtai's build refuse it. Do not run npm run check or npm run" \
  "build, and do not correct the type before Lingtai's check has refused it." \
  "When the refusal comes back, fix what it names." \
  > $TRIAL_SRC/ticket-b-refuse.md
cat $TRIAL_SRC/ticket-b-refuse.md
date
env VISUAL="cp $TRIAL_SRC/ticket-b-refuse.md" lingtai ticket new --project chapter-garden-b
lingtai ticket list --project chapter-garden-b
```

```paste

```

When it is waiting on you, read History, Attempts and the run log **before**
Approve: a run's log is deleted when it lands. The run log is the newest file
here:

```fish
ls -t $LINGTAI_HOME/runs/chapter-garden-b/
grep -n -i -E 'order|quoted|npm run|refus' (ls -t $LINGTAI_HOME/runs/chapter-garden-b/*.log)[1]
```

```paste

```

Then:

```fish
lingtai status chapter-garden-b --all
lingtai approve chapter-garden-b --issue <n>
date
lingtai report --window today --project chapter-garden-b
```

```paste

```

- [ ] The agent wrote `order: "2"`, and did not run the checks itself.
- [ ] The first `build` was refused, naming the `order` field.
- [ ] `round 1` ran inside **the same attempt**, wrote `order: 2`, and the pass
  landed after approval.
- [ ] History, Attempts and the run log were all readable **before** Approve.

If the agent still corrected the type first, or ran the checks, quote its
words from the run log here. That says whether a ticket's text can produce
the refusal at all, or whether the pass instructions and AGENTS.md always win.

**A second repository on the same machine.** The ordinary case after the
first day: this machine is set up (round B's home, with `chapter-garden-b`),
and a person adds another repository. Two things to see: what `init` says when
it is run there by habit (B1 expects it to name `lingtai add --local .`, and it
did not in the first attempt), and what `add` asks. Terminal 1, with
`lingtai start` and the board still running:

```fish
set -gx CHAPTER_GARDEN_B2 $TRIAL_SRC/chapter-garden-b2
git clone https://github.com/steven-zhc/chapter-garden.git $CHAPTER_GARDEN_B2
git clone --bare $CHAPTER_GARDEN_B2 $CHAPTER_GARDEN_B2.git
git -C $CHAPTER_GARDEN_B2 remote set-url origin $CHAPTER_GARDEN_B2.git
cd $CHAPTER_GARDEN_B2
echo $LINGTAI_HOME
lingtai init --port 17830
```

```paste

```

- [ ] `init` says this directory is not a project yet and names
  `lingtai add --local .` (B1).

```fish
date
lingtai add --local .
date
lingtai doctor
```

Answer as in the table under round B's `init`, rows 4–18 (store, project
kind and directory are not asked: the machine is set up and `--local .` named
the directory). The project's name is the directory's, `chapter-garden-b2`.

```paste

```

- [ ] It asks only what a second repository needs: nothing about the store,
  the machine or GitHub.
- [ ] The base branch (`main`), install and build are detected.
- [ ] The trial build runs, reports, and leaves no worktree behind
  (`git -C $CHAPTER_GARDEN_B2 worktree list` shows only the checkout).
- [ ] It ends with what to do next, and names the new project
  (`chapter-garden-b2`, or the name it printed).
- [ ] No output cites an ADR, an issue number or a source path.
- [ ] `lingtai doctor` lists both projects and passes.

No ticket is run on it: the pass is the same as round B's.

**Round B stuck:**

- **B1. `init` in a directory it does not know, on a machine already set up,
  does not mention that directory.** Run inside the new `chapter-garden-b`
  clone with round A's home, it listed round A's project and ended "next:
  lingtai board · lingtai ticket new · lingtai run". The way to register this
  directory is `lingtai add --local .`, and it appears only as "lingtai add
  asks GitHub-or-directory for another project", in the middle. The home line
  did name the wrong home, but nothing drew the eye to it. (The wrong home
  itself was this document's mistake: round B's block did not set `ROUND`.)

- 

**Stop round B**: Ctrl+C in terminals 2 and 3. Close the board's browser page first: while a page is open, Ctrl+C does not stop the board (A10).

**Clean up round B**, after its stuck lines are written down. Stop
its processes first (above). In any terminal:

```fish
set -gx ROUND b
set -gx LINGTAI_HOME $HOME/lingtai-trial/$ROUND
set -gx TRIAL_SRC $HOME/lingtai-trial/src
lsof -nP -iTCP:17830 -sTCP:LISTEN
lsof +D $LINGTAI_HOME 2>/dev/null | head -5
mkdir -p $HOME/lingtai-trial-archive
tar -czf $HOME/lingtai-trial-archive/round-$ROUND.tgz -C $HOME/lingtai-trial $ROUND
rm -rf $LINGTAI_HOME $TRIAL_SRC/chapter-garden-b $TRIAL_SRC/chapter-garden-b.git $TRIAL_SRC/chapter-garden-b2 $TRIAL_SRC/chapter-garden-b2.git
find $TRIAL_SRC -maxdepth 1 -name "ticket-$ROUND*.md" -delete
ls $HOME/lingtai-trial $TRIAL_SRC $HOME/lingtai-trial-archive
```

```paste

```

- [ ] Both `lsof` lines printed nothing: no board on 17830, and no process
  holding a file in this round's home. If one did, stop it before `rm`.
- [ ] `round-b.tgz` is in the archive, and `$HOME/lingtai-trial` holds no
  `b/`.
