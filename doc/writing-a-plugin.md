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

A recipe then writes it wherever it likes:

```yaml
build:
  - name: tell the channel
    slack:
      channel: "#lingtai"
```

The key — `slack:` — is what says which plugin this is. One key per entry, and a
recipe naming zero or two of them is refused when it resolves.

## What your function is handed

```ts
interface StepWork<S extends Step> {
  step: S;                      // which of the ten you are at
  actions: StepAction[];        // everything the recipe declared here, including you
  refuses: boolean;             // whether this step is allowed to refuse
  reached: StepReached[];       // every visit so far, in order, with how each ended
  arriving: …                   // `proposed` only — the ending that routed here
  offering: …                   // `proposed` only — the destinations available
  outcome: …                    // `end` only — how the pass came to rest
  context: ActionContext;       // the run, the head, the round
  emit: (event) => …            // one event per thing you do
}
```

**Three of those are typed away where they make no sense.** `outcome` is a
`TerminalOutcome` when `S` is `"end"` and `null` for the other nine, so a plugin
at `build` cannot read an outcome that has not been decided. `arriving` and
`offering` are the same for `proposed`. **You do not check for null; the compiler
does not offer you the field.**

`reached` is the one worth knowing about: it is the pass's own history, in order,
so a plugin can see that `build` already failed twice this round without being
told.

## What you may return

```ts
{ ending: "passed" }                                     // carry on
{ ending: "refused", because, at, detail }               // refusing steps only
{ ending: "held", at, question }                         // a person is needed
{ ending: "did-not-finish", because, at, detail }        // you could not tell
{ ending: "never-ran", at, detail }                      // you did not start
{ ending: "routed", to, why }                            // `proposed` only
```

**`refused` and `did-not-finish` are different and the difference matters.** *I
read it and it is wrong* buys a fix round; *I could not read it* does not,
because there is nothing for the next agent to fix. A plugin that crashed and
reported `refused` sends an agent to fix a defect that is not in the diff.

**Only four steps may refuse** — `prepared`, `build`, `proposed`, `merge` — and
the type will not let the other six. `refuses` on your `StepWork` tells you which
one you are at, for the plugins that serve several.

## Where your plugin is legal

**Wherever `at` has a function for it.** That is the whole rule; there is no
table to add yourself to.

- **`at: { "*": … }`** — you do not care which step you are at. The example above
  is this: posting to a channel is the same work everywhere.
- **`at: { proposed: … }`** — you serve one step, and the compiler types your
  function for that step alone.

A recipe that declares your plugin at a step you have no function for is
**refused when it resolves**, naming the plugin and the step:

```
slack: declared at `claim`, which it does not implement — it serves `proposed`
```

That refusal reaches the person editing the recipe, on their machine, while they
are editing it. It is not a log line from a machine running overnight.

**And absent is not empty.** A plugin without a function for a step is refused;
a plugin whose function does nothing is a bug you wrote. The check is on the
declaration, never at the call site, so nothing silently runs nothing.

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
