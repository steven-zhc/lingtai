# Tutorial

*Tutorial — get one ticket to land*

Try Lingtai on [Chapter Garden](https://github.com/steven-zhc/chapter-garden),
a small Astro site for jointly written novels: set up, open a ticket, let an
agent work on it.

## Before you start

You need Git, Claude Code or Codex installed and signed in, and Node.js 26.13.0
with npm. The rest is on [requirements](requirements.md).

## Step 1 — Set up this machine

Install Lingtai, clone Chapter Garden and register it. Press Enter at each
question.

```sh
curl -fsSL https://lingtai.hczhang.com/install.sh | sh
git clone https://github.com/steven-zhc/chapter-garden.git
lingtai init --local chapter-garden
```

With the sandbox on, `init` runs `claude setup-token` once and opens a browser to
sign in. If you skip it, the first ticket fails until you run `lingtai token
claude`; see [requirements](requirements.md#tokens-for-a-sandboxed-run).

If your shell cannot find `lingtai`, add `~/.local/bin` to your `PATH`; the
installer edits no shell profile.

`init` picks the writer and reviewer from what is signed in:

| Signed in | Writes | Reviews |
|---|---|---|
| Claude Code only | Claude Code | Claude Code |
| Codex only | Codex | Codex |
| Both | Claude Code | Codex |

A reviewer from another vendor catches more, but one is enough here.

Enter at the mode question makes a **team** project, which the book uses even
alone; [`solo`](solo.md) is the other answer.

![A ticket's attempt lands on your branch, lingtai-base, with nobody asked; lingtai pr submit freezes it as lingtai-base-pr-<n>, and only a person's merge commit moves main.](img/team-flow.svg)

[Open the diagram at full size](img/team-flow.svg).

## Step 2 — Open one ticket

Pick a story from the [Chapter Garden bookshelf](https://cg.hczhang.com/en/)
and create the ticket. Run it once; a second run is a second paid ticket.

```sh
lingtai ticket new --title "Add the next chapter to The Sun's Ninth Minute" --label feature \
  --body "Find the latest chapter of this story and write one new chapter that continues it. Follow the story's existing language, chapter numbering, and Markdown layout. Keep earlier chapters unchanged. Done when the new chapter appears on the site."
```

Continue when Lingtai prints `created #N`.

## Step 3 — Start

Starting runs at least two paid agent runs, the writer and the reviewer, on the
accounts above, and more if a check buys a fix round.

```sh
lingtai start
```

Leave it running; `Ctrl+C` stops it after the attempt in flight. In a second
terminal, run `lingtai board`. It has no login and listens on every address;
`board.host: 127.0.0.1` in `~/.lingtai/config.yml` keeps it to this machine.

![The board with the ticket's card in Waiting on you after the reviewer raised findings, numbered 1 to 4.](img/tutorial-board-waiting.png)

1. **Waiting on you**: the card stops here when the reviewer finds something it will not pass. Nothing more is spent until you answer.
2. **review** is red: the writer's change built and its checks passed, and the reviewer refused it.
3. The reviewer's findings, in its own words. On the card's page you answer them: another round for the writer, a new attempt, or approve as it stands.
4. **Landed** is still empty: nothing reaches your branch until review passes or you approve.

A card can stop in **Waiting on you** after review; answer it on its page.

When the card is **Landed**:

![The board with the ticket's card in Landed, on your branch, numbered 1 to 4.](img/tutorial-board.png)

1. **Landed**: the ticket's change is merged into your branch.
2. **on your branch**: it is on the branch Lingtai lands on, not yet on `main`.
3. **1 not in a PR yet**: in team mode, landed tickets wait here until you submit a pull request.
4. Today's spend, what this run cost so far.

Look at what landed:

```sh
git -C chapter-garden log -1 --stat lingtai-base
git -C chapter-garden diff main...lingtai-base
```

The ticket stays open after landing; the next chapter takes the change to `main`
in a PR. To OK each landing first, declare a `human:` at `proposed:`; see
[the recipe](recipe.md).

## Next

Next: [Team mode](team.md) — the way we recommend working.
