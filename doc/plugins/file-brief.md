# `file-brief:`

Reads the design back from the path a `file:` kept it at, and hands it to the
actions written after it. Without it the locator a destination produced is a
fact nothing at `implement` ever uses: the pass carries a copy of the document
in memory and briefs the agent from that, so `file:` and a Confluence
destination would be interchangeable to the *log* and not to the implementing
agent — which is the whole of what
[0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §4's opaque
locator is for. This is the first thing anywhere that reads one.

## What it does

`createFileBriefAction` in `packages/actions/src/file-brief-action.ts` takes
`ActionContext.design.locator`, reads the file it names inside the worktree, and
answers with the text — so `runActionPipeline` advances the design and the
`agent:` written after it is dispatched with what came off the branch rather
than with the copy the pass has been carrying.

**It understands a path in the worktree and nothing else**, which is the rule
`filePlugin` is refused by (`whyThePathEscapes`, the same function). A locator
it does not recognise ends the step `did-not-finish`, with a sentence naming the
destination it expected. That is not the core learning to parse locators: the
recognising is inside this plugin, a recipe that pairs a `confluence:` design
with it still resolves, and the fourth destination is still a plugin rather than
a change to `packages/conductor` (0066 §4).

**It reads and it does not decide.** `implement` may not refuse
([0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3), so every way
this fails is a `did-not-finish`: no fix round, and the pass stops for a person —
the second of the three rows a destination fails by
([writing-a-plugin.md](../writing-a-plugin.md)). **And it owns the
disagreement**: the pass's copy and the kept one can differ, and this action
prefers what it read, which is
[0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
§4's *that plugin owns it*.

## Where it may be declared

`implement`, and nowhere else (`fileBriefPlugin.at` in
`packages/recipe/src/recipe.ts`). The refusal at the other nine is the sentence
this page would otherwise paraphrase:

> `file-brief:` reads the design back from wherever a `file:` kept it, and
> `implement` is the step a design is *for* (0058 §3) … at `design` there is no
> locator yet, and at every later step the change has already been written.

**And it is written before the agent it briefs**, which is the mirror of the
rule `file:` is held to: one written last has nothing left to brief and is
refused when the recipe resolves.

**Declaring anything at `implement` replaces the default**
([0065](../decisions/0065-the-default-is-a-plugin.md) §2), so a step that
declares this one declares the agent beside it — which the rule above makes
unavoidable anyway.

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. |
| `file-brief` | `true` | yes | `true` and nothing else. |

**No path, on purpose.** Where it reads is the locator the `design` step
produced, and a path written here would be a second answer to the same question
— the one that disagreed with the locator would win, silently, which is the
half-written block 0066 §5 makes a plugin per destination to avoid.

## Examples

```yaml
# packages/actions/unit/file-brief-action.test.ts — the pair, end to end
design:
  - name: shape it
    agent: claude-code
    prompt: read the ticket and the code, and write down the shape
  - name: keep the design
    file: doc/design/x.md
implement:
  - name: read the design back
    file-brief: true
  - name: write the change
    agent: claude-code
    prompt: ""
```

The whole arrangement: a destination at `design` and its other end at
`implement`. The agent is briefed with the bytes on the branch.

```yaml
# packages/conductor/unit/step-matrix.test.ts — the probe, with no `design:` block
implement:
  - name: read the design back
    file-brief: true
  - name: write the change
    agent: claude-code
    prompt: ""
```

Legal, and it changes nothing: with no locator there is nothing to read back, the
action passes saying so, and the agent gets the brief it would have got anyway.

```yaml
# packages/actions/unit/file-brief-action.test.ts — two destinations, one brief
design:
  - name: shape it
    agent: claude-code
    prompt: write down the shape
  - name: the note in the repository
    file: doc/design/notes.md
  - name: and one beside the ticket
    file: doc/design/301.md
implement:
  - name: read the design back
    file-brief: true
  - name: write the change
    agent: claude-code
    prompt: ""
```

Two keeps and one read. The locator that crosses the step boundary is the
**last** one, because that is the result the document came off (0069 §5), so this
reads `doc/design/301.md`.

## What it refuses

```yaml
implement:
  - name: write the change
    agent: claude-code
    prompt: ""
  - name: read the design back
    file-brief: true
```

> it is the last action there, and a `file-brief:` reads the design back *for*
> the actions written after it rather than doing anything itself — so written
> last it has nothing to brief, and would pass having read a file no agent was
> dispatched with. Write it before the action that writes the change. Refused
> when the recipe resolves, before a worktree, before an agent, before any money.

A `file:` written beside it is refused too — *"file-brief" declares no "file"
field* — which is [0061](../decisions/0061-the-recipe-is-the-pipeline.md) §9's *a
plugin refuses a field it does not understand*, and the paragraph under
**Parameters** is the reason there is none.

A locator this destination cannot read is **not** a resolve-time refusal, because
there is no pairing rule to check (0069 §3): it is met when the action runs, and
the step ends `did-not-finish` saying *`https://…` is not somewhere a
`file-brief:` can read … a design kept anywhere else is read by that
destination's own plugin*.

## Related

- [0066](../decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §4 — the
  locator is a string and **only the plugin that wrote it reads it**; §5 — where
  an answer lands is a plugin rather than a field, which is why this is a second
  key and not a `destination:` on `agent:`.
- [0069](../decisions/0069-both-the-document-and-the-locator-cross-the-step-boundary.md)
  — decided that both the document and the locator cross the boundary, and §4 is
  the paragraph that hands the disagreement to a plugin that resolves one.
- [`file`](file.md) — the other end of this destination: what keeps the document
  and answers with the path this reads.
- `#301` — built it, against `#300`'s `file:`.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
