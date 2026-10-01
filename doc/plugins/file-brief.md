# `file-brief:`

| | |
|---|---|
| **Does** | Reads the design back from the path a `file:` kept it at, so the agent is briefed with what is on the branch. |
| **Write it at** | `implement` — and nowhere else, and before the `agent:` it briefs. |
| **Needs** | `file-brief: true`, and a `name`. There is no path field and no other option. |
| **Refuses** | Any step but `implement`; written last in its step; a `file:` field. |
| **Watch out** | A locator it cannot read (not a worktree path) is not a resolve-time refusal: the step ends `did-not-finish` and the pass stops for a person. |

Reads the design back from the path a `file:` kept it at and hands it to the
actions after it. Without it the agent is briefed from the pass's in-memory
copy, and the locator is a fact nothing at `implement` uses.

## What it does

`createFileBriefAction` in `packages/actions/src/file-brief-action.ts` reads the
file `ActionContext.design.locator` names inside the worktree and answers with
its text, so the `agent:` after it is dispatched with what is on the branch.

- **A path in the worktree and nothing else** (the same rule `file:` enforces on
  what you write). Any other locator ends the step `did-not-finish`.
- **It reads and does not decide.** `implement` may not refuse, so every failure
  is a `did-not-finish`: no fix round, the pass stops for a person.
- **It owns the disagreement**: where the pass's copy and the kept one differ, it
  prefers what it read.

## Where it may be declared

`implement` only (`fileBriefPlugin.at` in `packages/recipe/src/recipe.ts`). The
refusal at the other nine steps:

> `file-brief:` reads the design back from wherever a `file:` kept it, and
> `implement` is the step a design is *for* … at `design` there is no locator
> yet, and at every later step the change has already been written.

It must come **before** the agent it briefs. Declaring anything at `implement`
replaces the default, so declare the agent beside it.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. |
| `file-brief` | `true` | yes | `true` and nothing else. |

**No path, on purpose:** a path here would be a second answer to the locator's,
and whichever disagreed would win silently.

## Examples

```yaml
# packages/actions/unit/file-brief-action.test.ts — the pair, end to end
design:
  - {name: shape it, agent: claude-code, prompt: write down the shape}
  - {name: keep the design, file: doc/design/x.md}
implement:
  - {name: read the design back, file-brief: true}
  - {name: write the change, agent: claude-code, prompt: ""}
```

```yaml
# packages/conductor/unit/step-matrix.test.ts — no `design:` block: legal and inert
implement:
  - {name: read the design back, file-brief: true}
  - {name: write the change, agent: claude-code, prompt: ""}
```

```yaml
# packages/actions/unit/file-brief-action.test.ts — two keeps; the last locator is read
design:
  - {name: shape it, agent: claude-code, prompt: write down the shape}
  - {name: the note in the repository, file: doc/design/notes.md}
  - {name: and one beside the ticket, file: doc/design/301.md}
implement:
  - {name: read the design back, file-brief: true}
  - {name: write the change, agent: claude-code, prompt: ""}
```

## What it refuses

```yaml
implement:
  - {name: write the change, agent: claude-code, prompt: ""}
  - {name: read the design back, file-brief: true}
```

> it is the last action there, and a `file-brief:` reads the design back *for*
> the actions written after it rather than doing anything itself — so written
> last it has nothing to brief, and would pass having read a file no agent was
> dispatched with. Write it before the action that writes the change. Refused
> when the recipe resolves, before a worktree, before an agent, before any money.

A `file:` beside it: *"file-brief" declares no "file" field*. A locator it cannot
read is **not** refused at resolve time; the step ends `did-not-finish` saying
*`https://…` is not somewhere a `file-brief:` can read … a design kept anywhere
else is read by that destination's own plugin*.

## Related

- [file.md](file.md) — the other end: keeps the document, answers with the path.
- [`plugins/index.md`](index.md) — every plugin, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
