# Tutorial

*Tutorial — get one ticket to land*

Try Lingtai on [Chapter Garden](https://github.com/steven-zhc/chapter-garden),
an Astro site: set up, open a ticket, let an agent work.

## Before you start

You need Git, Claude Code or Codex signed in, and Node.js 26.13.0 with npm. See
[requirements](requirements.md).

## Step 1 — Set up this machine

Install Lingtai, clone the site and register it. `init` asks a few questions;
press Enter to take the default at each, except the one below.

```sh
curl -fsSL https://lingtai.hczhang.com/install.sh | sh
git clone https://github.com/steven-zhc/chapter-garden.git
lingtai init --local chapter-garden
```

With the sandbox on, `init` runs `claude setup-token` once, opening a browser.
Skip it and the first ticket fails until `lingtai token claude`; see
[requirements](requirements.md#tokens-for-a-sandboxed-run).

If `lingtai` is not found, add `~/.local/bin` to `PATH`.

**The one choice: who writes, and who reviews.** `init` offers only the agents
signed in on this machine, and proposes:

| Signed in | Writes | Reviews |
|---|---|---|
| Claude Code only | Claude Code | Claude Code |
| Codex only | Codex | Codex |
| Both | Claude Code | Codex |

One is enough: it writes the change, then reads it again cold. A reviewer from
another vendor catches more of what the writer missed. To choose instead,
answer the two questions, or pass them:

```sh
lingtai init --local chapter-garden --agent codex --reviewer claude-code
```

`--reviewer none` skips review: cheaper, but nothing reads the change before
it lands.

Enter at the mode question makes a **team** project; [`solo`](solo.md) is the other.

![A ticket's attempt lands on your branch, lingtai-base, with nobody asked; lingtai pr submit freezes it as lingtai-base-pr-<n>, and only a person's merge commit moves main.](img/team-flow.svg)

[Open the diagram at full size](img/team-flow.svg).

## Step 2 — Open one ticket

Pick a story from the [bookshelf](https://cg.hczhang.com/en/). Run once; a second
run is a second paid ticket.

```sh
lingtai ticket new --title "Add the next chapter to The Sun's Ninth Minute" --label feature \
  --body "Find the latest chapter of this story and write one new chapter that continues it. Follow the story's existing language, chapter numbering, and Markdown layout. Keep earlier chapters unchanged. Done when the new chapter appears on the site."
```

Continue when Lingtai prints `created #N`.

## Step 3 — Start

Starting pays for at least two runs, writer and reviewer, on the accounts above.
Each finding sent back to the writer costs one judge run, one more writer run and
one more reviewer run, since the fix is reviewed again.

```sh
lingtai start
```

Leave it running; `Ctrl+C` stops after the attempt in flight. In a second
terminal run `lingtai board` to watch it. The board has no login and listens on every network address; `board.host: 127.0.0.1`
in `~/.lingtai/config.yml` keeps it on this machine.

If review raises findings, a judge sends them back to the writer, up to six
times. The card stops in **Waiting on you** only when those rounds run out or
the judge cannot settle it.

When review passes, the card is **Landed**:

![The card in Landed, on your branch, numbered 1 to 3.](img/tutorial-board.png)

1. **Landed**: merged into your branch.
2. **on your branch**: not yet on `main`.
3. **1 not in a PR yet**: waits for your PR.

Look at what landed:

```sh
git -C chapter-garden log -1 --stat lingtai-base
git -C chapter-garden diff main...lingtai-base
```

To read it on the site, start it from a second clone; Lingtai keeps landing into the first:

```sh
git clone -b lingtai-base chapter-garden garden-preview
cd garden-preview && npm ci && npm run dev
```

Open `http://localhost:4321/en/` and the story you picked:

![The new chapter in Chapter Garden, highlighted in the story's contents.](img/tutorial-site.png)

The next chapter takes it to `main` in a PR. To OK each landing first, declare
a `human:` at `proposed:`; see [the recipe](recipe.md).

## Next

Next: [Team mode](team.md) — the way we recommend working.
