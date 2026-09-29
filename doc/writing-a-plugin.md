# Writing a plugin

A pass is ten steps, and **a step's behaviour is the plugins the recipe declares
there**. This page is for somebody who wants to write one.

> **This describes [0064](decisions/0064-a-plugin-declares-the-steps-it-implements.md),
> which is accepted and half built.** `at` exists and **its keys are what make
> you legal** — `definePlugin` takes it, the resolve reads it, and the refusals
> below are the ones you get (`#261`). What is not built is the **values**: a
> plugin's body is still `pass-steps.ts`'s hard-coded one, so the functions
> written below are the shape being built towards rather than something a
> plugin supplies today. Everything about *where* you may be declared is live;
> everything about *what runs* is the next ticket — and the two tickets that
> tried ([#262](https://github.com/steven-zhc/lingtai/issues/262),
> [#267](https://github.com/steven-zhc/lingtai/issues/267)) found four things
> 0064 defers before either found a rewrite:
> [design/the-plugin-body.md](design/the-plugin-body.md) is what they are.
>
> **The fourth is the one that changes the shape below.** A step has exactly one
> body and `proposed` and `merge` have four plugins each, so `at`'s value is not
> one kind of function: the `"*"` written below is *an action's* — called once
> per entry you declared — while a plugin supplying a step's own answer is
> called once a visit. Both are real and they are not the same signature. Until
> that is decided, read the example as the shape of the first kind.
>
> **`judge:` is the one plugin whose declaration is read today, and not as a
> body** (`#274`, `#277`). Its `at` carries `proposed`, its value is
> `notBuiltYet` like every other, and what reads the entry is a lookup the router
> calls — `judgeDeclaredAt` in `packages/conductor/src/judge.ts`, which answers
> *which judge*, not *which step*. So the `judge:` example below is still the
> shape being built towards; what is live is the key, the refusals, one built-in
> name (`same-worktree`) and the runtimes, which `conduct.ts` dispatches.

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

**`"*"` includes `end`, and `end` runs no pipeline** — it carries out effects
through `resolveEndActions` and never builds an action. So a plugin that wants
to run at the nine steps that decide writes them out; the four that ship today
(`run:`, `agent:`, `watch:`, `human:`) do exactly that.

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
| `claim` | — | pass · hold · did-not-finish · asked · never-ran | picking the ticket. **Its body is empty and `queue:` is what runs** (`#269`): **there is no work item yet**, so the `ActionContext` has none to be about — `onSha` is the base the pass came in on, `cwd` is a directory nothing has cut, and a plugin that assumed either does not compile |
| `admit` | — | pass · hold · did-not-finish · asked · never-ran | starting work on it. **Its body is empty and `worktree:` is what runs** (`#268`): the tree first exists here, so this is where `head` first has a value, and the action is what reports it |
| `prepared` | — | **+ refuse** | the tree is workable. The cheapest refusal in the pass |
| `design` | — | pass · hold · did-not-finish · asked · never-ran | a document before any code — **or nothing, which is an answer**. **Its body is empty and `agent:` is what runs** (`#265`): the same key as the cold reviewer and a different action — at this step it drafts, and what it answers is the document rather than findings. **There is no default**: a recipe that says nothing here runs nothing, which is what it always did |
| `implement` | — | pass · hold · did-not-finish · asked · never-ran | one agent in the worktree. **Its body is empty and `agent:` is what runs** (`#266`): the same key again and a third action — at this step it *writes the change*, and what it answers is the `head` it committed. **The default is the agent that wrote it before**, on `runtime.agent`, so a recipe that says nothing here buys exactly what it always did. **And `file-brief:` may be written before it** (`#301`), which is the one plugin anywhere that *reads* a locator: it resolves what a `file:` at `design` kept and hands the document to the entries after it |
| `build` | — | **+ refuse** | is it green. A red one skips `review` |
| `review` | — | pass · hold · did-not-finish · asked · never-ran | read the diff, return findings, **judge nothing** |
| `proposed` | `arriving` · `offering` | **+ refuse + route** | the only step that routes |
| `merge` | — | **+ refuse** | land it. Report a reason, decide nothing |
| `end` | `outcome` | pass · hold · did-not-finish · asked · never-ran | runs on **every** ending and cannot refuse |

Read the return column as three tiers:

```
the five that settle    passed · held · did-not-finish · asked · never-ran
the three that refuse   …those five, + refused          (prepared, build, merge)
the one that routes     …those six,  + routed           (proposed)
```

**That is `EndingAt<S>`, and it is a type rather than a rule you are asked to
remember.** A `claim` body returning `refused` does not compile; only `proposed`
can move the pass.

### The five endings every step has

```ts
{ ending: "passed" }                                  // carry on
{ ending: "held", at, question }                      // a person is needed, and this is the question
{ ending: "did-not-finish", because, at, detail }     // you could not tell
{ ending: "asked", at, detail }                       // you need an answer first
{ ending: "never-ran", at, detail }                   // you did not start
```

**`refused` and `did-not-finish` are the pair to get right.** *I read it and it is
wrong* buys a fix round; *I could not read it* does not, because there is nothing
for the next agent to fix. A plugin that crashed and reported `refused` sends an
agent to repair a defect that is not in the diff.

**`asked` and `did-not-finish` are the other pair**, and they cost the same
nothing — what separates them is where the pass goes. `asked` reaches `proposed`
carrying the question, and a judge answers it or a person does; `did-not-finish`
stops the pass, because there is no question in it for anybody to answer. So
`detail` on an `asked` is *the question* and nothing else, and there is no
`because`: *it asked* is the whole of the reason.

Both were one ending until `#296`, told apart by `because === "needs-input"`.
**You do not write that token on an ending.** What writes it is an action —
`ActionResult.because`, which the pipeline reads once and answers `askedAt` for —
and `needs-input` survives as the `when:` a `judge:` is declared at, which is a
name in a vocabulary and not a branch.

### A plugin that keeps something somewhere fails three ways

A **destination** — a plugin that writes the design into the tree, or files it on
a wiki ([0066](decisions/0066-a-large-answer-is-a-locator-on-the-log.md) §5) —
can fail in a way the three endings above do not obviously sort, so the table is
written down — it is 0066 §7's, with the two run-time rows corrected there by
measurement (`#299`) — and
`packages/conductor/unit/what-a-destination-costs.test.ts` drives it:

| what happened | how you say it | what it costs |
|---|---|---|
| the recipe is wrong | **you say nothing** — the schema refused it | nothing: no claim, no worktree, no agent |
| the destination was briefly unreachable | `did-not-finish` | the pass stops and the item waits for a person; no round, and no judge is asked |
| the destination needs a person | `did-not-finish` with `because: NEEDS_INPUT` | reaches `proposed`: a person, or a `judge:` at `needs-input` — which may buy `design` again |

**The rows are the same at the other end.** A destination has two — one that
keeps and one that reads back — and `file-brief:` at `implement` fails by this
table too: a locator it does not understand, or a file that is not there, is the
second row, and nothing about it reaches a judge. What differs is only what the
first row can catch: there is **no pairing rule** between the two halves (0069
§3), so a recipe that keeps a design one place and reads it back another
resolves, and the plugin says so when it runs.

**The first row is the one that is easy to lose and the expensive one to
lose.** A missing field, a path that is not a path, a destination named with no
credentials: say it in the **schema**, and a recipe carrying it never resolves —
so the daemon claims nothing until a person fixes the line. Check the same thing
when your action *runs* and the same typo costs a whole pass: the ticket is
claimed, a worktree is cut, the design agent is paid, and then the pass ends
`blocked` — which takes the item **off the queue** and onto *Waiting on you*,
where nothing brings it back. `outcomeOf` reads a `did-not-finish` as `blocked`,
`conduct.ts` appends `WorkItemBlocked`, `task_view` folds that to
`state: "waiting"`, and `selectRunnable` drops any row that is not `queued`
*before* it consults the backoff (`queue.ts`). So a run-time-checked `path:` is
not retried every hour — it is worse than that: one claim, one worktree, one
agent run, and then a person, who is being asked to read a refusal a schema line
could have printed before anything was claimed. You get this row by declaring
your fields and writing no code for it; what loses it is a loose field checked at
run time.

**Start every runtime failure at the second row.** *Unreachable* and *needs a
person* are the same event seen at two moments, and which is which is a
measurement rather than a judgement. What you cannot measure it by is retries:
**both rows end `blocked`**, so neither comes round again on its own — the queue
passes over a `waiting` row however long its backoff has run. The observable is
the person. Move a failure to the third row when the person the block reached
answers it with something only they knew — a space, a path, a credential —
rather than by running it again, and say in the ticket which one moved and why.

**A round is bought at the router and not by refusing**, so *`design` may not
refuse* ([0058](decisions/0058-lingtai-is-a-development-pipeline.md) §3) settles
nothing about what these cost, and the answer differs by row. Rows one and two
buy nothing: one never reaches a pass at all, and a `did-not-finish` never
reaches the router, so there is no offer and nothing to spend. The third does
reach it, and `onOffer("design", asked, …)` puts **`design` itself** on the offer
while a round remains — nobody but the step that asked knows the question, so
*that step again* is the only step it can go back to (0058 §3c). Declare no
`judge:` at `when: needs-input` and the floor is a person with the round unspent;
declare one, and every answer of `design` pays for a second design run. So the
row that asks is the only one that can cost more than once, and what it costs is
set in the recipe rather than by your plugin. **Reaching for `refused` to get
attention is not available anyway** — `design` is not one of `REFUSING_STEPS`, so
a `failed` verdict here is read as the second row, and a `refused` that did land
would buy an agent a fix round to be told about a typo.

### `worktree:` is the one that makes rather than judges

Every other kind is handed `context.onSha` and says yes or no about it. The
`worktree:` action at `admit` is where `onSha` gets a value at all, so its result
carries a fifth field:

```ts
{ verdict: "passed", evidence, findings: [], head }   // where it left the tree
```

`head` reaches the step's ending as `LeftTheTreeAt.head` and the loop carries it
to every visit after — so *the tree moved* survives the body rather than being
replaced by it. Absent means the tree did not move, which is every other action.

**It is two actions and not one since `#266`.** The `agent:` at `implement`
reports a `head` for the same reason and a different fact: `admit`'s is where the
tree was *cut*, and this one is the commit the agent *left*, which is what every
step after it is judged against. No body reports one of its own any more — the
rule that a body's head wins is still written in `runStep`, and nothing exercises
it.

A cut that did not happen answers `did-not-finish` and never `failed`: nothing has
been written, so there is nothing to have judged, and `admit` is not one of the
four steps that may refuse anyway. A cut that needs a person answers
`needs-approval`, which reaches the pass as `held`.

### `end` is the one that runs for effect

Its plugins do not produce a verdict — they close an issue, write a label, delete
a branch. `outcome` tells you which ending the pass came to rest on, so a plugin
can act on `landed` and not on `blocked`. It **cannot refuse**: by the time it
runs, what happened has happened.

## From nothing to running

**Five steps, and two of them are easy to forget.**

1. **Write the plugin** — a schema and an `at`, as above. It lives in the tree:
   `packages/recipe/src/` beside the thirteen that exist.

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
| In `PLUGINS`, no `at` for that step | *the "tell the channel" action is a "slack" at the "claim" step, and `slack:` does not implement `claim` — it serves `proposed`* |
| In `PLUGINS`, and nothing implements that step | *… and no plugin implements `<step>` …*. **None of the ten is left since `#266`** gave `implement` an `agent:` — `design` was the second until `#265` and `claim` the third until `#269` — so this refusal is now only reachable by a caller that hands `whyNoKindAt` a plugin set of its own |
| Two plugin keys in one entry | refused: an entry names exactly one |
| Plugin landed, daemon not restarted, recipe edited | the recipe resolves on your machine and is refused on the daemon's, and **no pass starts at all** until it restarts. Editing the recipe alone never needs one |

## A step-specific example: deciding where a refusal goes

`proposed` is the one step that routes, and after 0064 **its plugin's return
value is the route**. A project that wants every refusal to reach a person — read
as the shape being built towards, per the note at the top: `judge:` is declarable
at `proposed` today and `judgeDeclaredAt` reads it, but what it may name is a
built-in and not a body, and `always-waiting` is not one of them yet:

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

## A second one: buying a design, and the step whose default is nothing

`design` is declarable since `#265` and **its default is nothing**, which is the
one place in the plugin system where *declared* and *omitted* are not two ways of
getting a behaviour: omit it and no action runs, the step passes, and `implement`
is briefed with `""` and works from the issue — which is what every pass did
before the key existed. So this is a block that buys something rather than one
that re-states what you already had:

```yaml
design:
  - name: write the shape down first
    agent: claude-code
    prompt: |
      This repository is a pnpm workspace. Say which package the change belongs
      in and which existing function it should wrap.
```

**The same key reviews everywhere else**, and that is deliberate: `agent:` is *a
runtime, a model and a prompt* at all four steps it serves, and what it is for
differs by step. At `review`, `proposed` and `merge` it reads the diff and
returns findings; at `design` there is no diff to read, so it is handed the
ticket and answers with the document — including the empty one, which is the
answer *this change needs no design* and is a pass rather than a skip.

**What it costs is an agent run per pass**, and `runtime.limits` is the only
thing that bounds it (0065 §7). A ticket whose shape is obvious from the issue
pays for a document nobody reads, which is why the prompt this action is built
with says an empty answer is the common one.

**What it returns is handed to the implementing agent**, under a heading saying
where it came from — in `{{design}}` where the prompt template has that placeholder
(`runtime.prompt`, or `prompts/ticket.md` where the recipe names none), appended
after the template where it does not, and nothing at all where the document is
empty. That is `{{failure}}`'s rule and it is here for the same reason: a template
with no slot must not silently drop something a pass paid for. The heading says the
ticket outranks the design where the two disagree, because the implementing agent
has both.

**It runs in the worktree `implement` will run in**, writable and with no hook,
like the cold reviewer — so it is *asked* not to commit and nothing stops it. What
makes that harmless is not the prompt: `implement`'s receipt (0057 §2) is measured
against the head *its own* agent found rather than against the base the tree was
cut at, so a document committed at `design` cannot stand in for work the
implementing agent did not do.

**What it is not is harmless.** What travels to `implement` is the document the
action *returned*, so a file written into the tree reaches no agent — but a file
**committed** rides the branch through `build` and `review` and is merged into
the base by the lane, like any other commit on it. The receipt rule stops it
being mistaken for the implementer's work; nothing stops it being in the change.
A drafting agent that writes is spending turns nobody reads; one that commits is
editing the repository.

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
