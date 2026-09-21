# Tutorial — get one issue to land

This is the shortest path from a new machine to one GitHub issue worked by an
agent and merged back into your repository.

You will do three things once — set up this machine, add a repository, start
Lingtai — then label one issue. Everything else happens on the board.

> **You are done when** the issue reaches **Landed**, its commit is on your base
> branch, and you can explain which checks allowed it through.

## Before you start

Have these ready:

- **Git**
- **A Postgres URL** for Lingtai's own data
- **Claude Code or Codex**, installed and signed in
- **Permission to install a GitHub App** on the repository you want to use

Choose a small first issue. A focused bug with an obvious test is better than a
large feature: your goal is to see the whole loop once, not test the limits of
the agent.

Install the CLI:

```bash
curl -fsSL https://lingtai.nextloom.ai/install.sh | sh
```

The installer verifies the downloaded archive, installs `lingtai` under
`~/.local/bin`, and starts setup. If you prefer an address that does not depend
on this site:

```bash
curl -fsSL https://github.com/steven-zhc/lingtai/releases/latest/download/install.sh | sh
```

Running from a source checkout instead? Run `pnpm install`, then use
`pnpm lingtai` wherever this guide says `lingtai`.

## Step 1 — Set up this machine

If the installer did not already start setup:

```bash
lingtai init
```

`init` checks what is already present before it asks anything. It will:

1. connect to Postgres and create Lingtai's tables;
2. select a signed-in agent runtime;
3. open the local board;
4. guide you through creating or verifying a GitHub App.

It writes machine settings to `~/.lingtai/config.yml`. If setup is interrupted,
run `lingtai init` again; verified answers are kept and setup resumes at the
first unfinished choice.

Leave this terminal open while you onboard the repository. It is serving the
board at [http://127.0.0.1:17820](http://127.0.0.1:17820). Later,
`lingtai board start` starts the same board again.

Before moving on:

```bash
lingtai doctor
```

Do not start a run while `doctor` is red. Its output names the failing check and
the command or setting involved.

## Step 2 — Add one repository

On the board, choose **Add repository** and select the repository where the
GitHub App is installed.

Lingtai reads the repository and proposes a setup. Most rows are facts it can
detect — the base branch, labels, scripts, submodules, and environment names.
Check those rows, then answer the two choices that matter most:

- **Does a person approve the merge?** Choose yes for a supervised first run.
  Choose no only if passing work should land unattended.
- **How far may one ticket go before it is yours?** The limits bound agent
  turns, wall time, repair rounds, and restarts.

The last screen is the important one: it shows the exact issues the first pass
will take, in order. If the list surprises you, go back and change the eligible
labels or use **Hold all** before finishing.

The wizard writes your recipe here:

```text
~/.lingtai/<project>/recipe.yml
```

The recipe is local to this machine. Nothing is committed to the repository you
manage. It records which labels count as work, what checks run, and whether a
person must approve.

If a run needs project secrets, add only the names required by the recipe:

```bash
lingtai env set <project> DATABASE_URL
lingtai env list <project>
```

Values are read without echo and stored in
`~/.lingtai/env/<project>.env`; `env list` shows names, never values.

## Step 3 — Check the queue, then start

Preview what Lingtai can take without claiming anything:

```bash
lingtai status <project>
```

Look for your first issue under `runnable`. If it is passed over, the same
output tells you why. The common reasons are:

- `no-kind` — the issue has none of the recipe's eligible labels;
- `excluded-label` — it carries a label the recipe holds back;
- `blocked-by` — GitHub says an open issue blocks it.

When the queue looks right:

```bash
lingtai start
```

Leave this terminal running. `start` keeps the board current, takes eligible
work, runs the agent and checks, and performs allowed merges.

For a background service on macOS or Linux, use `lingtai service install` after
you have completed this first run.

## Step 4 — Label one issue

On GitHub, add one of the eligible labels you chose in the wizard — for example
`bug` or `feature` — to the small issue you prepared.

That label is the trigger. On the board, the card moves through the loop:

```text
GitHub issue  →  Queued  →  Running  →  Landed
                              │
                              └────→  Waiting on you
```

Behind those four states, Lingtai:

1. claims the issue and cuts a disposable worktree;
2. lets the agent change and commit in that worktree;
3. runs the checks from your local recipe;
4. asks for approval if you required it;
5. merges passing work and performs configured end actions.

Your normal checkout is not the agent's workspace. The agent cannot decide that
its own checks passed, and it cannot silently skip a configured gate.

## Step 5 — Read the result

### If it lands

Confirm all three:

- the card is in **Landed**;
- the commit is on the configured base branch;
- the GitHub issue was closed if you enabled that end action.

You have now seen the complete loop. Add another eligible label when you want
the next issue taken.

### If it waits on you

Open the card. The board shows which attempt stopped, the failing check or hold,
what it cost, and any run log still needed to explain it.

If the only hold is the approval you configured, approve on the board or run:

```bash
lingtai approve <project> --issue 41
```

If the approach is wrong, send the item back with a useful note:

```bash
lingtai requeue <project> --issue 41 --note "what should change next time"
```

For a live run log:

```bash
lingtai attach <runId>
```

Do not diagnose every refusal from this tutorial. The
[operating guide](operating.md) maps each stopped state to the evidence and the
next action.

## Next: make it yours

- [Guide](guide.md) — write issues that agents can finish and checks can judge
- [Operating](operating.md) — pause, restart, recover, and understand refusals
- [The pass](the-pass.html) — the full loop as one diagram
- [Reference](reference.md) — every recipe key, command, state, and default

To stop taking new work while you adjust things:

```bash
lingtai pause "tuning the first repository"
lingtai resume
```
