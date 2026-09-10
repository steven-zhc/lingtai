# 0035 — The site is a projection of this repository, and its hero is the real board

**Status** accepted · 2026-09-09

## Context

Everything a stranger could learn about Lingtai was in a repository README and
thirty-four ADRs. There was no page that said what it does, and no readable
form of the documentation that already exists as files.

`#114` opened as an epic, and an epic that fans out into sub-tickets needs its
decisions stated **once**, somewhere all of them can cite — otherwise the
second ticket relitigates what the first settled, and the two halves of the
site disagree about what it is for. This file is that statement. It records
what `#114` decided; `apps/site` is the first build against it.

**What Lingtai is, stated once.** *The harness you put around a coding agent so
you can leave it running.* It takes issues one at a time, gives each a
disposable worktree and a filtered environment, holds it at the gates the
repository defines, and merges only what passes them.

**What it is not** is a record-keeping product. The event log is *why the
promise is credible*, not the promise. Nobody arrives wanting a record; they
arrive wanting the queue to move without them watching it. So the log belongs
under "when it goes wrong", and never in the hero.

## Decision

### 1. The hero is Lingtai's own board, generated at build time

Real lanes, real tickets, real figures, read from the log by
`apps/site/scripts/snapshot.ts` and written to a file the build renders. **Not
live.** A marketing site holding a connection to the event store is a coupling —
the page goes down when the database does — and an exposure, because not every
project on that board is public. `output: "export"` in `next.config.ts` makes
it structural rather than habitual: there is no server at the other end of a
request, so a page cannot grow a query without that line being deleted first, by
somebody who has to explain why.

**All four lanes, including the stuck one.** A board showing only wins is the
one nobody believes, and *"one ticket is blocked on you, 20 hours, $13.04"* is a
more persuasive claim about a harness than any adjective. The snapshot is
stamped with the date it was taken, because a board with no date is a board
claiming to be now.

Two rules follow from the private project:

- **A card is withheld, never dropped.** A card from a project that is not named
  in `LINGTAI_SITE_PUBLIC_PROJECTS` keeps its lane, its age, its attempts and
  its money and loses everything that names it. Dropping it would change the
  lane counts and the totals, which are the figures the page makes its claim
  with, and a board that quietly omits some of its work is the board nobody
  should believe.
- **Nothing is publishable by default.** The safe failure is a board of withheld
  cards; the unsafe one is a private repository's issue titles on the internet.

And one rule from having no log at all: **the generator refuses to invent a
board.** With no `LINGTAI_DATABASE_URL` it writes nothing and the page says it
has no snapshot. It writes nothing for an empty `task_view` too — an idle system
and an unbuilt projection produce the same zero rows, and neither is evidence of
anything.

### 2. The docs are a projection of `doc/`, never a copy

`tutorial.md`, `architecture.html`, `reference.md`, `operating.md`,
`decisions/` and `experiments/` already exist. The site **renders those files**
at build time. It does not fork them.

Two truths is what this project deleted a whole subsystem to avoid
([0022](0022-the-seams.md)), and documentation that drifts from the repository
is worse than none — it is confidently wrong. Three consequences are load
bearing:

- **The links are rewritten, and the files are not.** A doc file's links are
  written for somebody reading the repository. Editing them to suit the site is
  the fork; resolving them at render is not.
- **The index is generated**, including each decision's status, which is read
  out of `doc/README.md` because that is where this repository keeps it.
- **`architecture.html` is carried, not converted.** It is a thousand lines of
  hand-written HTML with its own diagrams. Rendering it through the markdown
  pipeline would mean rewriting it, which is the fork again.

What is published is an **allow-list** — `doc/` holds a backlog script and a
market study as well as documentation, and a projection that publishes whatever
it finds eventually publishes something nobody meant to. The cost of an
allow-list is what it silently omits, so it does not: every markdown file in
`doc/` that no section takes is listed on the docs index, with a link to it on
GitHub.

### 3. The palette extends the product's, and coral is the way in

Every token comes from `apps/board/src/app/globals.css`, which the site's layout
imports rather than reproduces. **A site that looks unlike the product is a
promise the product breaks**, and the cheapest way to keep that promise is to
have nowhere else to get a colour from. The hero renders `.col`, `.card` and
`.pill` because those *are* the board, not because they were made to look like
it.

One addition, licensed by the app's own comment: coral `#FD5D3F` is held out of
the product palette because *"a third strong hue would make the reader ask what
it means, and the honest answer is nothing — it is the logo."* **A site has no
states to confuse**, so coral is finally spendable — and it gets a rule as
strict as amber's: **it marks the way in and nothing else.** One `.way-in` per
page. If a second thing on a page is coral, one of them is not the way in and
the reader has to decide which, which is the question the board refuses to make
anyone answer.

### 4. Two faces, and the range comes from scale

IBM Plex Sans and IBM Plex Mono — what the product uses. **No serif**, including
in long documentation: it would read a little better and it is the one move that
would make this look like every other docs site. Comfort comes from measure and
leading (`--measure`, and the `.prose` block in `site.css`).

### 5. What is not built goes on the front page

`lingtai doctor` prints an unimplemented check as `skip` rather than omitting
it, because *a check you cannot see is a check you will forget you never had*.
The site keeps that posture: an **Open** section naming what does not work —
`admit` and `merge` running nothing (`#58`), `seq` not being gapless,
`tier: sandboxed` not existing, a daemon holding the code it started with, and
forward compatibility stopping at the store.

For a product whose claim is that you can see what happened, **hiding the gaps
contradicts the pitch.** It is likely the most persuasive section on the page.

### 6. The name is not explained — yet

[0017](0017-the-project-is-called-lingtai.md) records the rename and what it
moved. **The project has never stated what 灵台 means**, and a landing page is
the wrong place for a claim the project has never made. If it is to have a
stated meaning, that is an ADR first and a headline second.

## Consequences

- `apps/site` joins the workspace: a Next.js app with `output: "export"`, built
  by `pnpm build` like everything else, and servable as a directory of files.
- Two build steps precede `next build`, and both are generators rather than
  authors: `doc-assets.ts` carries the HTML documents into the export, and
  `snapshot.ts` takes the board. Neither's output is committed — a copy in git
  is a second file to keep in step, which is the failure this file is about.
- **The site is one more reader of `doc/`, so a document's shape now has a
  second consumer.** A guide rewritten to suit the site would be the fork; a
  guide that reads badly on the site is a fault in the guide.
- `LINGTAI_SITE_PUBLIC_PROJECTS` is a new name, and it begins `LINGTAI_` like
  every other name Lingtai reads for itself (`#63`).
- **No hosted service is implied anywhere.** Lingtai runs on your machine
  today, and no copy on the site may promise a signup.
- What `#114` still owes, and what this file does not settle: the guide that
  the epic ordered *after* the docs pipeline, and a real snapshot — which needs
  a build run beside the production log, and a decision from a person about
  which projects go in `LINGTAI_SITE_PUBLIC_PROJECTS`.
