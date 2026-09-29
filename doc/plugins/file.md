# `file:`

Keeps the document a step made, as a file in the worktree, and answers with the
path. Without it a design is **bought, used once and cannot be kept**
([0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §1): it lived
in memory until the pass ended, in one prompt, and on `StepPassed.evidence` as the
whole document — uncapped, and carried again on every replay of the log to show
somebody a page they will read once, if ever. This is where the document goes
instead, and the path it went to is what `evidence` carries.

## What it does

`createFileAction` in `packages/actions/src/file-action.ts` writes
`ActionContext.design.document` to the path, commits it if the recipe said to, and
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
round, because nothing was judged (0066 §7's second row). The commit does not
weaken `implement`'s receipt — that is `head === startedAt`, measured after this
step (`#265`).

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
| `file` | string | yes | Where the document goes, relative to the worktree. No `..`, not absolute, not under a home directory. |
| `commit` | boolean | **yes, and undefaulted** | Whether the file is part of the change. See below. |

**`commit:` has no default on purpose**, and it is the one field whose two values
are two different products. Committed, the note rides the branch through `build`
and `review` and the lane merges it — which for a repository's own design document
is the point, and for a one-ticket brief is noise in every diff. **Uncommitted, it
does not survive the pass**: the worktree is removed when the run ends, so the file
and the path that locates it are both gone before anybody can follow either. Both
are real answers, so a recipe that does not say is refused — `worktree:`'s
`submodules` argument (`#268`).

## Examples

```yaml
# packages/conductor/unit/step-matrix.test.ts — `ACTION.file`, the probe
design:
  - name: shape it
    agent: claude-code
    prompt: read the ticket and the code, and write down the shape
  - name: keep the design
    file: doc/design/x.md
    commit: true
```

The whole arrangement: the drafter, then the destination. The locator on the card
is `doc/design/x.md`, the note is in the diff `review` reads, and the lane merges
it.

```yaml
# packages/actions/unit/file-action.test.ts — the uncommitted brief
  - name: keep it for this pass
    file: .lingtai-design.md
    commit: false
```

A one-ticket brief: `build` and `review` read it off the working tree, it is in
nobody's diff, and it is gone with the worktree.

```yaml
# packages/recipe/unit/plugin.test.ts — two destinations, one document
  - name: the note in the repository
    file: doc/design/notes.md
    commit: true
  - name: and a copy the gates can read
    file: .lingtai-design.md
    commit: false
```

Two keeps rather than one plugin with a list (0066 §5). The locator that crosses
to `implement` is the **last** one, because that is the result the document came
off (0069 §5).

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
    commit: true
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
    file: doc/design/x.md
    commit: true
```

> it is the first action there, and a `file:` keeps what an earlier action made
> rather than making anything itself — so written first it has nothing to keep,
> and would pass having written no file and returned no locator. Write it after
> the action that drafts the document.

An omitted `commit:` is refused the same way — *expected boolean, received
undefined* — and that is the field having no default rather than a strictness
about shape.

## Related

- [0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) — decided
  that a large answer is a locator on the log (§3) and that **where it lands is a
  plugin rather than a field** (§5); §6 is why a bad path is refused at resolve and
  §9 is what this key cost. It left *whether the file is committed* to this plugin,
  which is `commit:`.
- [0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
  — decided that **both** the document and the locator reach `implement`, so a
  locator nothing at the next step can read is the ordinary case and not an error.
- `#265` — gave `design` an `agent:` that drafts, and made `implement`'s receipt
  `head === startedAt`, which is why committing here is a question about the change
  rather than about safety.
- [`plugins/index.md`](index.md) — the thirteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
