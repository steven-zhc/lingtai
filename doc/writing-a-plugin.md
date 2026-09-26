# Writing a plugin

A pass is ten steps, and **a step's behaviour is the plugins the recipe declares
there**. This page is for somebody who wants to write one.

> **This describes [0064](decisions/0064-a-plugin-declares-the-steps-it-implements.md),
> which is accepted and not yet built.** Today a plugin is a schema and four of
> the twelve have a runnable form; the `at` below is the shape being built
> towards. The page is here before the code so the target can be argued with
> while arguing is still cheap.

## A plugin is two halves

**What a recipe may write**, as a schema — and **what runs**, as one function per
step your plugin can serve.

```ts
export const slackPlugin = definePlugin("slack", {
  fields: {
    slack: z.strictObject({
      channel: z.string(),
      only: z.enum(["refusals", "everything"]).default("refusals"),
    }),
  },
  at: {
    "*": async ({ step, reached, context }) => {
      await post(`${context.runId} reached ${step}`);
      return { ending: "passed" };
    },
  },
});
```

**`at` is the map from step name to the function your plugin runs there.** Its
keys are the steps you serve and its values are the function, typed for that
step:

- `at: { proposed: … }` — you serve one step, and your function is typed for it
  alone.
- `at: { "*": … }` — you do not care which step you are at, and one function
  serves every step a recipe may put you at.

**The keys are also what makes you legal.** There is no table to add yourself to:
a recipe declaring your plugin at a step your `at` has no key for is refused when
it resolves.

A recipe then writes it wherever it likes:

```yaml
build:
  - name: tell the channel
    slack:
      channel: "#lingtai"
```

The key — `slack:` — is what says which plugin this is. One key per entry, and a
recipe naming zero or two of them is refused when it resolves.

## The ten steps, what each hands you, and what it may return

**Every step hands you the same five things.** `step`, `actions` (everything the
recipe declared here, including you), `reached` (every visit so far, in order,
with how each ended), `context` (the run, the head, the round) and `emit`.

**Three more appear only where they mean something**, and they are typed away
everywhere else — you do not check for null, the compiler does not offer you the
field.

| step | also handed | may return | it is for |
|---|---|---|---|
| `claim` | — | pass · hold · did-not-finish · never-ran | picking the ticket. **There is no work item yet** |
| `admit` | — | pass · hold · did-not-finish · never-ran | starting work on it. The worktree first exists here, so this is where `head` first has a value |
| `prepared` | — | **+ refuse** | the tree is workable. The cheapest refusal in the pass |
| `design` | — | pass · hold · did-not-finish · never-ran | a document before any code — **or nothing, which is an answer** |
| `implement` | — | pass · hold · did-not-finish · never-ran | one agent in the worktree. It reports the `head` it committed |
| `build` | — | **+ refuse** | is it green. A red one skips `review` |
| `review` | — | pass · hold · did-not-finish · never-ran | read the diff, return findings, **judge nothing** |
| `proposed` | `arriving` · `offering` | **+ refuse + route** | the only step that routes |
| `merge` | — | **+ refuse** | land it. Report a reason, decide nothing |
| `end` | `outcome` | pass · hold · did-not-finish · never-ran | runs on **every** ending and cannot refuse |

Read the return column as three tiers:

```
the six that settle     passed · held · did-not-finish · never-ran
the three that refuse   …those four, + refused          (prepared, build, merge)
the one that routes     …those five, + routed           (proposed)
```

**That is `EndingAt<S>`, and it is a type rather than a rule you are asked to
remember.** A `claim` body returning `refused` does not compile; only `proposed`
can move the pass.

### The four endings every step has

```ts
{ ending: "passed" }                                  // carry on
{ ending: "held", at, question }                      // a person is needed, and this is the question
{ ending: "did-not-finish", because, at, detail }     // you could not tell
{ ending: "never-ran", at, detail }                   // you did not start
```

**`refused` and `did-not-finish` are the pair to get right.** *I read it and it is
wrong* buys a fix round; *I could not read it* does not, because there is nothing
for the next agent to fix. A plugin that crashed and reported `refused` sends an
agent to repair a defect that is not in the diff.

### `end` is the one that runs for effect

Its plugins do not produce a verdict — they close an issue, write a label, delete
a branch. `outcome` tells you which ending the pass came to rest on, so a plugin
can act on `landed` and not on `blocked`. It **cannot refuse**: by the time it
runs, what happened has happened.

