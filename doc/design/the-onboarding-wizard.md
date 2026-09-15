# Onboarding, as a page

**Status** decided · 2026-09-15 · the design the wizard epic is cut from

Two drawings, and they are the record of the choice rather than decoration:
[the five models compared](https://claude.ai/code/artifact/e91bc22c-3b46-4bab-9f76-e73412489da6),
and [the one that was chosen](https://claude.ai/code/artifact/9a68272d-9362-4ed5-813c-11547aa51c27).

**The interface is English. There is no second language and no provision for
one** — that is a decision, not an omission, and a ticket that adds a
translation layer is a ticket that was not asked for.

## The constraint that decides the shape

ADR [0005](../decisions/0005-config-in-target-repo.md) puts the recipe in the
managed repository, and `lingtai add` says so in its own first paragraph:

> What it does *not* do is take a configuration file: the recipe belongs to the
> managed repository and is read from its base branch.

So a wizard that ends by saving a recipe **into Lingtai** would be building the
second source of truth 0005 exists to prevent. Its output is a file that has to
land in **somebody else's repository**, and the honest ways to put it there are:

| | |
|---|---|
| Show the YAML, they paste it | Works everywhere, and leaves them alone with a file nobody has taught them to read |
| Commit to the base branch | The App can. It is also the one thing this system never does without asking |
| **Open a pull request** | **Decided.** Reviewable, revertible, and how everything else here lands |

A pull request also answers a question the wizard cannot: *is this recipe right
for this repository?* Nobody knows until somebody who works there reads it, and
a PR is where that reading already happens.

## The second constraint: permissions before writing

`lingtai add` checks the App's installation and scopes **before** anything is
recorded, and its reason is a day that was lost:

> a fine-grained PAT that covered the admin repository's submodule but not the
> repository itself produced a day of 403s on CI, and nothing anywhere said
> "wrong scope".

The wizard inherits that rule and gets to do it better: a page can name *which*
permission is missing and link to the screen that grants it, where a command can
only print a sentence.

## The design: two speeds

**Most of onboarding is Lingtai reading the repository back to you**, and it
should go past in seconds. Two of the answers will still be in force months from
now. So the page runs at two speeds, and **the speed is the signal** — no colour
legend to learn first.

Three states, and a line moves one way through them:

| | |
|---|---|
| **fast row** | Read from the repository and already filled in. Never becomes a question. Always carries `change`. |
| **decision** | Opens as a question in words, with its consequence written out. Two answers, each labelled with what it does. |
| **settled** | An answered decision, **collapsed back to one line**. |

**The collapse is the mechanism.** Without it the page grows forever and a
scrolling wizard is worse than a stepper. With it, the page at any moment is a
short list of settled facts plus one open question — which is why it reads as
simple while remaining entirely configurable: every settled line still says
`change`.

### What is fast

Asked of nobody; shown as filled-in:

| field | read from |
|---|---|
| `repo.base` | GitHub's default branch |
| `repo.submodules` | is there a `.gitmodules` |
| `source.kinds` | the labels the repository actually has |
| `gates.proposed` | `package.json` scripts, `Makefile`, `Cargo.toml`, `go.mod`, `pyproject.toml` |
| `env.required` | the names in `.env.example`, never the values |
| `gates.end` | close the issue when it lands |

### What is slow

| field | the question, in words |
|---|---|
| `gates.merge` | *Does a person approve the merge?* |
| `runtime.limits` | *What may one ticket spend before it comes back to you?* |

**Two, and an agent review at `proposed` was the third candidate.** It costs
money, which is the usual reason to slow down — but it is **reversible and cheap
to be wrong about**, so it rides in the fast lane with a default. That is the
criterion, and it is the one thing this design can get wrong:

> A fast row must be something a person can get wrong and fix in a minute.
> A slow one must be something they cannot.

### Neither number is shown as a number

`limits` is not four fields. It is a sentence with the total in it —

> *a ticket may spend up to 4 agent runs, 8 hours and about $18 before it comes
> back to you*

— with three presets behind it. The same rule governs `merge`: the choice is
written as what happens, not as `merge: []`. Both places are where being wrong is
expensive **and silent**, and a number does not say what it costs.

`merge: []` in particular is this repository's own configuration, and it
surprised its own operator. A page that prints it in words is worth having.

### The colours are the board's, unchanged

Teal is what Lingtai worked out. **Brass is where a person is being waited on,
and nothing else wears brass** — on this page or any other (0035 §3).

## What it does not do

- **It does not run `lingtai add`.** The recipe is read from the base branch, so
  the PR has to merge first. The last screen says so and offers to watch the PR.
- **It does not edit an existing recipe.** A managed repository has a recipe with
  somebody's reasons in its comments, and regenerating it would throw those away
  silently. Editing is a different shape and a later ticket.
- **It never takes a secret.** `env.required` names variables; the values go
  through `lingtai env set`, which reads them from stdin unechoed. The page shows
  the names and that command. Nothing is typed into a web page.
- **It generates the comments too.** This repository's own
  `.lingtai/config.yaml` is more comment than configuration, and those comments
  are why anybody dares change it later. A generated file with none is a file
  nobody will edit — so the sentences the wizard showed are written into the YAML
  it opens the PR with.

## Open, for the tickets to settle

- **Detection depth.** Reading `package.json` is one API call. Inferring targets
  from a `Makefile` is guesswork with a nice UI on top. Proposal: detect what is
  unambiguous, and where it is not, show the file and let the person pick a line.
- **The first screen has nothing to show.** Before a repository is connected the
  live recipe is empty, and that is the screen that has to be convincing.
  Proposal: it shows *what we found in your repository* rather than the file.
- **Who is it for the second time?** Somebody onboarding their fifth repository
  wants six clicks, not six questions. *Start from another project's recipe* may
  be worth more than any of this, and is cheaper. Separate ticket.
