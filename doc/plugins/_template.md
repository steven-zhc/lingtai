# `<key>:`

> **This file is the shape, not a page.** Copy it to `doc/plugins/<key>.md`,
> fill every section, and delete these blockquotes. The leading underscore is
> what keeps it out of the site: `markdownIn` in `apps/site/src/lib/docs.ts`
> skips an underscore-prefixed file, and `unpublished()` then names it on the
> docs index with a link to it on GitHub — skipped, never hidden.
>
> **Fourteen pages, one shape.** The sections below are in this order and none of
> them is optional; a page missing one is a page a reader has to read
> differently from the last one. If a section has nothing true to say, say that
> — `backlog:` serves no step and its *Where it may be declared* is the most
> useful paragraph on its page.

> **And the lengths below are a budget, not a suggestion.** The first four pages
> written from this file came out at 268, 288, 318 and 396 lines against this
> file's 104, and every one of them overran in the same two places: *Where it may
> be declared* and *What it refuses*, each about seven times its allowance. A
> reference page is read to answer one question — *what do I write, and what does
> it take* — and a reader who has to skim four screens to find a two-line table
> has been handed an essay instead of a reference.
>
> So: **no page over 120 lines**, and each section within a line or two of the
> guidance under its own heading. The rule for cutting is not *say less*, it is
> **say it once**: the same fact in the lede, in *What it does* and again in
> *What it refuses* is one fact and two thirds of a page. Keep the sentence where
> it is load-bearing, and delete the other two.
>
> What is never cut: the real examples, the refusal quoted in the schema's own
> words, and the trap a reader would otherwise walk into. Prose about *why the
> design is good* is what goes — that lives in the ADR the page links to.

> One paragraph, before any heading: what this plugin does, **and the failure it
> prevents rather than the mechanism it uses**. The mechanism is in the code and
> the code moves; the failure is why the key exists. This paragraph is also the
> page's lede on the docs index (`ledeOf`), so it has to stand alone.

## What it does

> The paragraph above, expanded — two or three of them at most. Where the work
> actually happens (`packages/…/src/….ts`), what it costs, and what it does
> *not* do. A plugin that reports rather than decides says so here, in those
> words.

## Where it may be declared

> **The steps from the plugin's own `at`, and why those and not others.** Do not
> retype the list: read it off `<key>Plugin.at` in
> `packages/recipe/src/recipe.ts`, which is the whole of what makes the plugin
> legal at a step ([0064](../decisions/0064-a-plugin-declares-the-steps-it-implements.md) §4).
>
> The *why* has a source too, and it is not your own reasoning:
> `whyThatPair` in the same file carries a sentence per step, and it is the
> sentence the refusal actually prints. Quote it, so that a person who hit the
> refusal and a person reading this page ahead of time are told the same thing.
>
> A plugin whose `at` is `{}` writes this section as *nowhere yet*, and says
> where the code it names is called instead — `CALLED_DIRECTLY` in `recipe.ts`
> has that sentence.

## Parameters

> A table, and nothing the schema does not say. Types and defaults come from
> `<key>Plugin.fields`; `name` is on every action and belongs in the table as
> such. **`required` and *has a default* are different columns of the same
> answer** — write the default, not the word "optional", because an operator
> wants to know what happens if they leave it out.

| field | type | required | what it means |
|---|---|---|---|
| `name` | string | yes | How every verdict, waiver and reading addresses this action. |
| `<key>` | | yes | The key is what says which plugin this is, and it carries `…`. |
| | | | |

## Examples

> **At least three, and every one of them real.** An invented example that does
> not resolve is worse than none — it is a thing a person will paste and then
> debug. Take them from somewhere that runs:
>
> - this machine's own recipe, `~/.lingtai/lingtai/recipe.yml`
> - `packages/recipe/src/presets.ts` — the `pnpm-workspace` preset
> - `packages/conductor/test/one-pass.ts`'s fixtures
>
> Say where each came from, in a line under it. Pick three that differ in what
> they *decide*, not three that differ in whitespace.

```yaml
# where this one is from
step:
  - name: …
    <key>: …
```

## What it refuses

> **At least one wrong shape, with the refusal quoted in the schema's own
> words.** Not paraphrased: the refusal is the sentence an operator will meet,
> and a page that improves on it has made the two disagree. Worth covering when
> it applies: the step the plugin does not serve, a field it does not declare,
> and a value outside an enum.

```yaml
# what somebody writes
```

> the recipe is refused when it resolves, before a worktree, before an agent,
> before any money:
>
> > *the exact refusal, copied*

## Related

> The **ADR that decided it** and the **ticket that built it**, each with what it
> decided rather than just its number — the house rule for a `## Related`
> anywhere in this repository. A `seq` is not a citation here; an issue number
> is ([design/1.0.md](../design/1.0.md)).

- [`plugins/index.md`](index.md) — the fourteen, and which step each serves.
- [writing-a-plugin.md](../writing-a-plugin.md) — authoring one, rather than
  declaring one.
