# `{{issue}}` in `file:` — where the substitution goes

## The shape

One placeholder, `{{issue}}`, expanded **when the `file:` action runs**, inside
`createFileAction`, from a ticket the plugin is handed the way every other
plugin is handed one — a `deps` accessor. Not when the recipe resolves.

The ticket's **Fix** row says *when the recipe resolves*, and that is the one
part of it that cannot be built. `resolveRecipe` has no ticket: it parses a
file at a ref (`packages/recipe/src/resolve.ts`), and its two production callers
— `lingtai add` on the operator's machine and the daemon at start — run before
any queue pass. And it must not acquire one, because the resolve produces
`configHash`, *"of the resolved form rather than the file's bytes: two files
that differ only in comments or key order describe the same run, and a replay
comparing 'did results change after I edited the pipeline?' should say no"*
(`resolve.ts`, `ResolvedRecipe.configHash`). A path expanded at resolve would
make an unedited recipe hash differently on every ticket, and `configHash` is on
every `RunStarted` and on `ProjectConfigured`. The recipe resolves once per
daemon; the path is per pass.

So the boundary is: **the recipe still refuses the string a person wrote, at
resolve, before any money (0066 §6); the action refuses the string the ticket
made, when it runs.** Both halves are `whyThePathEscapes`, and the answer to
the ticket's **Watch out** is *substitute first and refuse second* — done twice,
at two different times, on two different strings.

## The ticket reaches the plugin the way it already reaches the drafter

`AgentActionDeps` carries it (`packages/actions/src/agent-action.ts:86-88`):

    /** The ticket, exactly as the implementer received it. Fetched lazily so a
     *  recipe without an agent action costs no API call. */
    issue: () => Promise<{ ref: string; title: string; body: string }>;

`createDraftAction` — the drafter whose document this destination keeps — already
awaits it (`agent-action.ts:861`, `context.log?.note("design", …#${issue.ref}…)`).
`FileActionDeps` gains the same accessor, **narrowed to `ref`**:

    issue: () => Promise<{ readonly ref: string }>;

The narrowing is the mechanism for the ticket's *take only `{{issue}}`*: a later
`{{title}}` is not a line somebody forgot to write, it is a type that would have
to be widened first. Required rather than optional — an optional accessor with a
fallback would let a placeholder survive unexpanded into a filename, which is the
silent-wrongness class this ticket exists to close. Making it required is a
compile break in the fixtures that build a `file:` today
(`packages/actions/unit/file-action.test.ts`'s `keeping()`,
`file-brief-action.test.ts`'s worktree fake, `step-matrix.test.ts`'s `EVERY_DEP`);
that is the right kind of break.

In `conduct.ts`, `stepDeps.file` is `{ keep }` today (`conduct.ts:2007`) and
`stepDeps.agent.issue` is written inline one screen above it
(`conduct.ts:1958`):

    issue: async () => took?.ticket ?? { ref: String(options.issue), title: "", body: "" },

**Hoist that closure to a `const` above `stepDeps` and hand the same one to both
rows.** Not a tidy-up: `{{issue}}` in a `prompt:` and `{{issue}}` in a `file:`
must be the same number, and two expressions that happen to agree today are two
things that can drift. One closure makes the agreement structural.

## Do not add a parameter to `actionsFromRecipe`

`packages/conductor/unit/step-matrix.test.ts:1221-1253` pins two things about the
seam, and the implementer will hit both:

    expect(calls, "the conductor has more than one `actionsFromRecipe` call site").toBe(1);
    expect(wiring).toMatch(/const actionsAt = \(step: Step, actions: readonly StepAction\[\]\)/);
    expect(wiring).toMatch(/actionsFromRecipe\(step, actions, stepDeps\)/);

The call site is three arguments with those names, and `actionsAt`'s signature is
matched including the parameter name. A fourth argument, a renamed parameter, or
a pre-pass that rewrote the `actions` array under a different name all go red —
and they should: *"a second call site is a second table of what each step may
build"*. Going through `stepDeps` is not a dodge around the pin, it is the thing
the pin is protecting.

## The second check, and what it costs

In `createFileAction.run`, before anything else: await the issue, expand, and ask
`whyThePathEscapes` about the result. An escape returns `did-not-finish` with a
sentence — never a throw, and never a `refused`. That is this action's existing
rule and its reason is already written down (`file-action.ts` header): *"It
writes and it does not decide. `design` is not one of `REFUSING_STEPS` (0058 §3),
so a destination that could not be written reports `did-not-finish`"*. The
mirror to copy is `notThisDestination` in `file-brief-action.ts:109-115` — a
named helper composing the clause `whyThePathEscapes` returned into a sentence
that says which destination expected what.

