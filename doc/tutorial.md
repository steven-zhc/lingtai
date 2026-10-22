# Tutorial — get one ticket to land

This tutorial uses [Chapter Garden](https://github.com/steven-zhc/chapter-garden),
a small Astro site for jointly written novels, to walk through Lingtai's full
local-project flow: set up a project, open a ticket, run an agent and checks,
approve the result, and land it. You can use another Git project instead;
provide that project's own install and build commands during setup.

> **You are done when** the ticket reaches **Landed**, its commit is on your
> base branch, and you can explain which checks allowed it through.

## Before you start

For Lingtai, install Git and either Claude Code or Codex, then sign in to the
agent. To develop Chapter Garden, also install Node.js and npm and
[add your SSH key to GitHub](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/adding-a-new-ssh-key-to-your-github-account).
If you use another project, prepare its development tools instead.

Check SSH access with `ssh -T git@github.com`; a successful connection says
`Hi <username>!` (GitHub does not provide shell access). Then clone Chapter
Garden and create your own branch. You need permission to push that branch:

**Bash**

```bash
git clone git@github.com:steven-zhc/chapter-garden.git ~/chapter-garden
cd ~/chapter-garden
tutorial_branch="tutorial-$USER-$(date +%Y%m%d%H%M%S)"
git switch -c "$tutorial_branch"
git push -u origin "$tutorial_branch"
```

**Zsh**

```zsh
git clone git@github.com:steven-zhc/chapter-garden.git ~/chapter-garden
cd ~/chapter-garden
tutorial_branch="tutorial-$USER-$(date +%Y%m%d%H%M%S)"
git switch -c "$tutorial_branch"
git push -u origin "$tutorial_branch"
```

**Fish**

```fish
git clone git@github.com:steven-zhc/chapter-garden.git ~/chapter-garden
cd ~/chapter-garden
set tutorial_branch tutorial-$USER-(date +%Y%m%d%H%M%S)
git switch -c $tutorial_branch
git push -u origin $tutorial_branch
```

Use your new branch as the base throughout this tutorial; `main` is protected.
If you cannot push to Chapter Garden, clone a repository you can push to and
create your branch there. Lingtai's local-project route needs no GitHub App.

There is no database to provision. Lingtai's own log is a SQLite file under
`~/.lingtai` unless you give `init` a Postgres URL instead.

Start with one small change you can check when it is done.

Install the CLI:

```sh
curl -fsSL https://lingtai.hczhang.com/install.sh | env LINGTAI_NO_INIT=1 sh
```

The installer verifies the download and installs `lingtai` under
`~/.local/bin`. The flag leaves setup to Step 1. If you prefer the release URL:

```sh
curl -fsSL https://github.com/steven-zhc/lingtai/releases/latest/download/install.sh | env LINGTAI_NO_INIT=1 sh
```

Running from source instead? Run `pnpm install`, then use `pnpm lingtai`
wherever this guide says `lingtai`.

## Step 1 — Set up this machine

Run this once after cloning Chapter Garden. It uses Codex, checks each change,
and waits for your approval before merging.

**Bash**

```bash
lingtai init --store sqlite --local ~/chapter-garden \
  --base "$(git -C ~/chapter-garden branch --show-current)" \
  --agent codex --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

**Zsh**

```zsh
lingtai init --store sqlite --local ~/chapter-garden \
  --base "$(git -C ~/chapter-garden branch --show-current)" \
  --agent codex --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

**Fish**

```fish
lingtai init --store sqlite --local ~/chapter-garden \
  --base (git -C ~/chapter-garden branch --show-current) \
  --agent codex --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

Look for `landing hold` and both build commands in the printed recipe, then
continue to Step 2.

![The recipe feeds three gates between a ticket and a merge: is it work, does it pass, do you approve.](img/recipe.svg)

<details>
<summary>What does this command set?</summary>

| Option | Effect |
|---|---|
| `--store sqlite` | Keeps Lingtai's log on this machine. |
| `--local ~/chapter-garden` | Registers this checkout without a GitHub App. |
| `--base ...` | Uses your current tutorial branch as the merge target. |
| `--agent codex` | Uses the Codex account you signed in to. |
| `--install 'npm ci'` | Installs Chapter Garden's dependencies in each worktree. |
| `--build ...` (twice) | Runs `npm run check` and `npm run build` before review. |
| `--land hold` | Waits for your approval before merging. |
| `--defaults` | Accepts remaining defaults without more questions. |

Already ran `lingtai init` without these flags? It does not reconfigure an
existing project. Run `lingtai add --local ~/chapter-garden --agent codex
--install 'npm ci' --build 'npm run check' --build 'npm run build' --land hold
--defaults` to set the missing checks and hold.

With Codex, the doctor report currently marks its default 300-turn limit as
failed because Codex enforces the two-hour wall limit but not turns. This one
known failure does not block `lingtai start`; resolve any other failed check.

</details>

## Step 2 — Open one ticket

```text
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
Replace the form with a small change you want in Chapter Garden. Fill in each
`<...>` with a concrete answer; you can use this template again for another
change:

```text
Improve <one specific part of Chapter Garden>
labels: feature

In <book, page, or file>, <describe what you see now>.
Change it so <describe the result you want>.
Keep existing books and chapters intact.
Done when <describe how you will check the result> and both
npm run check and npm run build pass.
```

Use `bug` for a defect or `documentation` for a docs change. Save and quit to
create the ticket; note the number printed for the approval step:

```text
created #<ticket-number>  Improve ...
```

If a run needs project secrets, add only the names your recipe's `build`
step requires:

```text
lingtai env set <project> DATABASE_URL
lingtai env list <project>
```

Values are read without echo and stored under `~/.lingtai/env/`; `env list`
shows names, never values.

## Step 3 — Check the queue, then start

Preview what Lingtai can take without claiming anything:

```text
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

```text
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

```text
lingtai status <project> --all
```

The hold is the one your recipe wrote: *"Land this? The setup was answered
'hold'."* Use the ticket number printed when you created it:

```text
lingtai approve <project> --issue <ticket-number>
```

![Read which hold or check stopped it, then approve, requeue with a note, or attach to the run log.](img/waiting.svg)

If the approach is wrong instead, start a new pass from the base branch with a
note:

```text
lingtai requeue <project> --issue <ticket-number> --note "what should change next time"
```

`approve` records your decision; the running conductor then continues the held
run from its recorded commit and takes it through the merge lane. Wait for
**Landed** rather than treating the command's exit as a completed merge. Confirm
all three: the card is in **Landed**, the commit is on your base branch, and you
can say which checks let it through.

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

```text
lingtai pause "tuning the first recipe"
lingtai resume
```
