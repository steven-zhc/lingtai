# Tutorial — get one ticket to land

Use [Chapter Garden](https://github.com/steven-zhc/chapter-garden), a small
Astro site for jointly written novels, to try the full Lingtai flow: set up a
project, create a ticket, let an agent work, and approve the result. You can use
another Git project with its own install and build commands.

## Before you start

| For            | Have ready                                                                                                                                                                             | Why                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Lingtai        | Git; Claude Code installed and signed in                                                                                                                                              | Lingtai creates worktrees and uses Claude Code in this tutorial.  |
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

**POSIX shell (bash, zsh)**

```sh
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
Claude Code write the change, checks the site, and waits for your approval before
merging.

**POSIX shell (bash, zsh)**

```sh
# Reuse the checkout path above, or change this default in a new terminal.
export CHAPTER_GARDEN_DIR="${CHAPTER_GARDEN_DIR:-$HOME/workspace/chapter-garden}"
lingtai init --store sqlite --local "$CHAPTER_GARDEN_DIR" \
  --base main \
  --agent claude-code --reviewer claude-code \
  --install 'npm ci' --build 'npm run check' \
  --build 'npm run build' --defaults --land hold
```

**Fish**

```fish
# Reuse the checkout path above, or change this default in a new terminal.
set -q CHAPTER_GARDEN_DIR; or set -gx CHAPTER_GARDEN_DIR "$HOME/workspace/chapter-garden"
lingtai init --store sqlite --local "$CHAPTER_GARDEN_DIR" \
  --base main \
  --agent claude-code --reviewer claude-code \
  --install 'npm ci' --build 'npm run check' \
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
| `--agent claude-code`           | Uses the Claude Code account you signed in to for the change.      |
| `--reviewer claude-code`        | Uses the same account for the cold review.                         |
| `--install 'npm ci'`            | Installs Chapter Garden's dependencies in each worktree.           |
| `--build ...`                   | Runs the site's checks and build before review.                    |
| `--land hold`                   | Stops for your approval before merging.                            |
| `--defaults`                    | Accepts the remaining setup defaults.                              |

If you already initialized Lingtai without these options, `init` will not
reconfigure that project; see the [operating guide](operating.md).

To use Codex instead, pass `--agent codex --reviewer codex`; it needs Codex
installed and signed in.

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

Lingtai takes the ticket, creates a separate worktree, runs Claude Code, then runs
`npm run check` and `npm run build`.

![Step 3 runs the ticket through claim, worktree setup, Claude Code implementation, checks and review, then stops at the landing hold.](img/pass.svg)

## Step 4 — Approve and confirm

Open the ticket's task page from the Board by clicking its title. Watch the
rail advance through the steps above.

When the card is under **Waiting on you** and `proposed` is lit on the rail,
read the change and the check results on that page, then press **Approve**. The
card moves to **Landed**: the checked change reached `main` of the bare
repository. Run `git pull` in your Chapter Garden checkout
(`~/workspace/chapter-garden` unless you changed it) to see the new chapter. If
it stopped for another reason, the [operating guide](operating.md) explains the
next action. To watch a check refuse once, continue with the optional step below; to put work on GitHub, go to Part 2.

From a terminal instead:

```sh
lingtai status chapter-garden --all
lingtai approve chapter-garden --issue <ticket-number>
```

`status` shows **Waiting on you** for the landing hold; `<ticket-number>` is the
number from Step 2.

![Step 4 reviews and approves the landing hold, then Lingtai merges the change and marks the ticket Landed.](img/waiting.svg)

## Optional — Watch a check refuse

This ticket asks for a mistake on purpose, so you can watch a check catch it. With `lingtai start` and the Board still running, run `lingtai ticket new --project chapter-garden` and paste this, with a different story from Step 2's:

```text
Add the next chapter to <a different story title>
labels: feature

Write one new chapter that continues the story. In its front matter write
order as a quoted string, for example order: "2".
Do not run npm run check or npm run build yourself; Lingtai runs them.
If Lingtai reports that a check refused this change, fix what the check
names. The check wins over this ticket.
```

Chapter Garden requires `order` to be a number, so the first build is refused. Lingtai buys one fix round inside the same attempt and sends the refusal back to the agent. On the ticket's task page:

- **History**: the failed `build` row names the field; open the row for the build's full output. Then `round 1` and `implement` running again. There is one attempt, not two.
- **Attempts**: turns, duration and cost.
- **Run log**: inside the attempt row, or `lingtai attach <runId>` with the run id printed under it.

Read all three **before** you press Approve: a run's log is deleted when it lands. Then approve as in Step 4.

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

**The base must accept direct pushes from the App**: Lingtai pushes to it and opens no pull request. If protected, let the App bypass it, or set the recipe's `repo.base` elsewhere.

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

When the terminal prints `app  <slug>, owned by <owner> — it answered` under *GitHub App*,
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

## Next

Once a pass has run, [the CLI guide](cli.md) has the command for each routine
action that follows: waiting on a ticket, answering a question, restarting the
daemon. To subscribe to what a pass writes, [the events](events.json) lists each step's
events with the code that appends them.
