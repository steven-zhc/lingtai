# 0070 — A dispatch is one shape every plugin embeds, and the ceiling is stated once

**Status** accepted · **Date** 2026-09-29 · **Decides** how a plugin that pays
for a model declares it, which [0063](0063-every-setting-is-the-recipes.md) §2
settled one key at a time and never as a shape · **Depends on**
[0064](0064-a-plugin-declares-the-steps-it-implements.md) §4, which makes a
plugin's fields the plugin's own to declare · **Unblocks** the payoff
[#295](https://github.com/steven-zhc/lingtai/issues/295) parks by name —
*`runtime.limits` and `runtime.agent` are per-pass, not per-step*

## 1. What this is not about, and saying so first

**Not the enum.** `RuntimeId` is declared once, in
`packages/domain/src/events.ts`, and every reader derives from it rather than
repeating it: `agentPlugin`'s `agent:`, the second half of `JudgeName`,
`runtime.agent`, and the port's own `id` in `packages/agent/src/runtime.ts`. A
third runtime is **one line there** plus an adapter, and no plugin's schema
changes. That was got right and this decision does not touch it.

Two places do compare a runtime by hand and both are outside the plugins:
`propose.ts`'s ternary preference order, which
[CLAUDE.md](../../CLAUDE.md) already names as *a silent ternary*, and the five
`createClaudeCodeRuntime()` call sites under `apps/cli/`. Both should become one
`RuntimeId → factory` table. That is a defect in the wiring, not in the schema,
and it is not what this file decides either.

What is duplicated is **the shape of a paid call**, and it has already diverged.

## 2. The evidence: two plugins, two field lists, and one of them is poorer for no reason

| | `agent:` (`recipe.ts`) | `judge:` (`recipe.ts`) |
|---|---|---|
| which runtime | `agent: RuntimeId` | `judge: JudgeName` |
| which model | `model: string` *optional* | **absent** |
| the prompt | `prompt: string` | **absent** — fixed in `judge-agent.ts` |
| what it may spend | **absent** — `runtime.limits`, per pass | **absent** — the same |

`recipe.ts`'s own words for the second column are *a `RuntimeId` here is **an
agent, paid for a judgement***. So a runtime judge is a dispatch that costs
money, **and there is no way to ask it for a cheaper model than the one writing
the code.**

Measured on [#300](https://github.com/steven-zhc/lingtai/issues/300),
2026-09-29 — one pass, five dispatches:

| | turns | cost |
|---|---|---|
| `implement` | 150 | $22.56 |
| `review` round 0 | 40 | $4.70 |
| **`judge` at `findings`** | **1** | **$0.42** |
| `fix` round 1 | 56 | $6.38 |
| `review` round 1 | 44 | $5.51 |

The cheapest call in the pass by two orders of magnitude is the one with no way
to name a cheap model, and the most expensive is bounded by the same 150 turns
as everything else. Nothing decided either of those. They are what two separate
field lists produce.

## 3. The decision: what is shared is *how*, and what stays the plugin's is *which*

A **dispatch** is a group of fields — the model, the prompt, and what one call
may spend — and a plugin that pays for a model embeds the group rather than
writing its own version of it:

    model   string     optional   absent means the runtime's own default
    prompt  string                what it is handed
    limits  { turns, wall }       optional, and see §5

**`which` stays the plugin's own key**, and that is not an exception to the
rule. `agent:` names a runtime and only a runtime. `judge:` names a built-in
*or* a runtime — `JudgeName` is `[...BUILT_IN_JUDGES, ...RuntimeId.options]` —
and only that plugin knows that *not a runtime at all* is a legal answer there,
which is 0031 §1's rule about where a classification lives, one field along. A
shared key that had to carry both would be a third vocabulary for a distinction
two plugins already make correctly.

So a built-in judge takes no `model:` and no `limits:` and that is not a gap: it
spends nothing, which is the whole of what its name promises.

## 4. This is 0063 §2 stated as a shape rather than repeated per key

0063 §2 decided that `model:` and `prompt:` *sit beside the key rather than
under it, so the scalar stays a single value*. That is right and this keeps it —
the group is a set of sibling keys, not a nested object. What 0063 did not say
is that the same siblings belong to every paid key, so the second plugin got
two of the four and the third would have had to guess. The rule was always about
a shape; it was written down as a layout.

## 5. The ceiling is stated once, and a step may only narrow it

`runtime.limits` carries four numbers and **they are not the same kind of
thing**, which [0040](0040-rounds-bound-depth-restarts-bound-breadth.md) is
already about:

- `turns` and `wall` bound **one call**;
- `rounds` and `restarts` count **how many calls** — depth and breadth.

Only the first two may appear in a dispatch. `rounds` and `restarts` are facts
about the pass and have no meaning inside one action.

**And a dispatch may only narrow, never widen.** `lingtai status` prints a
sentence it computes:

    a pass — up to 4 agent runs … 1h and 150 turns each, so at most 4h.
    Then up to 1 restart(s) … so at most 2 passes, 8 agent runs and 8h.

A step that could raise its own bound makes that sentence unreadable from the
top of the file: what a pass may spend would only be knowable after reading
every action in every step. Narrowing keeps it true and keeps it an upper bound.
An operator who wants `implement` to have 300 turns raises `runtime.limits` and
narrows the others — **the ceiling is said once, and every other number is a
reduction from it.**

This is what [#295](https://github.com/steven-zhc/lingtai/issues/295) parks as
*blocked on something else entirely*, and it stops being a separate piece of
work: per-step limits arrive as part of the shape rather than as an engineering
project of their own.

## 6. What it makes possible, in one file

    runtime:
      agent: claude-code
      tier: guarded
      limits: { wall: 1h, turns: 150, rounds: 3, restarts: 1 }

    steps:
      design:
        - name: the shape
          agent: claude-code
          model: opus
          prompt: …
      implement:
        - name: write the change
          agent: codex
          model: gpt-5-codex
          prompt: …
          limits: { turns: 60, wall: 30m }
      review:
        - name: the cold reviewer
          agent: claude-code
          model: sonnet
          limits: { turns: 50 }
          prompt: …
      proposed:
        - name: a red build is the agent's to fix
          judge: same-worktree
          when: red
        - name: the lines or the approach
          judge: claude-code
          model: haiku
          limits: { turns: 5 }
          when: findings

The cold reviewer stops being *the same model with its context stripped* and
becomes a different one; `implement` reads a design and is bounded like
something that reads a design; and the judgement that cost $0.42 can be bought
from the model that charges for it.

## 7. Three refusals, all at resolve, all before the money

[0016](0016-the-settled-model.md) §4's rule — refuse where it is written, by
name — applies to all three:

- **a dispatch that widens**: *`steps.implement`'s "write the change" asks for
  300 turns; `runtime.limits.turns` is 150, and a step may only narrow it*
- **a runtime nothing is signed into**: the shape `agentRefusal` already has,
  read against what this machine can dispatch rather than against the one
  runtime it dispatches
- **a tier the runtime cannot carry**: unchanged, and already built —
  `missingForTier` names `filesystem-sandbox` and `conduct.ts` refuses, which
  the recipe's own comment calls *the whole of the enforcement*

## 8. What did not change

**A recipe nobody edited.** Every field in the group is optional except the
`prompt:` that `agent:` already required, and an absent `limits:` is
`runtime.limits` exactly as today. `agentPlugin`'s own promise — *nothing
changes for a file nobody edited* — is the test of this, not a hope about it.

**`runtime.agent` stays.** It is the default for a step that names nothing, and
[0053](0053-the-recipe-chooses-the-agent-for-each-role.md)'s decision is
unchanged: which CLI does a project's work is the recipe's, not the machine's.
What moves is only *how finely* the recipe may say it.

**`tier` stays per-pass.** It is a property of the containment a project
requires, not of one call, and nothing here asks for it per step.

## 9. What it costs

**A second reading of `limits` in two places.** `runtime.limits` is the ceiling
and the default; a dispatch's is a reduction. Two readers where there was one,
and the narrowing rule is a refusal that has to be written and tested.

**`lingtai status`'s sentence gets longer.** *150 turns each* becomes a per-step
figure, because a single number would now be a lie. That is more text on a line
a person reads every day, bought with an upper bound that is actually the
bound rather than the worst step's applied to all of them.

**A migration of exactly nothing.** No stored event carries these fields, no
recipe on either machine declares them, and both defaults are the values in use
today — so this lands with no upcaster and no recipe edited.

## What this does not decide

- **Whether `judge:` takes a `prompt:`.** The judgement's question is fixed —
  *the lines or the approach* — and a prompt an operator can rewrite may be a
  way to ask the wrong question rather than a setting. `model:` and `limits:`
  are decided here; `prompt:` is left to whoever finds they need it.
- **Per-step `tier`.** §8 keeps it per-pass. A step that needed a stronger
  containment than the pass declares is a real idea and not one anybody has
  wanted yet.
- **Failing over to another runtime when one is out of quota.** A recipe
  declares; it does not fall back.
  [#210](https://github.com/steven-zhc/lingtai/issues/210) is a parser bug in
  reading the quota's reset time and is not this.
- **The `RuntimeId → factory` table.** §1 names it as the wiring defect it is;
  it belongs to whichever ticket makes a second runtime actually dispatch.

## Related

- [0063](0063-every-setting-is-the-recipes.md) §2 — `model:` and `prompt:`
  beside the key so the scalar stays a single value. §4 above is that rule
  restated as a shape, which is what makes the third paid plugin free.
- [0064](0064-a-plugin-declares-the-steps-it-implements.md) §4 — a plugin
  declares its own fields and its own steps. The group is something a plugin
  *embeds*, never something imposed on it, for that reason.
- [0040](0040-rounds-bound-depth-restarts-bound-breadth.md) — why `turns`/`wall`
  and `rounds`/`restarts` split the way §5 splits them.
- [0053](0053-the-recipe-chooses-the-agent-for-each-role.md) — the recipe
  chooses the agent. Unchanged; this only makes *role* mean *step*, which is
  what [0058](0058-lingtai-is-a-development-pipeline.md) did to the word
  everywhere else.
- [0031](0031-a-run-that-never-started.md) §1 — a classification lives where it
  is known, which is §3's argument for `judge:` keeping its own key.
- [0016](0016-the-settled-model.md) §4 — refused where it is written, by name,
  at resolve. §7 is three cases of it.
- [0007](0007-dual-runtime.md) — both runtimes designed for from day one,
  because retrofitting the interface later is a refactor. This is the same
  argument one level up: retrofitting the *recipe's* shape for the third paid
  plugin would be the same refactor.
