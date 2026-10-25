# Tutorial — get one ticket to land

Use [Chapter Garden](https://github.com/steven-zhc/chapter-garden), a small
Astro site for jointly written novels, to try the full Lingtai flow: set up a
project, create a ticket, let an agent work, and approve the result. You can use
another Git project with its own install and build commands.

## Before you start

| For            | Have ready                                                                                                                                                                             | Why                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Lingtai        | Git; Codex installed and signed in                                                                                                                                                     | Lingtai creates worktrees and uses Codex in this tutorial.        |
| Chapter Garden | Node.js and npm | You will build the site and let Lingtai merge into a repository on this machine. |
| Part 2 (GitHub) | A fork of Chapter Garden that you own, and permission to create and install a GitHub App on your account or organisation | Each Lingtai installation uses an App of its own; see [GitHub](github.md). |

Everything else Lingtai needs, and when, is on [requirements](requirements.md).

Install Lingtai. This downloads the CLI; setup is the next step.

```sh
curl -fsSL https://lingtai.hczhang.com/install.sh | sh
```

Clone Chapter Garden over HTTPS, then make a bare repository beside it the
checkout's `origin`. Lingtai pushes and merges there, so Part 1 needs no GitHub
account, and the original repository is never touched.

**Bash**

```bash
# Change this path if you want the checkout somewhere else.
export CHAPTER_GARDEN_DIR="$HOME/workspace/chapter-garden"
mkdir -p "$(dirname "$CHAPTER_GARDEN_DIR")"
git clone https://github.com/steven-zhc/chapter-garden.git "$CHAPTER_GARDEN_DIR"
git clone --bare "$CHAPTER_GARDEN_DIR" "$CHAPTER_GARDEN_DIR.git"
git -C "$CHAPTER_GARDEN_DIR" remote set-url origin "$CHAPTER_GARDEN_DIR.git"
```

**Zsh**

```zsh
# Change this path if you want the checkout somewhere else.
export CHAPTER_GARDEN_DIR="$HOME/workspace/chapter-garden"
mkdir -p "$(dirname "$CHAPTER_GARDEN_DIR")"
git clone https://github.com/steven-zhc/chapter-garden.git "$CHAPTER_GARDEN_DIR"
git clone --bare "$CHAPTER_GARDEN_DIR" "$CHAPTER_GARDEN_DIR.git"
git -C "$CHAPTER_GARDEN_DIR" remote set-url origin "$CHAPTER_GARDEN_DIR.git"
```

**Fish**

```fish
# Change this path if you want the checkout somewhere else.
set -gx CHAPTER_GARDEN_DIR "$HOME/workspace/chapter-garden"
mkdir -p (dirname "$CHAPTER_GARDEN_DIR")
git clone https://github.com/steven-zhc/chapter-garden.git "$CHAPTER_GARDEN_DIR"
git clone --bare "$CHAPTER_GARDEN_DIR" "$CHAPTER_GARDEN_DIR.git"
git -C "$CHAPTER_GARDEN_DIR" remote set-url origin "$CHAPTER_GARDEN_DIR.git"
```

## Step 1 — Set up this machine

Register Chapter Garden with Lingtai. This command uses local SQLite, lets
Codex write the change, checks the site, and waits for your approval before
merging.

**Bash**

```bash
# Reuse the checkout path above, or change this default in a new terminal.
export CHAPTER_GARDEN_DIR="${CHAPTER_GARDEN_DIR:-$HOME/workspace/chapter-garden}"
lingtai init --store sqlite --local "$CHAPTER_GARDEN_DIR" \
  --base main \
  --agent codex --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

**Zsh**

```zsh
# Reuse the checkout path above, or change this default in a new terminal.
export CHAPTER_GARDEN_DIR="${CHAPTER_GARDEN_DIR:-$HOME/workspace/chapter-garden}"
lingtai init --store sqlite --local "$CHAPTER_GARDEN_DIR" \
  --base main \
  --agent codex --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

**Fish**

```fish
# Reuse the checkout path above, or change this default in a new terminal.
set -q CHAPTER_GARDEN_DIR; or set -gx CHAPTER_GARDEN_DIR "$HOME/workspace/chapter-garden"
lingtai init --store sqlite --local "$CHAPTER_GARDEN_DIR" \
  --base main \
  --agent codex --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

A pass has ten steps in a fixed order. This setup saves Chapter Garden's
choices in a local recipe; steps you did not configure keep their defaults.

![Selected Chapter Garden recipe fields connect to Lingtai's ten fixed steps.](img/recipe.svg)

[Open the diagram at full size](img/recipe.svg).

<details>
<summary>What did this command choose?</summary>

| Option                          | Meaning                                                            |
| ------------------------------- | ------------------------------------------------------------------ |
| `--store sqlite`                | Keeps Lingtai's log on this machine; no database server is needed. |
| `--local "$CHAPTER_GARDEN_DIR"` | Registers your checkout without a GitHub App ([Part 2](#part-2--move-the-project-to-github) adds one). |
| `--base main`                  | Merges into `main` of the bare repository beside your checkout.    |
| `--agent codex`                 | Uses the Codex account you signed in to.                           |
| `--install 'npm ci'`            | Installs Chapter Garden's dependencies in each worktree.           |
| `--build ...`                   | Runs the site's checks and build before review.                    |
| `--land hold`                   | Stops for your approval before merging.                            |
| `--defaults`                    | Accepts the remaining setup defaults.                              |

If you already initialized Lingtai without these options, `init` will not
reconfigure that project; see the [operating guide](operating.md). With
`--agent codex`, `init` writes `runtime.limits.turns: unbounded` into the
recipe, because Codex has no turn limit to enforce; the two-hour wall limit
still applies and `doctor` reports the limits as passing. A turn count you
write yourself on Codex is a promise nothing keeps, and `doctor` fails it.

</details>

## Step 2 — Open one ticket

Create one small, checkable task for the agent. Lingtai opens your editor:

```sh
lingtai ticket new --project chapter-garden
```

Step 1 registered a local project, so this ticket lives in Lingtai's local database; it is not a GitHub issue.

Pick a story from the [Chapter Garden bookshelf](https://cg.hczhang.com/en/). These are the current titles:

| Genre           | Story                                   |
| --------------- | --------------------------------------- |
| Fantasy         | Fate Owes Me a Page                     |
| Magic           | The Thirteenth Tower Teaches No Magic   |
| Horror          | Room Zero Checks Out Tonight            |
| Time travel     | Weather Duty a Thousand Years Ago       |
| Science fiction | The Sun's Ninth Minute                  |
| Detective       | The Missing Person Filed Her Own Report |
| Power fantasy   | I Won't Cover for Them Anymore          |
| Mystery         | After the Rain                          |

Replace the form with this request. Change only `<story title>` to one title from the table:

```text
Add the next chapter to <story title>
labels: feature

Find the latest chapter of this story and write one new chapter that continues it.
Follow the story's existing language, chapter numbering, and Markdown layout.
Keep earlier chapters unchanged. Done when the new chapter appears on the site.
```

Save and quit, then continue only when Lingtai prints `created #N`; that number is your ticket.
The `feature` label makes it eligible for the queue; use `bug` or
`documentation` when they fit better.

## Step 3 — Run the agent and checks

For a quick try, start Lingtai in one terminal:

```sh
lingtai start
```

Leave it running. In a second terminal, open the Board:

```sh
lingtai board
```

The Board opens at the URL printed by the command (normally
`http://127.0.0.1:17820`). This terminal stays open too; `Ctrl+C` stops each
foreground process. Use the Board for Step 4, or open a third terminal for its
CLI commands. The installed binary does not yet support `lingtai service`
for background startup.

Lingtai takes the ticket, creates a separate worktree, runs Codex, then runs
`npm run check` and `npm run build`.

![Step 3 runs the ticket through claim, worktree setup, Codex implementation, checks and review, then stops at the landing hold.](img/pass.svg)

## Step 4 — Approve and confirm

Check the ticket's state:

```sh
lingtai status chapter-garden --all
```

When it says **Waiting on you** for the landing hold, review the change and
the check results. If you want it merged, approve the ticket number from
Step 2:

```sh
lingtai approve chapter-garden --issue <ticket-number>
```

Run `lingtai status chapter-garden --all` again until the ticket says
**Landed**. That means the checked change reached `main` of the bare repository; run
`git pull` in your Chapter Garden checkout (`~/workspace/chapter-garden` unless
you changed it) to see the new chapter. If it
stopped for another reason, the [operating guide](operating.md) explains the
next action. To put work on GitHub, continue with Part 2.

![Step 4 reviews and approves the landing hold, then Lingtai merges the change and marks the ticket Landed.](img/waiting.svg)

## Part 2 — Move the project to GitHub

A GitHub repository needs a GitHub App, and **the App is yours**; there is no
shared one. [GitHub](github.md) says why.

**Part 2 is a second start.** Local tickets stay in the database and `add`
does not migrate them. **Stop Step 3's board first** (ctrl-c): `init` and `add`
would otherwise find it and create the App in the old home.

In a new terminal, use a fresh `LINGTAI_HOME` and answer `init`'s App question
with `skip`; `add` creates it below. `init` keeps this home's board running, so
leave it:

```sh
export LINGTAI_HOME="$HOME/.lingtai-github-tutorial"
lingtai init --store sqlite --project github --github-app skip
```

Use your own fork, `<you>/chapter-garden`; installing an App needs admin on it.
Use another terminal, same `LINGTAI_HOME`, from here on.

### Create the App

```sh
lingtai add <you>/chapter-garden --base main --github-app create
```

`add` asks its recipe questions (pass Step 1's flags; a fresh home needs `--base`), then opens the board's
`/setup/github-app` page and waits ten minutes. Fill `App name` and `Organisation` (blank for a personal
account). Leave `Webhook URL` blank: discovery runs on the daemon's sweep. Press
`Create the App on GitHub`, then **Create GitHub App** on GitHub's own next
screen.

You never choose the permissions; the manifest carries them:

| Permission      | Level | Why                                                     |
| --------------- | ----- | ------------------------------------------------------- |
| `issues`        | write | reading work items, writing agent:* labels and comments |
| `contents`      | write | cloning, pushing agent/*, merging into base             |
| `pull_requests` | write | opening and reading pull requests                       |
| `metadata`      | read  | required by GitHub for any App                          |

GitHub hands over the private key once. It is a file at
the path the board names (default `~/.ssh/lingtai-agent.private-key.pem`);
`$LINGTAI_HOME/config.yml` (`~/.lingtai-github-tutorial/config.yml`) holds that path, the App id and the webhook secret.

When the terminal prints `app          <slug>, owned by <owner> — it answered`,
the same `add` stops with `The App is not installed on <owner>, so it cannot see
<slug>.` Expected: **creating is not installing**.

### Install it and add the repository

Open `https://github.com/apps/<slug>/installations/new` and install it on
`<you>/chapter-garden` only. Then run `add` again **without** `--github-app`,
which is refused once an App exists:

```sh
lingtai add <you>/chapter-garden --base main
```

### Check it worked

```sh
lingtai doctor
```

`github: app credentials` should be `ok` (`skip` means no App). The second `add`
proves the installation by printing
`permissions: issues, contents, pull requests write; metadata read`; a missing
permission is listed instead.

Tickets here are GitHub issues with a kind label, not `lingtai ticket new`.
Steps 2–4 then apply; skip Step 3's `lingtai board`, as `init` left one running.
The landing now merges into `main` of your fork on GitHub, not the local bare
repository, so Step 4's `git pull` does not apply: look on GitHub instead.
