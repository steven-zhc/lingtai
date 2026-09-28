# 0066 — A large answer is a locator on the log, and where it lands is a plugin

**Status** accepted · **Date** 2026-09-28 · **Changes** 0065 §4 (the ten
defaults gain a shape for `design`), and the way `agent:` reports what it wrote

## Context

### The design step is built, has never run, and cannot keep what it makes

`design` has been the recipe's since `#265` and no recipe has declared it. The
step produces a document and hands it to `implement` as its brief (0058 §3), and
that is all it does: `createDraftAction` returns the text, `renderPrompt` puts it
at `{{design}}` or appends it, and `WroteTheDesign.design` carries it on the
in-memory ending.

**What persists is the whole document inside `StepPassed.evidence`.** That is
where it goes today, uncapped — while a `run:` action's evidence is bounded at 60
lines and 8,000 bytes before it ever reaches an event (`command.ts`, *Enough to
act on, bounded*). One action kind knows to clip what it writes to the log and
the other does not, and the one that does not is the one whose output a model
chose the length of.

`runtime.budget.evidence` does not cover this: it is how much of an earlier
failure's output the **next prompt** carries, not what an event may hold.

### An event is read far more often than it is written

`task_view` and `finding_backlog` are folds, and a rebuild replays the whole log.
A document on an event is carried on every replay, every projection rebuild and
every read of that run — to give a person something they will look at once, if
ever. The size is not the whole cost; the cost is that it is paid repeatedly.

### The economic argument, which is the reason this is worth building

A design that is real work — read the ticket, read the code, write down the shape
and the decision — is what makes the implementing agent's job smaller. **A
smaller job can be done by a smaller model.** Today `implement` is the most
expensive run in a pass: 151 turns and $20–26 on each of the three tickets that
hit the wall on 2026-09-27/28, against $1.78 for the pass that started from an
existing branch.

So the question *is the design worth buying* has an answer that is not about
taste: it is worth buying if it lets a cheaper model implement. **That
measurement is impossible while the design is a paragraph in a prompt.** It needs
to be a thing with a location, that a person and a later measurement can both
read.

### And a document has more than one home

A repository wants its design note in the repository, reviewed with the change
and merged with it. An organisation that keeps its designs in Confluence wants it
in Confluence, with the ticket carrying a link. Those are not two values of a
setting: one writes a file into a worktree that `build` and `review` then see,
and the other makes a network call and touches no file at all.

## Decision

### 1. What a step produces and what the log records are two different things

An action that makes something large returns **both**: the thing, for whatever
in the pass needs it, and a **locator**, for the log.

For `design` that is the document — which still reaches `implement`'s prompt
exactly as it does today, because the economic argument above depends on it — and
a string saying where the document went.

**`evidence` then becomes what it is for**: a sentence a person reads on a card.
*Wrote a 2.4 kB design to `doc/design/x.md`, 12 turns, $0.38* — not the document.

### 2. The locator is a string, and only the plugin that wrote it knows what it means

Not a union, not a tagged shape, not a path type. A `file:` plugin's locator is a
repository path; a `confluence:` plugin's is a page URL; something else's is
whatever that something else can read back.

**The pipeline must not learn to parse it.** This is 0031 §1's rule — a
classification lives where it is known — applied to a location: the moment the
core understands three kinds of locator, the fourth destination is a change to
the core rather than a plugin.

### 3. Where it lands is the plugin, not a field

`file:` and `confluence:` are two plugins, not one plugin with a `destination:`
field. They do different things — one writes into the tree the next steps read,
the other makes a network call — fail differently, and are configured with
different fields.

**And a shared plugin with a field only one destination uses is the trap this
repository has now hit twice**: `worktree.submodules` (`#268`) and `queue`'s
three shared fields (`#269`) both let a half-written block silently change
behaviour. A plugin per destination has no half-written block to write.

`PLUGINS` is not closed against this. Its own docblock says so: *the set is not
closed against new work … a plugin doing something no code did before joins the
same set by the same rules — a key, a schema, and an `at` saying which steps it
serves.* `refs:` (`#240`) is the precedent.

### 4. A configuration error is refused when the recipe resolves

A locator whose shape is wrong, a missing field, a destination with no
credentials named: **refused before a worktree, before an agent, before any
money**, which is what the rest of the schema already does and says in those
words.

This is the important half of the failure story, because of what the alternative
costs: a configuration error that survives to run time is retried **every hour**,
and each retry claims the ticket, cuts a worktree and fails again.

### 5. Three failures, three endings, and only one of them waits for a person

`design` **may not refuse** — 0058's rectangle list — so none of these buys a fix
round. What it may do is arrive at the router, which 0058 separates from refusing
in one sentence: *arriving at the router and refusing are different things, and
only one of them is charged for.*

| what happened | ending | what it costs |
|---|---|---|
| the recipe is wrong | refused at resolve | nothing; the daemon claims nothing until a person fixes the line |
| the destination was briefly unreachable | `did-not-finish` | the pass stops, the item is released, the recipe's backoff retries it |
| the destination needs a person | `did-not-finish` carrying `needs-input` | reaches `proposed`, and with no judge declared, a person — **and buys no round** |

The third row is the one worth having and it is why `#294` matters: without a
`needs-input` from `design`, a plugin that needs a person has no way to say so.

**What this ADR does not settle** is which runtime failures are the second row
and which are the third. *Unreachable* and *needs a person* are the same event
seen at two moments, and only measurement says where the line is. Start with the
second row for everything, and move a failure to the third when it is seen to
retry without ever succeeding.

### 6. `agent:`'s evidence is bounded, wherever it is declared

Independent of any of the above, and true today: what an `agent:` action writes
into `evidence` is clipped before it reaches an event, the way a `run:` action's
already is. The numbers are `command.ts`'s until something argues for others.

This is not part of the locator design — it is the bug that design made visible,
and it is worth fixing whether or not a `file:` plugin is ever built.

## What this does not decide

- **Whether `design:` should be declared on this machine.** That is a recipe
  change and a separate judgement, and it should follow the first `file:` plugin
  rather than precede it.
- **Whether the design document is committed.** A `file:` plugin writes into the
  worktree; whether that file is committed, and therefore read by `review` and
  merged by the lane, is the plugin's own decision and needs its own sentence.
  `#265`'s guard (`head === startedAt`) means a design commit can no longer stand
  in for the implementer's receipt, so the question is about what belongs in the
  change rather than about safety.
- **Whether `implement` can then be a smaller model.** That is the thesis this
  design exists to make testable, not a claim it establishes. `runtime.limits`
  and `runtime.agent` are per-pass today, not per-step; a cheaper `implement`
  needs that to move, and that is its own ticket.

## Related

- [0058](0058-lingtai-is-a-development-pipeline.md) §2 — which steps may refuse,
  and the sentence separating that from arriving at the router.
- [0065](0065-the-default-is-a-plugin.md) — the default at a step is a plugin;
  `design`'s default is deliberately nothing, and stays nothing.
- [0064](0064-a-plugin-declares-the-steps-it-implements.md) §4 — a plugin
  declares its own `at`, which is what lets a new destination join without the
  core learning about it.
- [0031](0031-a-run-that-never-started.md) §1 — a classification lives where it
  is known. §2 of this decision is that rule applied to a location.
- [0037](0037-an-extension-is-a-command.md) — an extension is a command. A
  destination plugin is the other kind of extension, and the difference is worth
  stating: `run:` extends what a step *checks*; these extend where an answer
  *goes*.
- `#294` — `design` may ask, and nothing can produce the token yet.
