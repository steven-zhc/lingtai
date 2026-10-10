# Tutorial — get one ticket to land

This is the shortest path from a new machine to one ticket worked by an agent
and merged.

You will do two things once — set up this machine, open one ticket — then
watch it move. Everything else happens on its own.

> **You are done when** the ticket reaches **Landed**, its commit is on your
> base branch, and you can explain which checks allowed it through.

## Before you start

Have these ready:

- **Git**
- **Claude Code or Codex**, installed and signed in
- **A repository with an `origin` remote carrying your base branch.** The
  merge lane pushes there — it need not be on GitHub. A bare repository works:
  `git init --bare` somewhere, `git remote add origin <that path>`, then `git
  push -u origin <your base branch>` — skip the push and `lingtai start` fails
  on an empty origin.

There is no database to provision. Lingtai's own log is a SQLite file under
`~/.lingtai` unless you give `init` a Postgres URL instead.

Choose a small first ticket — a focused bug with an obvious test, not a test
of its limits.

Install the CLI:

```bash
curl -fsSL https://lingtai.hczhang.com/install.sh | sh
```

The installer verifies the downloaded archive, installs `lingtai` under
`~/.local/bin`, and starts setup. If you prefer an address that does not depend
on this site:

```bash
curl -fsSL https://github.com/steven-zhc/lingtai/releases/latest/download/install.sh | sh
```

Running from source instead? Run `pnpm install`, then use `pnpm lingtai`
wherever this guide says `lingtai`.

## Step 1 — Set up this machine

If the installer did not already start setup:

```bash
lingtai init
```

`init` looks before it asks:

```text
looking before asking
  git          git version 2.50.1
  claude-code  signed in via claude.ai
  codex        Logged in using ChatGPT
  home         ~/.lingtai — no config.yml · no projects
```

Then, in order:

1. **The store** — `a Postgres URL for the log — empty for SQLite: `. Press
   enter for SQLite; Postgres is here only as something you may paste.
2. **The project** — `a GitHub project, or one on this machine only [github]:
   `. **Type `local`.** Enter alone takes GitHub, which this tutorial is not
   using.
3. **The directory**, then **the base branch** — the repository from *Before
   you start*, and the branch its recipe will govern.
4. **`use every default? [yes]: `.** Type `no` to see what you are agreeing
   to; `yes` is faster once you trust the defaults.

Answering `no` asks the rest of the recipe one question at a time — which
agent writes the change and which reviews it, an install command (a fresh
directory has none to detect; type one, or `none`), a build check (press
enter when done — typing `none` there writes it as a literal command), and
which labels count as work (`bug, feature, documentation` by default). A
local project is never asked where its tickets live — there is one legal
answer, its own table.

Then the one question worth reading closely:

```text
land this on which branch, or "hold" to hold every pass for a person [main]: 
```

**Type `hold`.** This is the trap: if you take the default here instead
(empty line, or answering `yes` to *use every default?* above), Lingtai lands
every passing run on your base branch with nobody approving it. `hold` is how
you watch the first one before trusting it. It confirms:

```text
landing       hold — every pass stops at proposed for a person
```

A script skips the terminal with the same answers:

```bash
lingtai init --store sqlite --project local --local <dir> --base <branch> \
  --agent claude-code --install none --defaults --land hold
```

`--agent` names the runtime — omit it with two signed in and the run refuses.

`init` ends by registering the project and printing its recipe:

```text
project      local — <name>, registered with its own origin as repo.remote
~/.lingtai/<name>/recipe.yml
```

The `hold` answer above is this entry, inside that file (shortened — the rest
of the file is every other default `init` pinned: the agent, the build
steps, the limits):

```yaml
steps:
  proposed:
    - name: hold every pass
      human: Land this? The setup was answered 'hold'.
```

![The recipe feeds three gates between a ticket and a merge: is it work, does it pass, do you approve.](img/recipe.svg)

It is local to this machine; nothing is committed to the repository. Last,
`init` prints `lingtai doctor`'s own report, then:

```text
no board was started — lingtai board starts it
```

Before moving on, confirm doctor is clean:

```bash
lingtai doctor
```

Do not open a ticket while `doctor` is red. Its output names the failing check
and what to fix.

## Step 2 — Open one ticket

```bash
lingtai ticket new --project <name>
```

This opens `$VISUAL` or `$EDITOR` on a short form:

```text
My first ticket
labels: bug
#! kinds: bug, feature, documentation — one belongs in labels:, or the queue
never sees this ticket

Describe the problem here.
```

The first line is the title; `labels:` must carry one of the kinds your
recipe took in Step 1, or the ticket is created but the queue passes over it.
Save and quit to create it:

```text
created #1  My first ticket
```

If a run needs project secrets, add only the names your recipe's `build`
step requires:

```bash
lingtai env set <project> DATABASE_URL
lingtai env list <project>
```

Values are read without echo and stored under `~/.lingtai/env/`; `env list`
shows names, never values.

## Step 3 — Check the queue, then start

Preview what Lingtai can take without claiming anything:

```bash
lingtai status <project>
```

Look for your ticket under `runnable`. If it is passed over, the same output
says why:

- `no-kind` — it carries none of the recipe's eligible labels;
- `excluded-label` — it carries a label the recipe holds back;
- `blocked-by` — an open ticket blocks it (GitHub-sourced projects only; a
  local project's tickets have no blockers yet).

![Each open ticket passes three filters — a kind label, no hold label, no open blocker — and what fails one is named.](img/queue.svg)

Use `lingtai status` or `lingtai ticket list` to check the queue — the board
shows it too.

When the queue looks right, start Lingtai:

```bash
lingtai start
```

Leave this terminal running. `start` takes eligible work, runs the agent and
your checks, and performs allowed merges — nothing, here, since the recipe
says `hold`.

For a background service on macOS or Linux, use `lingtai service install`
after this first run.

## Step 4 — Read the result

Behind the scenes, Lingtai claims the ticket, cuts a disposable worktree, lets
the agent change and commit there, runs the checks from your recipe, and then
stops — your recipe said `hold` — at **Waiting on you**:

```text
GitHub issue / ticket  →  Queued  →  Running  →  Waiting on you  →  Landed
```

![One pass: claim, worktree, agent, checks, approval, merge, end. A red check returns to the agent for a fix round; anything unresolved stops at Waiting on you.](img/pass.svg)

Confirm what stopped it (`--all`, since a hold outside the queue needs it):

```bash
lingtai status <project> --all
```

The hold is the one your recipe wrote: *"Land this? The setup was answered
'hold'."* Approve it:

```bash
lingtai approve <project> --issue 1
```

![Read which hold or check stopped it, then approve, requeue with a note, or attach to the run log.](img/waiting.svg)

If the approach is wrong instead, send it back with a note:

```bash
lingtai requeue <project> --issue 1 --note "what should change next time"
```

`approve` merges it immediately — nothing further to run. Confirm all three:
the card is in **Landed**, the commit is on your base branch, and you can say
which checks let it through.

For a live run log while a pass is in flight: `lingtai attach <runId>`. The
[operating guide](operating.md) maps every other stopped state to its
evidence and the next action.

## Next: make it yours

- [Guide](guide.md) — write tickets that agents can finish and checks can judge
- [Operating](operating.md) — pause, restart, recover, and understand refusals
- [The pass](the-pass.html) — the full loop as one diagram
- [Plugins](plugins/index.md) — every recipe key: what it does, where it may be written, and a real example
- [Reference](reference.md) — every command, state, and default

To stop taking new work while you adjust things:

```bash
lingtai pause "tuning the first recipe"
lingtai resume
```