**It is a guard for a future, and say so in the comment.** `options.issue` is a
number and `took.ticket.ref` is `String(issue.number)` (`conduct.ts:1466`), so
nothing a GitHub ticket can contribute escapes anything. What makes the check
worth its lines is 0036's named evolution — *"`{{issue}}` should become
`{{ref}}` … Jira's is `PROJ-123`"* (`doc/decisions/0036-the-core-takes-a-ticket.md:196-198`)
— and a store whose refs carry a slash. That also means **the refusal must be
reachable from a test without a store**: put the expansion in
`packages/recipe/src/recipe.ts` beside `whyThePathEscapes`, exported, taking the
written string and a ref, so `plugin.test.ts` can hand it `"../../etc"` directly
alongside its existing clause-by-clause cases. `@lingtai/actions` already depends
on `@lingtai/recipe` and already imports `whyThePathEscapes`
(`file-brief-action.ts:57`), so this adds no edge.

Cost of catching it there rather than at resolve: one claim, one clone, one
drafting agent — 0066 §6's own arithmetic, spent because the string does not
exist earlier. The pass ends `did-not-finish` at `design` with `end` still run
(`pass.ts`'s `threw`/step-ending contract), not silently.

## One addition beyond the ticket's list: an unknown placeholder is refused at resolve

`file: doc/design/{{title}}.md` would otherwise commit a file literally named
`{{title}}.md` to `main` and put its path on the log as a locator — the ticket's
own failure, reached by a typo instead of by a fixed path. Add a second clause to
`filePlugin`'s `superRefine` (`recipe.ts:337-346`): a `{{…}}` that is not
`{{issue}}` is refused, naming the one placeholder the field takes. Keep it in
the field's refinement and **not** inside `whyThePathEscapes` — that function is
also asked about a *locator* at `implement` (`file-brief-action.ts:156`), where
the string has already been expanded and the question is only about escaping.

`doc/design/{{issue}}.md` passes the existing escape check unchanged
(segments `doc`, `design`, `{{issue}}.md`), so nothing there is loosened.

## What does not change, and should be checked that it did not

- **`file-brief:`.** It reads `ActionContext.design.locator` — the value this
  action *returned*, which is the expanded path. Nothing in
  `file-brief-action.ts` or `file-port.ts` learns about placeholders, and
  `readWhatAFileKept` must stay what its header says it is: *"one resolution,
  applied unconditionally, with no branch between the argument and the read"*.
- **`conduct.ts`'s `keep`** still does `join(cwd, spec.path)`. Its docblock
  currently claims *"the path has already been refused by `whyThePathEscapes`
  when the recipe resolved, so what is left here is `join`"* (`conduct.ts:1864-1866`)
  — that sentence becomes half true and must name the action's own re-check.
- **The machine's recipe.** A path with no placeholder takes the same route and
  the same two checks and comes out identical, so this lands inert:
  experiment 015's `file:` value is unchanged by merging it, and whether to point
  the machine's recipe at `{{issue}}` before the fortnight is out is the owner's
  separate call.

## Tests, and which claim each carries

All unit — nothing here needs Postgres, a process or a real filesystem, so
`pnpm test` covers it and there is no integration-only claim to declare.

- `packages/recipe/unit/plugin.test.ts`, beside *"refuses a path that leaves the
  worktree, by the clause that is wrong with it"*: the expansion function
  directly — `("doc/design/{{issue}}.md", "310")` → `doc/design/310.md`, a path
  with no placeholder unchanged, and `("doc/{{issue}}.md", "../../etc/passwd")`
  refused by the `".." segment` clause. That last one is the **Watch out**, and
  it is the case that cannot be reached through the conductor today.
- `packages/actions/unit/file-action.test.ts`, in `describe("the recipe's own
  block, built")`: through `actionsFromRecipe`, `file: doc/design/{{issue}}.md`
  with a fake `issue` answering `"300"` — assert `kept.seen` is
  `doc/design/300.md`, and that the result's `locator` and the `evidence`
  sentence carry the expanded path and not the template. The evidence assertion
  is the ticket's actual subject: the locator on `StepPassed` is what somebody
  follows a year later.
- The same file's escape case: an action whose expansion escapes returns
  `did-not-finish` with the clause in it, and `deps.keep` was never called.

## Documents

- `doc/plugins/file.md` — the `file` row under **Parameters** gains the
  placeholder; a short block under it saying `{{issue}}` is taken, `{{title}}`
  deliberately is not (a filename is a slug problem — spaces, slashes, length,
  two tickets with one title), and that an unknown `{{…}}` is refused at resolve.
  The second example already hard-codes `doc/design/300.md` — that is the block
  to change, and `plugin.test.ts:1147-1156` is the test that shows it, so the two
  move together.
- `doc/reference.md:912`'s `file:` cell — one clause, so the one-line reading and
  the page do not disagree about what the field accepts.
- `packages/actions/src/file-action.ts`'s header and `filePlugin`'s docblock in
  `recipe.ts` — a short section on **why the substitution is not at resolve**,
  making the `configHash` argument above the written reason rather than
  something a later reader has to rediscover. That is the paragraph that stops
  the next person moving it "earlier, where the other refusal is".

No ADR. 0066 §1 is the decision this restores, §6 is the rule it keeps on both
sides of the expansion, and 0036 already names the vocabulary and its evolution —
nothing here contradicts an accepted decision, so there is nothing to supersede.
