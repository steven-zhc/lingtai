# Tutorial

*Tutorial — get one ticket to land*

Use [Chapter Garden](https://github.com/steven-zhc/chapter-garden), a small
Astro site for jointly written novels, to try Lingtai: set up a project, create
a ticket and let an agent work on it. The options, a hold for your approval and
GitHub are on [Going further](tutorial-more.md).

## Before you start

You need Git, Claude Code installed and signed in, and Node.js 26.13.0 with npm
for Chapter Garden. Everything else Lingtai needs, and when, is on
[requirements](requirements.md).

## Step 1 — Set up this machine

Install Lingtai, clone Chapter Garden over HTTPS and register it. Press Enter at
each question.

```sh
curl -fsSL https://lingtai.hczhang.com/install.sh | sh
git clone https://github.com/steven-zhc/chapter-garden.git
lingtai init --local chapter-garden
```

If your shell cannot find `lingtai`, add `~/.local/bin` to your `PATH`; the
installer edits no shell profile.

Work lands on a `lingtai-base` branch in this checkout, never on `main`.

## Step 2 — Open one ticket

Pick a story from the [Chapter Garden bookshelf](https://cg.hczhang.com/en/) and
create the ticket. Run it once: a second run is a second ticket and a second
paid attempt.

```sh
lingtai ticket new --title "Add the next chapter to The Sun's Ninth Minute" --label feature \
  --body "Find the latest chapter of this story and write one new chapter that continues it. Follow the story's existing language, chapter numbering, and Markdown layout. Keep earlier chapters unchanged. Done when the new chapter appears on the site."
```

Continue when Lingtai prints `created #N`.

## Step 3 — Start

Starting runs at least two paid agent runs, the writer and the cold reviewer, on
your signed-in Claude Code account, and more if a check refuses and buys a fix
round. With Codex signed in as well, the reviewer is Codex. The attempt then
lands on `lingtai-base` with nobody asked; `main` is never touched.

```sh
lingtai start
```

Leave it running; `Ctrl+C` stops it after the attempt in flight. In a second
terminal, run `lingtai board` to watch. The board has no login and listens on
every address; `board.host: 127.0.0.1` in `~/.lingtai/config.yml` keeps it to
this machine.

When the card is **Landed**, read the change, and merge it to keep it:

```sh
git -C chapter-garden log -1 --stat lingtai-base
git -C chapter-garden merge lingtai-base
```

Run the merge on `main`. If `lingtai-base` is checked out, the landing holds
until you switch to another branch.

## Next

For the model behind it, see [the concepts](concepts.md). To hold attempts for
your approval, see what each option means, or move to GitHub, continue with
[Going further](tutorial-more.md). To read or change what `init` wrote, see
[the recipe guide](recipe.md). The [CLI guide](cli.md) has the command for each
routine action once an attempt has run.
