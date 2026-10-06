# 0105 — Plugins: a plugin is a declaration and an implementation, and only the implementation must be ours

**Status** accepted · 2026-10-01

Everything a step does is a plugin. A plugin has two halves: a **declaration**
— its key, its fields and their schema, the steps it serves — which is data and
is everything the core reads before anything runs; and an **implementation**,
the code that runs. The set of plugins is closed and lives in one array. Code
that is not Lingtai's never runs in Lingtai's process: a third party extends a
step with a `run:` command, or listens with a subscriber, both as subprocesses.
When a plugin makes something large, it returns the thing and an opaque
**locator** saying where it kept it; only the plugin that wrote a locator reads
it, and where an answer lands is a plugin per destination.

## Context

The pipeline ([0103](0103-a-pass-is-ten-fixed-steps.md)) puts every step's work
in plugins, so the plugin contract is the product's real extension surface. Two
pressures pull on it. Recipes must be refused for mistakes before a ticket is
claimed, which needs every field and every legal step to be knowable without
running code. And plugin code can hang, exit, leak or read
`LINGTAI_DATABASE_URL` and the GitHub App key, so whose code runs where is a
trust question. Separately, an agent can produce a document far larger than an
event should carry, and the log is replayed on every projection rebuild.

## Decision

1. **A plugin is `definePlugin(key, { fields, at })`.** `packages/recipe/src/plugin.ts`
   is the contract. `fields` are zod schemas, strict, so an unknown or misspelt
   field is refused when the recipe resolves; the schema and the JSDoc on each
   field are the documentation. `at` is a record whose keys are the steps the
   plugin serves (`"*"` means every step), and those keys alone make it legal at
   a step — see [0103](0103-a-pass-is-ten-fixed-steps.md) for how legality is
   enforced.

2. **The set is closed and is one array.** `PLUGINS` in
   `packages/recipe/src/recipe.ts`; `ActionKind` and `StepAction` are derived
   from it, so a new plugin edits one place. Today there are fourteen:

   | key | may be declared at |
   |---|---|
   | `run` | `prepared` `build` `implement` `proposed` `merge` |
   | `agent` | `design` `implement` `review` `proposed` `merge` |
   | `file` | `design` |
   | `file-brief` | `implement` |
   | `watch`, `human`, `judge` | `proposed` |
   | `worktree` | `admit` |
   | `queue` | `claim` |
   | `merge` | `merge` |
   | `close`, `labels`, `refs` | `end` |
   | `backlog` | no step (`at: {}`; refused everywhere, by a sentence naming where the bar is read) |

   [doc/plugins/index.md](../plugins/index.md) has a page per plugin, and
   `packages/recipe/unit/plugin-pages.test.ts` fails when that table and `at`
   disagree. The set is not closed against new work: a plugin doing something
   no code did before joins by the same rules — a key, a schema, an `at`.

3. **An entry names its plugin by key.** A step's list entry is a `name:` plus
   exactly one plugin key and that plugin's fields (GitHub Actions' shape);
   `pluginNaming` refuses an entry carrying zero or two keys. `name` is the one
   universal key, because the workflow addresses actions by it (`step:action`
   on the board, `lingtai waive`). There is no `plugins:` node anywhere in a
   recipe: the keys already say which plugins are used.

4. **A field's value can be withheld from everything outside the plugin.**
   `noLog(field)` marks it; `discloseSteps` replaces its value with
   `no_log:sha256:<12 hex>` before it reaches the log, the hash, the board or a
   refusal. A digest rather than a deletion, so two recipes differing only in a
   secret still hash differently. A mark on a nested schema or on the key itself
   is refused at import. The recipe file still holds names, not values.

5. **The code is untrusted; the verdict is trusted.** The trust boundary is the
   recipe: whoever can edit it can remove the step outright, so a verdict from a
   plugin the recipe named is obeyed. Plugin *code*, though, is in-process only
   when it is ours — in `PLUGINS`, reviewed in this repository. Anyone else's
   code runs as a subprocess, on its own clock, with only the credentials its
   declaration names, and never the conductor's environment.

6. **Today a third party extends a step with `run:`.** A `run:` action spawns a
   command in the worktree; exit code 0 passes, and anything else refuses at
   four of its five legal steps — at the fifth, `implement`, nothing it does
   can refuse (`#390`): the command runs after the agent and commits what it
   changed, so a failure there is absorbed and left for `build`'s own copy of
   the check to catch. `timeout:` defaults to `15m`. `env:` lists
   the variable *names* it receives, resolved from `~/.lingtai/env/`; a
   `LINGTAI_*` name is refused, and a `run:` that declares nothing gets only the
   minimal process environment. Evidence is the output's tail, clipped to 60
   lines and 8,000 bytes (`EVIDENCE_LINES`, `EVIDENCE_BYTES` in
   `packages/actions/src/command.ts`). `env:` is a field of the plugins that
   spawn a process; written under one that does not, it is refused.

