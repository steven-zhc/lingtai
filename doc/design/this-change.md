# The shape for #313 — Codex `run()`, and one table

## Where it goes

| | |
|---|---|
| new | `packages/agent/src/runtimes.ts` — the `RuntimeId → factory` table, ~40 lines |
| grows | `packages/agent/src/codex.ts` — `run()`, `invocation()`, and a pure receipt fold beside them |
| corrected | `packages/agent/src/runtime.ts` — `meetsTier`, see §3 |
| reads the table | `conduct.ts:131`, `run.ts:235`, `discuss.ts:256`, `doctor.ts:695`, `doctor.ts:1464`, `doctor.ts:1523`, `projects.ts:128`, `propose.ts:320` |

**Eight sites, not six.** The ticket lists five plus the ternary; two more construct a runtime and are not on it:

- `packages/conductor/src/projects.ts:128` — `signedInHere = signedInProbe([createClaudeCodeRuntime(), createCodexRuntime()])`, whose own docstring is *"Every runtime is asked, not only the one that runs today"*. That array is the table's values, and deriving it is half of what makes the third-runtime claim structural.
- `apps/cli/src/run.ts:235` — `runtime: createClaudeCodeRuntime()` inside `common`. It is the hard one; §5.

## 1. What `codex exec` actually offers

Measured against the installed binary on 2026-09-29, `codex-cli 0.155.1` at `/opt/homebrew/bin/codex`, from `codex exec --help` and `strings`. Nothing here is from memory of the CLI, and every claim below is re-checkable with those two commands.

| | |
|---|---|
| entry | `codex exec [OPTIONS] [PROMPT]` — prompt as an argument or on stdin |
| stream | `--json`, *"Print events to stdout as JSONL"* |
| final message | `-o, --output-last-message <FILE>` |
| model | `-m, --model <MODEL>` |
| sandbox | `-s, --sandbox <read-only\|workspace-write\|danger-full-access>` |
| cwd | `-C, --cd <DIR>` |
| config | `-c <key=value>`, *"Use a dotted path … parsed as TOML"* |
| turns | **nothing.** There is no `--max-turns`, and no flag of any name bounds turns. |
| session id | **nothing supplied.** `exec resume <id>` consumes one; nothing sets one. |

Two of those decide fields in `RunOutcome` and one decides a capability.

**`enforces` is `["wall"]`.** `turns` has no flag to delegate to, so `run()` applies one bound and not two, and `codex.ts`'s current `enforces: []` — *"Neither, because nothing here runs"* — becomes `["wall"]` and not more. The visible consequence is the point: `limitsRow` (`doctor.ts:1523`) turns **`fail`** for every Codex project, with its own sentence *"the recipe declares a spend nothing will stop"*. That is `#89` working, not a regression. Do not silence it, do not special-case it, and do not count turns off the stream and call that enforcement — counting is not stopping, and `claude-code.ts:200`'s comment says why a SIGTERM at a counted bound is worse than no bound at all: *"A SIGTERM from here would record exactly the runs that overspent as costing nothing."*

**`sessionId` is observed, not derived.** `sessionIdFor` (`claude-code.ts:92`) exists because `--session-id` takes one; Codex prints its own. Read it off the stream. **Do not reuse `sessionIdFor` here** — the field's contract is *"The runtime's own session identifier, for finding its transcript"* (`runtime.ts`), and a computable-looking UUID that names no transcript is a worse answer than an empty string. Where the stream was cut before the id arrived, return `""` and put a `trace.note` on the log saying so.

## 2. The receipt is a pure function, and that is the testing decision

`pnpm test` is the `build` gate and runs the **unit** project only; `packages/agent/integration/claude-code.test.ts` spawns a stand-in binary and is therefore in the 803-second half that no agent can reach inside a pass. So the shape is forced:

> **Everything except `spawn` lives in an exported pure function.**

