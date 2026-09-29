# `file:`

Keeps the document a step made, as a file in the worktree, and answers with the
path. Without it a design is **bought, used once and cannot be kept**
([0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §1): it lived
in memory until the pass ended, and in one prompt. This is where the document goes
instead, and the path it went to is what **this action's** `evidence` carries.

**It does not take the design off the log, and §1 is not closed by declaring
one.** The drafter is a separate action with a `StepPassed` of its own, and it
still writes the document into that one — clipped to 60 lines and 8,000 bytes
since §8 (`command.ts`), where it used to go whole. So §1's third row is bounded
rather than gone: a rebuild still replays a design note's worth of event. What
this key buys is the locator, and a copy somebody can read after the pass; a
drafter that said a sentence instead once a destination had kept its document
would be a change to `createDraftAction`, and no recipe line turns it on.

## What it does

`createFileAction` in `packages/actions/src/file-action.ts` writes
`ActionContext.design.document` to the path, commits it to the branch, and
returns the path as the **locator** — a string, and the only thing that reads it is
this plugin (0066 §4). Nothing in `packages/conductor` parses a locator or checks
it against the plugin at the next step, which is what lets a `confluence:` join
beside it without the core learning a second kind
([0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md) §3).

**It keeps what the step made and makes nothing of its own.** The document comes
from an earlier entry in the same step's list, which `runActionPipeline` hands
forward — so it is written *after* the drafter, and one written first is refused.
Where the drafter answered that no design was needed there is nothing to keep: no
file, no locator, and `evidence` says so.

**It writes and it does not decide.** `design` may not refuse (0058 §3), so a
write that failed is `did-not-finish`: the pass stops for a person and buys no fix
round, because nothing was judged (0066 §7's second row).

## Where it may be declared

`design`, and nowhere else (`filePlugin.at` in `packages/recipe/src/recipe.ts`).
The refusal at the other nine is the sentence this page would otherwise
paraphrase:

> `file:` keeps what a step *made*, and `design` is the one step that makes
> something large (0066 §3) … Every other step answers with a verdict — a sentence
> the log already holds — so there is nothing at one for a destination to keep.

A second step that bought a document would declare this key beside its own drafter
and nothing in the plugin would change, which is the test 0066 §9 sets for whether
§4 held.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. |
| `file` | string | yes | Where the document goes, relative to the worktree. No `..`, not absolute, not under a home directory. `{{issue}}` in it becomes the ticket's number when the pass runs. |

**`{{issue}}`, and it is the only placeholder.** A fixed path keeps **one**
document — the newest — under a name the log handed to every pass: ticket A
lands, the sentence *wrote a 2.4 kB design to `doc/design/this-change.md`* is on
its `StepPassed` forever, and a week later ticket B is cut from a `main` that
already has A's file, writes over it, and merges cleanly. Following A's locator
then gives you B's document with nothing anywhere saying so — worse than a dead
link, because a dead link is obviously dead. Only `git log` remembers A. So
point `file:` at `doc/design/{{issue}}.md` and each pass's note lands at its own
path (`#310`, 0066 §1).

**`{{title}}` deliberately is not taken**, and a path that names it — or any
other `{{…}}` — is refused when the recipe resolves rather than written out
literally. A title in a filename is a slug problem: spaces, slashes, length, two
tickets under one title. None of that is worth deciding for a path, and leaving
it out as a refusal rather than as silence is what keeps a typo from committing
a file called `{{title}}.md` to `main` and putting *that* on the log as a
locator.

**The substitution happens when the action runs, not when the recipe resolves.**
`resolveRecipe` has no ticket — `lingtai add` and the daemon at start both run
before any queue pass — and it must not acquire one, because it produces
`configHash` *of the resolved form rather than the file's bytes*, so that a
replay asking *did results change after I edited the pipeline?* can answer from
it. A path expanded at resolve would make a recipe nobody edited hash
differently on every ticket, on every `RunStarted` and on `ProjectConfigured`.
The recipe resolves once per daemon; the path is one per pass.

So the path is judged **twice**, on two strings, at two times: the schema
refuses what a person wrote, before a worktree and before any money (0066 §6),
and `createFileAction` refuses what the ticket made of it, before it writes
anything. Both are `whyThePathEscapes`. Today a GitHub number cannot escape
anything; the second check is for 0036's named evolution to `{{ref}}`, where
Jira's is `PROJ-123` and a store's may carry a slash.

**One field beside `name`, and no flag for the commit.** 0066 left *whether the file is
committed* to this plugin; the answer is **always**, and the reason is that the
other answer keeps nothing. The worktree is removed when the pass ends — on every
ending, not just a landing — and what gets out past that is what the pass pushed,
which is commits. So an uncommitted note, and everything its locator points at,
is gone by the time anybody reads the card: §1's *bought, used once, and cannot
be kept*, which is the thing this key exists to end.

**And it could not have been honoured from inside the worktree anyway.** The
implementing agent works in the same tree and is told to commit with no staging
instruction, so it runs `git add -A` and an untracked note rides onto the branch
regardless — the hazard this repository already moved the run log out of the
worktree to avoid ([0034](../decisions/0034-the-run-log.md) §2). Keeping
one out would mean writing an exclude into the clone every pass shares: a second
mechanism, outside the pass, that 0066 §9 did not price.

So: the note is in the change. Point `file:` somewhere the change should carry a
design note — `doc/design/` in this repository — and not at a scratch path.

What the commit does **not** do is weaken `implement`'s receipt: that is
`head === startedAt`, read when `implement` starts, so a commit `design` made
cannot stand in for work the implementer did not do (`#265`).

## Examples

```yaml
# packages/conductor/unit/step-matrix.test.ts — `ACTION.file`, the probe
design:
  - name: shape it
    agent: claude-code
    prompt: read the ticket and the code, and write down the shape
  - name: keep the design
    file: doc/design/x.md
```

The whole arrangement: the drafter, then the destination. The locator on the card
is `doc/design/x.md`, the note is in the diff `review` reads, and the lane merges
it.

```yaml
# packages/recipe/unit/plugin.test.ts — two destinations, one document
  - name: the note in the repository
    file: doc/design/notes.md
  - name: and one beside the ticket
    file: doc/design/{{issue}}.md
```

Two keeps rather than one plugin with a list (0066 §5). The locator that crosses
to `implement` is the **last** one, because that is the result the document came
off (0069 §5). The second path is this ticket's and the first is not, so a second
pass overwrites `notes.md` and leaves `310.md` where it was — which is the whole
of what `{{issue}}` is for, shown as a pair.

## What it refuses

Refused when the recipe resolves — so `lingtai add` and `lingtai doctor` say it
without running anything, and a daemon restarted onto the file takes no ticket.

```yaml
design:
  - name: shape it
    agent: claude-code
    prompt: write down the shape
  - name: keep it
    file: ../../notes/x.md
```

> its "file" field is not what "file" accepts: "../../notes/x.md" is not a path
> inside the worktree — it contains a ".." segment, so where it lands depends on
> where the worktree is rather than on what is written here. A `file:` writes into
> the tree this pass owns and nowhere else, so the path is relative to it, with no
> `..` in it. Refused when the recipe resolves, before a worktree, before an
> agent, before any money.

An absolute path and one starting at `~` are the same refusal with their own
clause. The check is `whyThePathEscapes`, and it is string rules rather than
`node:path` so that the operator's machine and the daemon answer alike.

```yaml
design:
  - name: keep it
    file: doc/design/{{title}}.md
```

> "doc/design/{{title}}.md" names `{{title}}`, which a `file:` path does not
> take — `{{issue}}` is the one placeholder, and it becomes the ticket's number
> when the pass runs. A `{{title}}` in a filename is a slug problem — spaces,
> slashes, length, two tickets under one title — so it is left out on purpose
> rather than forgotten.

Refused rather than written out, because the file it would otherwise commit to
`main` is literally called `{{title}}.md` and the log would carry that path as
the locator somebody follows a year later — this key's own failure, reached by a
typo instead of by a fixed path.

**The second half of that sentence is about the placeholder you wrote**, not a
fixed paragraph about `{{title}}`: a `{{ref}}` is answered with 0036's rename
(*this field's own later spelling, and nothing has made it yet*), a
`{{ issue }}` with *the spelling is exact* rather than a lecture about slugs,
and anything else with why the list is one name long. A refusal that explains a
field the recipe does not mention reads as though the parser misread the line.

A path whose `{{issue}}` **expands** into something outside the worktree gets
the first refusal's clause, but at run time and on the card: `did-not-finish` at
`design`, nothing written, and a sentence naming both the path as written and
the ref it was given. Today no GitHub number can do that; 0036's `{{ref}}` and a
`PROJ-123` can, which is why the check is there rather than assumed away.

```yaml
design:
  - name: keep it
    file: doc/design/x.md
```

> it is the first action there, and a `file:` keeps what an earlier action made
> rather than making anything itself — so written first it has nothing to keep,
> and would pass having written no file and returned no locator. Write it after
> the action that drafts the document.

A `commit:` written beside the path is refused too — *"file" declares no
"commit" field* — which is 0061 §9's *a plugin refuses a field it does not
understand*, and the paragraph under **Parameters** is the reason there is none.

## Related

- [0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) — decided
  that a large answer is a locator on the log (§3) and that **where it lands is a
  plugin rather than a field** (§5); §6 is why a bad path is refused at resolve and
  §9 is what this key cost. It left *whether the file is committed* to this plugin,
  and the answer is **always**, for the reason under **Parameters**.
- [0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
  — decided that **both** the document and the locator reach `implement`, so a
  locator nothing at the next step can read is the ordinary case and not an error.
- `#265` — gave `design` an `agent:` that drafts, and made `implement`'s receipt
  `head === startedAt`, which is why committing here is a question about the change
  rather than about safety.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