7. **A subscriber is the same command, and the core never waits for it.** The
   recipe's top-level `subscribers:` takes `name`, `on:` (the event types,
   which are also the subscription), `run:` and `env:`. It is handed the event
   as JSON on stdin, killed after `2m`, and its exit code changes no outcome; a
   failure appends `PluginFailed` so `lingtai doctor` and the board can say a
   notifier stopped. *The taxonomy is a command, and whether the core waits.*

8. **A large answer is the thing plus a locator.** An action that makes
   something large returns both: the thing for whatever in the pass needs it,
   and a locator string for the log. `evidence` stays a sentence a person reads
   on a card, and every `agent:` action's evidence is clipped to the same
   60-line / 8,000-byte bound as a command's.

9. **The locator is an opaque string, and only its writer reads it.** Not a
   union, not a path type. Nothing in `packages/conductor` or above the plugin
   parses, matches or validates one, so a new destination never needs the core
   to learn a new kind. Each destination that touches the outside world gets its
   own port from the conductor (`keep` and `read` today, `readWhatAFileKept` in
   `packages/conductor/src/file-port.ts`), never a branch inside a shared one.
   `packages/conductor/unit/a-locator-the-core-did-not-write.test.ts` carries a
   URL locator through the pass byte for byte to hold this.

10. **Where an answer lands is a plugin per destination, not a field.** `file:`
    at `design` (`packages/actions/src/file-action.ts`) writes the document the
    step's drafter produced to a path in the worktree, commits it so it survives
    the pass, and answers with that path as the locator. The path is relative
    with no `..`; `{{issue}}` is its one placeholder, expanded per ticket, and the
    escape check runs twice — on the written string at resolve, on the expansion
    at run time. A second destination is a second plugin with its own fields,
    never a `destination:` field on a shared one.

11. **Both the document and the locator cross the step boundary.** `TheDesign`
    (`{ document, locator? }` in `packages/actions/src/action.ts`) rides on the
    `design` ending, on `ActionContext.design` at `implement`, and on the
    dispatch brief. Three facts stay distinct: the key absent (nothing drafted),
    `document: ""` (the agent said none is needed), and a document with a
    locator. A locator is read only off the result its own document came from.
    The document the pass carries is the source of truth; an `implement` plugin
    that resolves a locator itself owns any disagreement. `file-brief:`
    (`packages/actions/src/file-brief-action.ts`) is that plugin: it reads a
    `file:` locator back and briefs the actions after it with what it read, and
    reports a locator it does not recognise rather than guessing.

12. **There is no pairing rule between a destination and its reader.** A
    locator a plugin cannot read is the ordinary case: it ignores it and works
    from the document. So nothing at resolve checks which `design` plugin sits
    with which `implement` plugin.

13. **A destination fails in one of three ways.** A configuration error (bad
    path, missing field) is refused when the recipe resolves, before any money.
    A destination that could not be written or read at run time is a
    `did-not-finish` — `design` and `implement` may not refuse — so the pass ends
    blocked and waits for a person; it is not retried on the backoff. A step
    whose agent asks a question instead ends `asked` and reaches `proposed`,
    where a judge may offer that step again at the cost of a round; no
    destination plugin produces that ending itself.

## Consequences

- Every pre-run check — refusing a bad recipe, drawing a step, explaining why a
  kind is illegal at a step — reads only declarations, which is what would let a
  declaration come from outside the tree without moving the trust boundary.
- A first-party plugin that throws is Lingtai's bug; once a third party's can,
  a card must say whose failure it is.
- Two copies of one design exist (the pass's and the destination's) and nothing
  notices when they differ; that is accepted.
- A destination costs a page under `doc/plugins/`, a column in
  `step-matrix.test.ts`, and one port in `conduct.ts`. A recipe with no
  `design:` pays nothing, because `design`'s default is nothing.

## Not built yet

- **Declarations from outside the tree.** Every declaration lives in `PLUGINS`
  and `ActionKind` is a compile-time union. Accepting a third-party declaration
  (implemented as a subprocess) needs `ActionKind` to admit declared strings, a
  second step × kind test over declarations, and refusals that name whose fault
  it is. Where such a declaration would come from, and a registry, are undecided.
- **The richer command protocol for `run:` actions.** `command.ts` supports a
  JSON payload on stdin and a result file at `LINGTAI_RESULT`, but no step
  action passes either: a `run:` step gets no ticket context and reports only
  its exit code. Subscribers do get the payload.
- **`on-error: fail | skip`** on a command, separating *could not run* from
  *said no*; today a command that cannot start refuses.
- **A per-step time budget** that the actions at one step spend against, beyond
  each `run:`'s own `timeout:`.
- **A second destination** (for example a `confluence:` plugin). Only `file:`
  and its reader `file-brief:` exist.
- **The drafter's evidence as a sentence.** The `design` drafter still puts its
  (clipped) document on its own `StepPassed` evidence; only the `file:` action's
  evidence is the short sentence with the locator.
- **`at` values.** Each `at` key's value is the `notBuiltYet` placeholder; the
  running code is built by `actionsFromRecipe` in
  `packages/actions/src/from-recipe.ts`. See
  [the-plugin-body.md](../design/the-plugin-body.md).

---
*Replaces archived 0037, 0066, 0067, 0069 in [decisions-archive](../decisions-archive/).*
