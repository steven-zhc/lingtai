# `file:`

| | |
|---|---|
| **Does** | Keeps the document a `design` step made as a committed file in the worktree, and answers with the path as the locator. |
| **Write it at** | `design` — and nowhere else. |
| **Needs** | `file`: a path inside the worktree; `{{issue}}` in it becomes the ticket's number. No optional fields. |
| **Refuses** | `..`, an absolute or `~` path, any placeholder but `{{issue}}`, any step but `design`, `file:` written before the drafter. |
| **Watch out** | A fixed path keeps one document, the newest: the next ticket overwrites it and the first ticket's locator points at the wrong note. Use `{{issue}}`. |

Without it a design is **bought, used once and cannot be kept**
([0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §1): it lives
in memory until the pass ends, and in one prompt.

## What it does

`createFileAction` in `packages/actions/src/file-action.ts` writes
`ActionContext.design.document` to the path, **commits it to the branch**, and
returns the path as the **locator**, a string only this plugin reads (0066 §4).

- **It makes nothing**, so it goes *after* the drafter; if none was needed there
  is no file and no locator.
- **It writes and does not decide** (0058 §3): a failed write is
  `did-not-finish`, the pass stops for a person, no fix round.
- **The design stays on the log**, clipped to 60 lines / 8,000 bytes, in the
  drafter's `StepPassed`; this key adds the locator and a copy.
- **The commit is always, with no flag** (the worktree is removed on every
  ending; only commits get out): a `commit:` field is refused (0061 §9).

## Where it may be declared

`filePlugin.at` is `{ design }`: *the one step that makes something large
(0066 §3) … Every other step answers with a verdict — a sentence the log already
holds — so there is nothing at one for a destination to keep.*

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. |
| `file` | string | yes, no default | Where the document goes, relative to the worktree: no `..`, not absolute, not under `~`, no empty segment. `{{issue}}` becomes the ticket's number when the pass runs. |

- **`{{issue}}` is the only placeholder**, expanded when the action runs, not at
  resolve (the resolved recipe is hashed and has no ticket). `{{title}}` is
  refused on purpose, so a file literally named `{{title}}.md` is never committed.
- **The path is judged twice**: the schema on what you wrote, `createFileAction`
  on what the ticket made of it (`did-not-finish`, nothing written).

## Examples

```yaml
# packages/conductor/unit/step-matrix.test.ts — `ACTION.file`: drafter, then destination
design:
  - {name: shape it, agent: claude-code, prompt: read the ticket and write down the shape}
  - name: keep the design
    file: doc/design/x.md
```

```yaml
# packages/recipe/unit/plugin.test.ts — two destinations; the last locator reaches implement (0069 §5)
design:
  - {name: shape it, agent: claude-code, prompt: write down the shape}
  - name: the note in the repository
    file: doc/design/notes.md
  - name: and one beside the ticket
    file: doc/design/{{issue}}.md
```

```yaml
# #310 — a path per ticket, so each pass's note lands at its own file
design:
  - {name: shape it, agent: claude-code, prompt: write down the shape}
  - name: keep it
    file: doc/design/{{issue}}.md
```

## What it refuses

All when the recipe resolves, before a worktree or any money.
```yaml
design:
  - {name: keep it, file: ../../notes/x.md}   # absolute and ~ paths: same refusal, own clause
```

> its "file" field is not what "file" accepts: "../../notes/x.md" is not a path
> inside the worktree — it contains a ".." segment, so where it lands depends on
> where the worktree is rather than on what is written here. A `file:` writes into
> the tree this pass owns and nowhere else, so the path is relative to it, with no
> `..` in it.

```yaml
design:
  - {name: keep it, file: "doc/design/{{title}}.md"}   # `{{ref}}`, `{{ issue }}`: own clause each
```

> "doc/design/{{title}}.md" names `{{title}}`, which a `file:` path does not
> take — `{{issue}}` is the one placeholder, and it becomes the ticket's number
> when the pass runs. A `{{title}}` in a filename is a slug problem — spaces,
> slashes, length, two tickets under one title — so it is left out on purpose
> rather than forgotten.

A `file:` first in its list is refused too (*it is the first action there, and a
`file:` keeps what an earlier action made*): write it after the drafter.

## Related

- [0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) — decided
  that a large answer is a locator on the log (§3), **where it lands is a plugin
  rather than a field** (§5), and a bad path is refused at resolve (§6).
- [0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
  — decided that **both** document and locator reach `implement`.
- `#265` gave `design` an `agent:` that drafts; `#310` added `{{issue}}`.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
