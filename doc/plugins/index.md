# Plugins

A pass is ten steps, and **a step's behaviour is the plugins the recipe declares
there**. This page
is the list of them, for somebody writing a recipe rather than somebody writing
a plugin: which key does what, and which steps it may be written at.

Three other documents are about plugins and none of them is this one.
[writing-a-plugin.md](../writing-a-plugin.md) is for authoring a new one — the
two halves, what each step hands you.
[reference.md](../reference.md) is the glossary: the event types, the stream
prefixes, `runtime.limits`. The recipe on your own machine,
`~/.lingtai/<project>/recipe.yml`, is one example of each with nothing saying
what the keys mean. The operator's question — *I want a check at `build`; what
do I write, and what does it take* — is what the fourteen pages under this one
answer.

## The fourteen

**This table is read off `PLUGINS` and not kept by hand.**
`packages/recipe/unit/plugin-pages.test.ts` walks the closed set and fails when
a plugin is missing a row here, when a row names a plugin that is not in the
set, or when a row's steps are not that plugin's own `at` keys. A fifteenth
plugin is a red test rather than something somebody has to remember.

| key | may be declared at | what it is for |
|---|---|---|
| [`run`](run.md) | `prepared` `implement` `build` `proposed` `merge` | Runs a command. Its exit code is the verdict, and it is the extension point that needs nothing declared. |
| [`agent`](agent.md) | `design` `implement` `review` `proposed` `merge` | Buys an agent a turn — to draft, to write, to read the diff cold, or to answer. |
| [`file`](file.md) | `design` | Keeps the design the step made, as a file in the worktree, and answers with the path. |
| [`file-brief`](file-brief.md) | `implement` | Reads that design back from where the `file:` kept it, and briefs the actions written after it. |
| [`watch`](watch.md) | `proposed` | Holds the pass when the diff touches a path you named. |
| [`human`](human.md) | `proposed` | Stops for a person, and asks them the question you wrote. |
| [`judge`](judge.md) | `proposed` | Answers *what now* when a step refused, in place of a person. |
| [`worktree`](worktree.md) | `admit` | Cuts the branch and the worktree this pass owns. |
| [`queue`](queue.md) | `claim` | Picks which ticket the pass is about. |
| [`merge`](merge.md) | `merge` | Lands the branch on the base, with the base's own verify. |
| [`close`](close.md) | `end` | Closes the issue the pass was about. |
| [`labels`](labels.md) | `end` | Sets the issue's labels, replacing Lingtai's own and keeping everybody else's. |
| [`refs`](refs.md) | `end` | Deletes the history refs a landed ticket left on `origin`. |
| [`backlog`](backlog.md) | no step | The bar at or below which a finding is filed instead of buying a round. |

`backlog` is the row worth reading twice. It is in the closed set and it has a
field, and its `at` is `{}` — *no step reads it; the bar is a literal in two
folds* — so a recipe that writes it anywhere is refused, by a sentence naming
where that code is called instead. Naming a thing is not wiring it.

## What "may be declared at" means

**It is the plugin's own `at`, and it is the whole of what makes it legal.**
There is no table of step × kind anywhere: `runPlugin.at` carries
five keys, so a `run:` at `review` is refused when the recipe resolves — before
a worktree, before an agent, before any money — and the refusal says which
steps `run:` does serve and why this pair would mean nothing
(`whyNoKindAt` and `whyThatPair`, `packages/recipe/src/recipe.ts`).

Two consequences an operator feels:

- **A refusal is a whole pass, not one action.** `conduct.ts` answers
  `stage: "recipe"` for every ticket while the file is illegal, so a daemon
  restarted onto a bad recipe takes nothing at all. `lingtai add` and
  `lingtai doctor` both resolve without running anything, so you see it before
  a run rather than during one.
- **A plugin's `at` key, default, body and refusal sentence live together**, which
  is why these fourteen rows can be read off the code instead of being a promise
  about it.

## The shape a page under here follows

One template, so the fourteen are one document in fourteen parts rather than
fourteen documents: [`_template.md`](_template.md), which is in the repository and not on
this site — a leading underscore is how a file in a published directory says it
is a shape and not a page.

It opens with a **TL;DR** table — *does · write it at · needs · refuses · watch
out* — for the reader who stops there. Then its six sections, in order: **what it does** · **where it may be declared**, and
why those steps and not others · **parameters**, as a table · **examples**, at
least three and every one of them real · **what it refuses**, in the schema's
own words · **related**, links to the pages a reader would follow next.

## Related

- [writing-a-plugin.md](../writing-a-plugin.md) — the other half: authoring one.
- [reference.md](../reference.md) — the glossary: event types, stream prefixes,
  `runtime.limits`.
- [tamper-watch.md](../tamper-watch.md) — the paths `watch:` is pointed at.