`claude-code.ts` already half-does this — `parseResult` (`claude-code.ts:513`), `receiptIn`, `traceOf`, `lineReader` are all exported or pure, and `argsFor` is the single argv builder that `run` and `invocation` share so *"the two cannot drift"*. Codex's version should go further: a `codexOutcome(lines, context)` that takes the JSONL and returns the accounting — `turns`, `costUsd`, `text`, `sessionId`, `failure` — with `run()` reduced to spawn, pipe, wall-clock `setTimeout`, and one call to it. Then the receipt logic is unit-testable against fixture lines, the argv is unit-testable through `invocation()`, and the only thing the integration half adds is that a process really starts.

That is the unit-level claim standing in for the ticket's first `Done when` box, which see §7.

## 3. Hooks, `canFailClosed`, and the `meetsTier` correction

The ticket asks for one sentence, decided before the adapter. Here it is, and it has two halves because the first is unmeasured and the second is not conditional on it.

**Codex's hook wire protocol is Claude Code's; only the pointing differs.** `strings` on the binary shows a hook dispatcher with events `PreToolUse PermissionRequest PostToolUse PreCompact PostCompact SessionStart SessionEnd UserPromptSubmit SubagentStart SubagentStop Stop Interrupt`, and a wire vocabulary of `hook_event_name`, `session_id`, `tool_name`, `tool_input`, `hookSpecificOutput`, `permissionDecision`, `continue`, `stopReason`, `systemMessage`, `additionalContext` — the same JSON `lingtai-hook` already reads and writes. ADR [0007](doc/decisions/0007-dual-runtime.md) said so at the outset: *"The hook models are isomorphic — JSON on stdin, JSON on stdout — so the adapter needs one contract and a field normaliser, not two code paths,"* and its table already records `hooks.json` or `[hooks]` in `config.toml` as the configuration side. The binary agrees: `hooks.json` and a `hooks:` config key are both in it.

**`CODEX_HOME` is not the lever, because it also holds the credentials.** `--ignore-user-config`'s own help reads *"Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`."* A per-run `CODEX_HOME` containing only our `hooks.json` is a run that is not signed in, which is `checkAuth` passing and the run failing — the exact shape `auth.ts`'s docstring already names once. So the candidate is `-c hooks=<absolute path>`, which pairs with `--dangerously-bypass-hook-trust` (*"Run enabled hooks without requiring persisted hook trust for this invocation. … Intended only for automation that already vets hook sources"* — we compile the binary, so we do).

**That candidate is unmeasured and measuring it costs one cheap turn.** `codex exec -c hooks=<path> --dangerously-bypass-hook-trust --json "reply with the word ok"` against a `hooks.json` pointing `SessionStart` at `/bin/echo` either shows the hook firing or does not. Make that measurement first; it is the only spend this ticket needs and it settles the branch.

**And whichever way it goes, `meetsTier` is wrong today and #313 is where it is corrected.** `runtime.ts:meetsTier` ranks `open < guarded < sandboxed` and returns on rank alone, so a `providesTier: "sandboxed"` runtime satisfies a `guarded` recipe **without `canFailClosed` ever being read**. `missingForTier`'s `guarded` branch already carries the right sentence — `pre-tool-use-interception` — behind a comment admitting it never fires: *"A stated precondition, not a branch that fires today: both runtimes declare `canFailClosed`."* If Codex lands unhooked, that branch has to fire, and rank alone will not let it.

So: **`guarded` is an axis, not a rung.** `meetsTier` requires `canFailClosed` for `guarded` *and* for `sandboxed`, and the rank test stays for the filesystem half. This is not a new decision needing an ADR — 0007 is the decision, and it says the scheduler *"records `DispatchRefused` when the combination cannot meet the tier — it never silently downgrades."* A rank that grants `guarded` to a runtime that cannot fail closed is that silent downgrade. Correcting the function executes 0007; leaving it is what would contradict it.

If the hooks wire: `canFailClosed` stays `true`, `providesTier` stays `sandboxed`, and the `meetsTier` fix is dead code that is correct anyway. If they do not: `canFailClosed` becomes `false`, `providesTier` stays `sandboxed` because the sandbox is real, and **`tier: guarded` on a Codex project is refused by name** with `pre-tool-use-interception` — which is the honest answer and the one the ticket asks to be stated rather than discovered.