## From nothing to running

**Five steps, and two of them are easy to forget.**

1. **Write the plugin** — a schema and an `at`, as above. It lives in the tree:
   `packages/recipe/src/` beside the twelve that exist.

2. **Add it to `PLUGINS`** in `recipe.ts`. That array is the closed set — what
   is not in it is not a plugin, and a recipe naming it is refused as an unknown
   key. *(There is no external plugin loading today. A plugin is code in this
   repository, and `resolve.ts` takes the set as a parameter only so tests can
   pass their own.)*

3. **Declare it in the recipe**, at a step your `at` covers:

   ```yaml
   build:
     - name: tell the channel
       slack: { channel: "#lingtai" }
   ```

   The recipe is `~/.lingtai/<project>/recipe.yml` — **outside the repository**,
   one per project on the machine that conducts.

4. **Restart the daemon — and only step 2 needs it.**

   **The recipe is read on every pass**, so step 3 needs no restart: edit the
   file and the next pass sees it. `conduct.ts` calls `currentRecipe` inside the
   pass, and the hash in the log line — *recipe b54751468e38 from main* — is
   recomputed each time.

   **`PLUGINS` is not.** It is a module constant the daemon loaded when it
   started, so a plugin that landed in `main` is not a plugin the running
   conductor has.

   **Which is why the order matters.** Declare a plugin the running daemon does
   not know and the per-pass resolve refuses the whole recipe — *every* pass,
   until it restarts. So: land the code, restart, then edit the recipe.

5. **Watch one pass.** `lingtai attach <runId>`, or the run log on the task page.

### Where it can go wrong, and what you will see

| | |
|---|---|
| Not in `PLUGINS` | `slack: not a plugin` — an unknown key, at resolve |
| In `PLUGINS`, no `at` for that step | *slack: declared at `claim`, which it does not implement — it serves `proposed`* |
| Two plugin keys in one entry | refused: an entry names exactly one |
| Plugin landed, daemon not restarted, recipe edited | the recipe resolves on your machine and is refused on the daemon's, and **no pass starts at all** until it restarts. Editing the recipe alone never needs one |

## A step-specific example: deciding where a refusal goes

`proposed` is the one step that routes, and after 0064 **its plugin's return
value is the route**. A project that wants every refusal to reach a person:

```ts
export const alwaysWaiting = definePlugin("judge", {
  fields: { judge: z.string() },
  at: {
    proposed: async ({ arriving }) =>
      arriving === null
        ? { ending: "passed" }
        : { ending: "routed", to: "waiting", why: "this project reviews every refusal by hand" },
  },
});
```

```yaml
proposed:
  - name: everything comes to me
    judge: always-waiting
```

`arriving === null` is the pass's own way through — nothing refused, so nothing
to route. Otherwise it names where to go, and `why` is what a person reads on the
card.

## What stays the workflow's

**You choose the destination; you do not choose what it costs.**

A route that spends is checked against the ceilings the recipe set — `rounds`
for how many times a pass may send the agent back, `restarts` for how many passes
one ticket may buy. A destination nobody can afford goes to a person **naming the
ceiling that is spent**, whatever your plugin returned.

This is not a restriction on what you can express. It is the one thing that
cannot be yours: a plugin free to return any destination can build a loop, and
the money is somebody else's.

**`waiting` is the one destination that costs nothing**, so it is never refused
for budget. That is why it is the right answer both when you choose it and when a
ceiling is spent — and the pass says which of the two happened.

## What a plugin must not assume

- **That it is the only action at its step.** A step runs everything the recipe
  declared there, in the order written.
- **That it runs once.** A pass can visit a step several times — that is what a
  fix round is — and `reached` is how you tell.
- **That the head has not moved.** `context.onSha` is this visit's, and a fix
  round advances it.
- **That its failure is the pass's.** Report the ending; the workflow decides
  what the pass does with it.

## Related

- [0064](decisions/0064-a-plugin-declares-the-steps-it-implements.md) — the
  decision this page describes, and why the legality table went.
- [0058](decisions/0058-lingtai-is-a-development-pipeline.md) §2b — *a step's
  behaviour is its plugins*, which is the sentence 0064 makes true.
- [0061](decisions/0061-the-recipe-is-the-pipeline.md) — `steps:`, the universal
  keys, and module-as-key.
- [the-pass.html](the-pass.html) — the ten steps, what each word on them means,
  and what a person writes in a recipe.
