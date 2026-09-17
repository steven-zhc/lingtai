# Onboarding, as a page

**Status** decided · 2026-09-15 · the design the wizard epic is cut from ·
**amended by [0046](../decisions/0046-lingtai-is-personal.md)**: the recipe is
this machine's, the wizard opens no pull request, and *pending* waits for
`Recheck` and no longer for a recipe to land (#180, #182). The sections that argued otherwise say so where
they stand.

Two drawings, and they are the record of the choice rather than decoration:
[the five models compared](https://claude.ai/code/artifact/e91bc22c-3b46-4bab-9f76-e73412489da6),
and [the one that was chosen](https://claude.ai/code/artifact/9a68272d-9362-4ed5-813c-11547aa51c27).

**The interface is English. There is no second language and no provision for
one** — that is a decision, not an omission, and a ticket that adds a
translation layer is a ticket that was not asked for.

## One team, one conductor, one recipe

The code assumes this everywhere and **no document says it**, which is how a
well-meaning person ends up running a second Lingtai against a repository the
team's is already working:

- `filter.ts` never reads `lingtai:working`. The queue is *what GitHub offers*
  minus *what my own `task_view` says* — a second installation has no idea the
  first one is working `#123`.
- `lock.ts` takes `pg_try_advisory_lock`, **scoped to one database**. `#93` stops
  two conductors on one log. It does nothing across two installations.

So both would claim, both would cut `agent/123`, and both would push to it.
`--force-with-lease` makes the second push fail, which makes the collision
*loud* rather than preventing it — after both have spent an agent.

**The topology is: one Lingtai per team, many people watching it.** That also
settles the question this design started from — *does each person get their own
recipe?* No, and the reason is the same as `AGENTS.md`: the conventions live with
the code, are reviewed like code, and everyone who clones gets them. Per-person
recipes would make *why did this merge* unanswerable — the log records who
approved, but not under whose rules.

What legitimately varies per person is already outside the recipe: the secrets
in `~/.lingtai/env/<project>.env`, per machine, at 0600. Nothing else.

This deserves its own ADR, and the wizard's words follow from it: it onboards a
repository into **the team's** Lingtai, not *mine*.

## Where an onboarded project actually lives

There is no projects table. A project is two lines of SQL and a fold:

```sql
select distinct stream_id from events where stream_id like 'prj-%'
```
```ts
streams.map((s) => store.read(s).then(reduceProject)).filter(isRegistered)
```

Today that is **two rows in `events`** — `prj-lingtai` and
`prj-nextloom-ai-admin`, one `ProjectConfigured` each. `lingtai add` appends
that event and nothing else.

`isRegistered` is `project !== null && configHash !== null`, and `configHash`
only exists once a recipe has been read. **So "this repository has a recipe" is
already the line between registered and not** — the pending state needs no new
concept, only a first event on the stream.

## The constraint that decided the shape — superseded

> **Superseded by [0046](../decisions/0046-lingtai-is-personal.md) §3.** The
> recipe is `~/.lingtai/<project>/recipe.yml`, nothing is written to the managed
> repository, and the pull request below is gone (#182). What follows is kept
> as the argument that was made, not as what the page does.

ADR [0005](../decisions/0005-config-in-target-repo.md) puts the recipe in the
managed repository, and `lingtai add` says so in its own first paragraph:

> What it does *not* do is take a configuration file: the recipe belongs to the
> managed repository and is read from its base branch.

So a wizard that ends by saving a recipe **into Lingtai** would be building the
second source of truth 0005 exists to prevent. Its output is a file that has to
land in the repository, and it gets there as a **pull request**.

**Not for review — there is one operator.** For the thing a PR is when nobody
else reads it: *a diff you read before it lands*, rather than a file that
appeared. That argument is weak for a new recipe and strong for an edited one,
which is most of what this page will do after the first week.

## The second constraint: permissions before writing

`lingtai add` checks the App's installation and scopes **before** anything is
recorded, and its reason is a day that was lost:

> a fine-grained PAT that covered the admin repository's submodule but not the
> repository itself produced a day of 403s on CI, and nothing anywhere said
> "wrong scope".

The wizard inherits it and gets to do it better: a page can name *which*
permission is missing and link to the screen that grants it.

It also inherits the rule's spirit — **the wizard writes nothing of its own
accord until the last action**. No branch is cut, no event is appended. Abandon
the wizard halfway and the wizard has left nothing to clean up. (Labels need no
creating anyway: GitHub creates one the first time it is applied, so a recipe may
name `agent:hold` before that label exists. Naming a label nobody has used yet is
harmless, not dead configuration — this repository's own `exclude` names two.)

**`Hold all` is the one exception, and the rule is worded around it on purpose.**
It sits on the last screen, before the button, and it is not the wizard writing —
it is the operator, through the wizard. What it writes is `agent:hold` on every
issue the screen listed, in somebody's repository, visible to everyone and to
every other tool reading it, **with nothing on Lingtai's log recording that
Lingtai did it**, because the project has no stream until the button is pressed.
So *abandon and there is nothing to clean up* is true of everything the wizard
does by itself and false of that button: press it, close the tab, and twelve
issues still carry the label. Taking them off is the operator's, and **the screen
has to say so before they press it** — there is no undo here and no record to
read afterwards.

## Onboard, or adjust

**Step one reads the base branch.** If `.lingtai/config.yaml` is already there,
the wizard loads it and becomes an **update flow** — the same page, the same two
speeds, with the fast lane filled from the file instead of from a scan.

**The update must be surgical, and this is the one place the implementation can
be wrong in a way nobody notices.** `yaml@2.9.0` is already a dependency and its
`parseDocument` + `setIn` preserve comments through an edit — verified. The naive
implementation, parse to an object and re-emit, **silently destroys 74 of this
repository's 503 recipe lines**, and those comments are the reason anyone dares
change the file. A ticket that says "update the recipe" without saying *how* is a
ticket that will be done the wrong way.

## The design: two speeds

**Most of onboarding is Lingtai reading the repository back to you**, and it
should go past in seconds. Two of the answers will still be in force months from
now. The page runs at two speeds, and **the speed is the signal** — no colour
legend to learn first.

Three states, and a line moves one way through them:

| | |
|---|---|
| **fast row** | Filled in already. Never becomes a question. Always carries `change`. |
| **decision** | Opens as a question in words, with its consequence written out. |
| **settled** | An answered decision, **collapsed back to one line**. |

**The collapse is the mechanism.** Without it a scrolling wizard grows forever
and is worse than a stepper. With it the page is always a short list of settled
facts plus one open question — simple to read, and still entirely configurable,
because every settled line says `change`.

### Fast

| row | filled from |
|---|---|
| `repo.base` | GitHub's default branch |
| `repo.submodules` | is there a `.gitmodules` |
| `source.kinds` | the labels the repository actually has |
| `source.exclude` | a recommended set. The labels need not exist yet |
| `gates.proposed` | **every script found, with the guesses ticked** |
| `env.required` | the names in `.env.example`, never the values |
| `runtime.agent` | `claude-code` or `codex` — `lingtai doctor` already detects which is signed in |
| `gates.end` | close the issue when it lands |

**`gates.proposed` shows all of them, not just the guess.** This repository is
the counter-example to naive detection: its real build is `pnpm typecheck && pnpm
test && pnpm test:db`, and a detector that reads `scripts.test` produces `pnpm
test` — **silently dropping the database half that `#158` split out**. Listing
every script turns that failure into an unticked box you can see.

Both managed repositories are monorepos, so this is the normal case, not the edge.

### Slow

| | the question, in words |
|---|---|
| `gates.merge` | *Does a person approve the merge?* |
| `runtime.limits` | four dials, and the sentence underneath them |

**Two, and an agent review at `proposed` was the third candidate.** It costs
money, which is the usual reason to slow down — but it is **reversible and cheap
to be wrong about**, so it rides fast with a default. That is the criterion, and
it is the one thing this design can get wrong:

> A fast row must be something a person can get wrong and fix in a minute.
> A slow one must be something they cannot.

**`limits` is four dials, not three presets** — `turns`, `wall`, `rounds`,
`restarts` ([0040](../decisions/0040-rounds-bound-depth-restarts-bound-breadth.md):
rounds bound depth, restarts bound breadth). Underneath them, recomputed as they
move, is **`passCeiling`'s own sentence** — the same function `lingtai status`
and `lingtai add` print:

> *up to 4 agent runs — the work, then 3 rounds back to the agent carrying what
> refused it. 1h and 150 turns each … so at most 2 passes, 8 agent runs and 8h
> before it is yours*

Settable and consequential at once, in the product's own words rather than
invented copy. Defaults: `turns 300 · wall 2h · rounds 2 · restarts 0`.

**No money, anywhere.** A new repository has no cost history, so a dollar figure
would be fabricated — and there is no money field in the recipe to set. Runs and
hours are exact; those are what is shown.

### The one place a default flips

If the scan finds **no checks at all** — no test, no typecheck, nothing for
`gates.proposed` — then with `merge: []` the whole chain is *an agent writes
code, nothing checks it, it lands in the base branch, nobody read it*. Many
repositories have no tests, so this is not hypothetical.

**That is the only case the wizard argues with.** The merge question's default
flips to *a person approves*, and the last screen says it plainly:

> Nothing checks a diff before it merges. Every ticket goes from an agent
> straight into `develop`.

### The palette: ink blue, brass, and a dot ground

[Drawn here](https://claude.ai/code/artifact/97669fb4-ff16-454f-9ffd-406a54257c3b).
Five families were compared before this one; the losing ones are in
[the skins](https://claude.ai/code/artifact/421972a0-d344-47ef-9520-518f5d944221),
[the paper family](https://claude.ai/code/artifact/5fea273c-19f1-4375-aecc-fd3113f92f67)
and [the cool three](https://claude.ai/code/artifact/66bdeff9-c286-4e36-8a4c-d88b81750607).

```
#123A8C   ink blue      structure — what Lingtai worked out
#B0741A   brass         where a person is being waited on
#0E1420   ink           #616B7C muted   #DCE1E8 rule
rgba(18,58,140,.17)     the dot ground, 18px
```

**Two colours, two meanings, and the second one is the board's already.** The
board's `--signal: #9c5a08` means *a person is waited on*; the brass above is it.
That is continuity rather than invention, and it leaves `pass`, `fail` and `held`
free for the board — which a single-accent palette would not have.

**The dots are tinted with the accent**, not grey: a neutral dot on a blue page
reads as dirt, a blue one reads as paper belonging to this palette. Panels are
opaque, so the grid is always a ground and never a texture behind text.

**And the dots are the one mark on the page that means nothing.** Everything else
carries something — blue is structure, brass is a person waiting, a tick is
read-not-asked, a red word is a script found and not picked. What the dots buy is
that a white panel has somewhere to sit, so the fast lane reads as one object
rather than as a bordered list. **Keep them, and delete them the first time they
make anything harder to read** rather than defending them.

A green accent was tried and rejected: the board's `--pass` is green, and the
page's own sentence — *"a **green** ticket goes straight into `develop`"* — would
use green to mean *passed* in words and *waiting* in paint, three centimetres
apart.

## The last screen is the queue, not a warning

`selectRunnable` is *what GitHub offers* minus *what `task_view` says*. A
repository that has never run has no `task_view` rows, so the first pass is
**exactly computable** from the kinds and exclude just chosen. The last screen is
therefore `lingtai status` for a project that does not exist yet:

```
The next pass will take these, in this order
  1  #412  bug      Search box drops the last keystroke
  2  #398  bug      Importer times out over 2MB
  …  9 more
12 runnable · 18 passed over — excluded-label 14, no-kind 4

[ Hold all 12 ]  adds agent:hold to all 12. The labels stay if you leave this page.
```

Onboarding takes work immediately — that is the decision, and this screen is what
stands between it and thirty tickets. *Walk away and wake up to thirty merged
PRs* becomes *you saw the list before you pressed the button.*

**`Hold all` is offered and never taken automatically.** It is thirty API writes
and thirty timeline entries in the repository; that is the operator's to spend.

**It is also the one thing on this page that outlives the page** — the exception
to *nothing is written until the last action*, set out above. The labels go on
GitHub and stay there whether or not the button is ever pressed, and the project
has no stream yet, so nothing on Lingtai's log will say they were applied or by
whom. Hence the annotation beside the button rather than a tooltip: the sentence
an operator needs is *these stay*, and they need it before pressing, because
afterwards there is nothing to read and nothing to undo.

**The label it writes is `agent:hold`, or there is no button.** `source.exclude`
is free-form, so an operator's own excludes may be `wontfix` or `epic` — and
stamping `wontfix` across twelve open bug reports is a sentence about them that
Lingtai is not entitled to write. `agent:hold` is the one name Lingtai defines as
meaning *not yet*, so a recipe that does not exclude it gets the reason instead
of the button, and ticking `agent:hold` back into the excludes is one action away
on the same page.

Before any of it: **the generated recipe is parsed with the system's own
`Recipe.parse`**. A file written and then refused by `lingtai add` would be a bad
recipe on this machine, where the next thing to read it is a run. `source.kinds` has `.min(1)`, so the page must also stop
you unticking the last kind rather than letting the parse catch it at the end.

## Pending, and a button

The wizard ends on this machine: the recipe written to
`~/.lingtai/<project>/recipe.yml`, and the event. **Nothing is written to the
repository and nothing waits on a merge** (0046 §3, #182). Then:

```
wizard finishes   → ProjectOnboardingStarted { slug, base, by }   ← the stream's first event
board shows       → a card: pending, with Recheck
Recheck           → ask GitHub for the App's installation on the repository
  not installed   → unchanged, and it says so: install the App, then press again
  installed       → the existing lingtai add path: scopes, the machine's recipe,
                    ProjectConfigured, and it is live
  add refuses     → unchanged, and everything add said: a missing scope, a recipe
                    that does not resolve
```

**Pending no longer waits for a recipe to land**, which 0046 made impossible —
nothing lands in the repository any more. **Nor does it wait for the App to be
installed.** The wizard's scan and its button both build their client on the
installation on that repository and refuse without one, so a pending project had
one when it was recorded; *not installed* at `Recheck` means removed since.
What a pending card is waiting for is somebody pressing `Recheck`, and what can
still refuse is `add`'s own checks. A repository the App has never been installed
on never reaches pending: that is #168's first screen, before the wizard.

**No watcher, and that is deliberate.** The board is a page and cannot follow a
repository for hours; the daemon does not know repositories it has not
onboarded. `Recheck` is the second half.

The daemon cannot touch a pending project either, and not because we guarded it:
`loadProjects()` has filtered on `isRegistered` since before this existed.

**The board must survive a pending card.** Its Queued column asks GitHub on
render, and a pending project is not registered — `currentRecipe` would be asked
about a project nothing conducts. One card that is not ready must not redden the
page.

## What it does not do

- **It does not run `lingtai add` for you.** `add` checks the installation's
  scopes and resolves the recipe, and either can refuse after the wizard has
  written; `Recheck` is the second half.
- **It never takes a secret.** `env.required` names variables; values go through
  `lingtai env set`, which reads them from stdin unechoed. Nothing is typed into
  a web page.
- **It does not show `runtime.tier`.** That concept is configured in the agent
  itself, or in `AGENTS.md`. It is still in the recipe schema
  (`recipe.ts:476`) and whether that field should exist at all is a separate
  question, not this page's.
- **It generates the comments.** A recipe with none is a file nobody edits, so
  the sentences the wizard showed are written into the YAML it proposes.

## Out of scope, named so nobody builds it by accident

- **Authentication.** Today `actor()` is `human:${process.env.USER}` — whatever
  the OS says, unverifiable, meaningless across machines. Real identity is a
  separate epic; its cheapest shape is GitHub OAuth on the board, with authority
  delegated to the repository (*can you push here? then you can approve here*),
  and it needs no event change: `human:<id>` stays, the `<id>` becomes true. The
  real cost is not OAuth — it is that a board reachable from a network holds the
  App key and can merge code.
- **Editing another project's recipe from this project's board.** One page, one
  repository.
- **A second language.**
