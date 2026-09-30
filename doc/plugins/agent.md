# `agent:`

| | |
|---|---|
| **Does** | Buys a model a turn in the worktree: drafts at `design`, writes at `implement`, reads the diff cold at `review`, `proposed`, `merge`. |
| **Write it at** | `design`, `implement`, `review`, `proposed`, `merge`. |
| **Needs** | `agent` (`claude-code` or `codex`) and `prompt`. `model` defaults to the runtime's; `limits` to `runtime.limits`. |
| **Refuses** | Any other step (`build` is the one people reach for), a `timeout:`, a `limits:` past `runtime.limits`, `rounds` inside `limits`. |
| **Watch out** | It spends money, and **the step decides what a refusal costs**: at `review` findings travel to `proposed`; at `proposed` or `merge` it stops the pass for a person, no round bought. |

`agent:` is one of the two keys that spend money (the other is a `judge:` naming
a runtime), and exists so the reviewer is not the implementer: an agent
eighty-nine turns into an approach is no second opinion on it.

## What it does

**One key, three actions; the step picks** (`actionsFromRecipe`,
`packages/actions/src/from-recipe.ts`): `design` builds `createDraftAction`
(leaves a document, nothing, or one question), `implement` builds
`createWorkAction` (leaves **a commit**, the receipt), and `review`, `proposed`
and `merge` build `createAgentAction` (leaves findings, not a verdict).

- **Cold:** the reviewer gets the issue, diff and worktree, never the
  implementer's session. A `prompt` is **appended** to the fixed rubric and
  checklist, never substituted for them.
- **At `review`, `failed` is findings, not a verdict**, routed at `proposed`.
- **At `design` its tree writes are not the document.** Only the prompt asks it
  not to edit or commit, and a design commit stays and lands with the change.
  Guard with a `watch:` at `proposed`.
- **An unparseable answer is `unreadable` (`#279`)** and buys no round.

## Where it may be declared

`agentPlugin.at` in `packages/recipe/src/recipe.ts`. What a refusing `agent:` costs:

| at | the pass does |
|---|---|
| `design` | `did-not-finish`, no round. A *question* ends `asked` and reaches `proposed` as `needs-input`. |
| `implement` | commits, ends `asked`, or leaves no receipt and stands down. |
| `review` | ends `passed`; findings become a `findings` direction. **The point of declaring it here.** |
| `proposed` | refuses on its own behalf, nowhere to appeal: a person is asked, no round. |
| `merge` | `action-refused`, which no `judge:` answers: held for a person, no round. |

Not `build` (*"an agent asked to would be paid to read, and a cold read of the diff is `review`"*) and not `prepared` (*"a cold reviewer would be given no diff to read"*).

## Parameters

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. |
| `agent` | `claude-code` \| `codex` | yes | The runtime (an enum: prose fails at resolve, not at spawn). |
| `model` | string | no, the runtime's default | Passed through; **not validated**. |
| `prompt` | string | yes | Appended to the fixed brief. **Interpolated raw**: `{{issue}}` is not expanded ([`reference.md`](../reference.md#prompt-placeholder--5)). |
| `limits` | `{ turns?, wall? }` | no, `runtime.limits` | This call's spend, field by field; **may only narrow** (0070 §5). |

A runtime this machine is not signed in to is a legal name, refused before the claim (*"nothing on this machine is signed in to codex"*).

## Examples

```yaml
# packages/conductor/test/one-pass.ts — `DRAFTED`: unconfigured, design runs nothing
design:
  - name: draft
    agent: claude-code
    prompt: say what shape this takes
```

```yaml
# packages/conductor/test/one-pass.ts — `JUDGED_BY_AN_AGENT`: findings judged at proposed
review:
  - name: cold reviewer
    agent: claude-code
    prompt: look for races
proposed:
  - name: the lines or the approach
    judge: claude-code
    when: findings
```

```yaml
# packages/conductor/test/one-pass.ts — `REVIEWED`: the same reviewer at proposed, no round on refusal
proposed:
  - name: review
    agent: claude-code
    prompt: look for races
```

`implement` needs none: unconfigured it runs `createWorkAction` (0065 §2).

## What it refuses

```yaml
build:
  - name: review
    agent: claude-code
    prompt: look for races
```

> the "review" action is a "agent" at the "build" step, and `agent:` does not
> implement `build` — it serves `design`, `implement`, `review`, `proposed`, `merge` …

Refused at resolve, before any money; also by name: `timeout: 20m` (*"agent" declares no "timeout" field*); `agent:
gpt-5` (*expected one of "claude-code"|"codex"*); `limits: { turns: 300 }` over a
ceiling of 150 (*a step may only narrow it (0070 §5)*); `limits: { rounds: 2 }`
(*`rounds` bounds the pass and not one call (0040) … Write it at `runtime.limits`*).

## Related

- [0058](../decisions/0058-lingtai-is-a-development-pipeline.md) §3, §3b — the ten steps; `failed` at `review` is findings. [0057](../decisions/0057-a-gate-that-did-not-finish.md) §2 — `implement`'s receipt is a commit.
- [0038](../decisions/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md) §2 — a finding buys an agent first; unreadable buys none.
- [0063](../decisions/0063-every-setting-is-the-recipes.md) §2 — the recipe picks the runtime, so `agent:` is an enum. [0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4 — legality is `agentPlugin.at`.
- [0070](../decisions/0070-a-dispatch-is-one-shape-and-the-ceiling-is-stated-once.md) — one dispatch shape; §5 narrowing. [0065](../decisions/0065-the-default-is-a-plugin.md) §2, §5 — `implement` and `design` became writable keys.
- `#265` opened `design`, `#266` `implement`; `#279` gave unreadable a word.
- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than declaring one.