**One thing not to widen:** `CODEX_CAPABILITIES.hooks` is five names with the comment *"Codex has no SessionEnd, PreCompact or Notification."* As of 0.155.1 that sentence is false — `SessionEnd`, `PreCompact` and `PostCompact` are all in the dispatcher. The list itself is right for the wrong reason: `INTERSECTION_HOOKS` (`hook-config.ts:31`) is four names and is what Lingtai wires, so nothing downstream changes. Correct the comment to say what is true — *the intersection is the contract, and the extras are unwired rather than absent* — and leave the list, `renderSettings`'s `CLAUDE_ONLY_HOOKS`, and 0007's table alone. Widening the declaration is a different ticket, and 0007's table would want a superseding file rather than an edit.

## 4. `costUsd`, `turns`, and the trap under `neverStarted`

`costUsd` is `null` when Codex reports none, per [#198](https://github.com/steven-zhc/lingtai/issues/198) and the type. That part is settled.

What is not settled, and is the failure this will actually produce: **`neverStarted` (`runtime.ts`) will classify every failed Codex run as `never-started`** if `turns` arrives as `0` and `costUsd` as `null`. Its three facts are *at most one turn, zero cost, an error*, and `costUsd` null counts as zero. A Codex `run()` that fills `turns: 0` because it did not count would report `never-started` for a crash, a bad flag and a quota alike — which is 0031 and 0041's bug reproduced in the second adapter, one runtime along.

The function's own docstring forbids it: *"an unparseable receipt leaves turns at zero and cost at null by ignorance rather than by evidence, so a caller has to have actually seen the runtime say so."* So either count turns off the JSONL — one per agent-message item — and pass `neverStarted` a number that was measured, or, where the stream gave nothing countable, **return `crash` and do not consult `neverStarted` at all.** Never both zeros by default.

`turns: 0` on a run that *succeeded* is the same lie as `costUsd: 0`, and the type does not let you write `null`. Count it.

## 5. The table, and the one place it does not fit

```ts
// packages/agent/src/runtimes.ts
export interface RuntimeOptions {
  binary?: string;
  /** Whether this agent may act, or only read and answer. */
  tools?: "full" | "none";
}
export const RUNTIMES: Record<RuntimeId, (o?: RuntimeOptions) => Runtime> = { … };
export function createRuntime(id: RuntimeId, o?: RuntimeOptions): Runtime;
```

**The table's options are runtime-neutral, and each row translates.** `discuss.ts:256` passes `permissionMode: "default"`, which is Claude Code's enum — Codex has no such word, it has `-s read-only`. A table typed on `ClaudeCodeOptions` would make the Codex row translate an enum from a vocabulary it does not share, and the third runtime would inherit the same problem. So the caller passes the intent (`tools: "none"`), `claude-code`'s row turns it into `--permission-mode default`, `codex`'s into `-s read-only` with no bypass flag, and `ClaudeCodeOptions.permissionMode` stays the adapter's own private type. This is [0054](doc/decisions/0054-a-role-keeps-its-permissions-when-its-agent-changes.md) — *a role keeps its permissions when its agent changes* — applied one ticket early, and it is the answer to the ticket's *"the one design choice here."*

`Record<RuntimeId, …>` rather than a `Map` or an array, because a `RuntimeId` added with no row is then a type error at the table rather than an `undefined` at a call site.

**`propose.ts:320` is not a factory call and must not read the factory table.** It picks a preference among ids already signed in; what it needs is an order, and the enum has one:

```ts
const runtime = RuntimeId.options.find((id) => signedIn.includes(id)) ?? null;
```

`RuntimeId` is a zod enum at `packages/domain/src/events.ts:123` and `.options` is `["claude-code", "codex"]` — the same order the ternary hardcodes, now derived. The refusal below it (*"`X` and `Y` are all signed in … which one runs is a question for a person"*) is unchanged and still right.

**`run.ts:235` is the one that needs reordering.** In the queue branch the recipe is resolved at `run.ts:252`, *after* `common` is built at 235; in the `--issue` branch it is never resolved at all — `runOnce` resolves it internally. Both need the recipe before they can name a runtime. Resolve it in `run.ts` before `common`, in both branches, via the same `currentRecipe(project, client)`: it is a file read and nothing else — `projects.ts`'s docstring is explicit that *"No request is made and nothing is read from the repository"* — so resolving it twice costs one `readFile`. Do **not** invert `RunOnceOptions.runtime` into a factory the conductor calls after resolving; that changes a port every test that supplies a fake runtime passes through, for a saving of one file read.

`conduct.ts:131` needs no reordering: `resolved` is already in hand at `conduct.ts:123`.

## 6. What stops being true when the table lands

Three sentences in the code become wrong the moment a second runtime is dispatched, and each of them is user-facing.

- **`agentRefusal`'s top-level clause stops firing** (`packages/conductor/src/conduct.ts:277`). It compares `recipe.runtime.agent` against the dispatched id; once the caller *constructs from* that field the two always agree. Leave the check — it is now the assertion that the caller picked correctly, which is worth keeping — but its **step-level** clause is the one that still refuses, and the refusal sentence at `conduct.ts:546` ends *"no other runtime is dispatched yet"*, which is the thing this ticket makes false. Rewrite it to say what is now true: per-step dispatch is not built ([#309](https://github.com/steven-zhc/lingtai/issues/309) T2), so a step's `agent:` or `judge:` must name the runtime the recipe's `runtime.agent` already chose. `agentRemedy` (`doctor.ts:1446`) carries the same clause twice and needs the same edit.
- **`doctor.ts:1464`'s `dispatched` default and `doctor.ts:1523`'s `capabilities` default are per-machine and become per-project.** Both default to `createClaudeCodeRuntime()`, and `limitsRow`'s docstring says why — *"Every run is handed `createClaudeCodeRuntime()`, so that is whose `enforces` is asked."* That sentence expires with this ticket. `recipeRow` has `f.recipe.runtime.agent` in hand; `limitsRow` is called per project and should be handed `createRuntime(recipe.runtime.agent).capabilities`. Delete the defaults rather than re-point them: a default that is right for one project and silently wrong for the next is how `#89` was possible.
- **`signedInHere` (`projects.ts:128`) stops being a written-out pair** and becomes `signedInProbe(Object.values(RUNTIMES).map((f) => f()))`. That is what makes the "one enum value and one row" claim true rather than asserted — the probe is the place a forgotten runtime would be invisible instead of broken.

## 7. What the tests can and cannot say

The unit half can carry all of this, and should:

- **the table walk** — for every `RuntimeId.options` entry: a row exists, and `RUNTIMES[id]().capabilities.id === id`. A key that disagrees with its row is the silent pick 0046 §3 forbids, one level below where `agentRefusal` catches it.
- **the third runtime** — the ticket's box. A test cannot add a member to a zod enum, so make the claim structurally instead: assert that `signedInHere`'s probe list and `propose`'s preference order are both *derived* from `RuntimeId.options`/`RUNTIMES` and not written out, and add a type-level assertion that `RUNTIMES` is exhaustive over `RuntimeId`. Those two together are what "nothing outside the enum and the table had to change" actually means, and they fail on the day somebody writes a list by hand.
- **the receipt fold** — `codexOutcome` against fixture JSONL: a clean run, a run with no receipt, a run cut mid-line, and the one that matters — **a failed run whose stream gave no turn count is `crash` and never `never-started`** (§4).
- **`meetsTier`** — `{ providesTier: "sandboxed", canFailClosed: false }` does **not** meet `guarded`, and `missingForTier` answers `["pre-tool-use-interception"]`. That test is the whole of §3's correction and it is three lines.
- **`invocation()`** — the exact argv, including that `-s workspace-write` is present and `--dangerously-bypass-approvals-and-sandbox` is not.

**The first `Done when` box is not the agent's, and the ticket should be finished anyway.** *"A pass on this repository with `runtime.agent: codex` claims, implements, builds, reviews and lands"* requires editing `~/.lingtai/lingtai/recipe.yml` — outside every worktree since #180 — and restarting the daemon onto the merged code, which is the operator's `lingtai restart` and cannot happen inside the pass that writes the change. It is T11-shaped: an acceptance after the merge, like the Next build. Deliver every other box, say in the commit and on the ticket which runtime flags were measured against `codex-cli 0.155.1` and which were not, and leave that box for the person who restarts the daemon. Do not approximate it with a mocked pass and tick it.
