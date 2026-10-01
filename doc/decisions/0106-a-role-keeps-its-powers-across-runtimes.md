# 0106 — Agents and runtimes: the recipe picks the runtime for each role, and the role keeps its powers whichever runtime it gets

**Status** accepted · 2026-10-01

Lingtai drives two coding-agent CLIs, Claude Code and Codex, behind one
`Runtime` port. The recipe names which runtime does each piece of work. The
implementer, the cold reviewer, the judge and the discussion assistant are
different roles with different powers, and switching a role to another
runtime changes how those powers are enforced, never what they are. Every paid
call has the same shape (which runtime, `model`, `prompt`, `limits`). The pass's
ceiling is written once at `runtime.limits`, and a step may only narrow it.
A requirement that the chosen runtime cannot meet is refused by name before
anything is spent. Lingtai never downgrades it silently and never falls back to
another agent. The hook is a thin fail-closed client, and its latency comes from
process startup.

## Context

A project may want Codex to write the code and Claude Code to review it, or the
reverse, and may want a cheap model for a one-turn judgement beside an expensive
one for the implementation. The two CLIs do not offer the same things. Claude
Code enforces a turn bound and has no filesystem sandbox. Codex has a real
sandbox but no turn bound and no way to be given zero tools. If containment
depended on which agent happened to be configured, a recipe edit could quietly
weaken a project's safety. The hook runs on every tool call, so anything placed
on that path is paid for thousands of times per run.

## Decision

1. **One port, two adapters, one table.** `Runtime` in
   `packages/agent/src/runtime.ts` carries `capabilities`, `run`, and the
   optional `invocation` and `checkAuth`. `RuntimeId` is declared once in
   `packages/domain/src/events.ts` as `claude-code | codex`. Every reader
   derives from it, including the recipe's `agent:`, `judge:` and
   `runtime.agent`. `RUNTIMES` in `packages/agent/src/runtimes.ts` is a
   `Record<RuntimeId, factory>` and is the only place a runtime is constructed.
   Adding a third runtime means one enum value, one row, and one adapter.

2. **Each adapter declares what it enforces, and the declaration is measured.**
   `RuntimeCapabilities` lists `hooks`, `canFailClosed`, `canRewriteToolCall`,
   `providesTier` and `enforces`. Claude Code (`claude -p`) provides `guarded`
   and enforces `turns` (`--max-turns`) and `wall`. Codex (`codex exec --json`,
   `-s workspace-write`) provides `sandboxed` and enforces only `wall`. A
   capability is declared only after it has been proved against the binary.

3. **The hook contract is the intersection.** Lingtai wires the hooks both
   runtimes have: `SessionStart`, `UserPromptSubmit`, `PostToolUse` and `Stop`
   (`INTERSECTION_HOOKS` in `packages/agent/src/hook-config.ts`). Claude Code's
   `SessionEnd`, `PreCompact` and `Notification` are wired as extra signal and
   are never required. Lingtai refuses no tool call, so `PreToolUse` is not
   wired. The hook settings are rendered outside the worktree, because an agent
   that can edit its own hook configuration has none.

4. **Containment is Lingtai's job, and a tier is never downgraded.**
   `runtime.tier` is `open`, `guarded` (the default) or `sandboxed`, and applies
   to the whole pass. `guarded` means the runtime stops the run when the
   `UserPromptSubmit` hook refuses (`canFailClosed`). `sandboxed` adds a
   filesystem boundary that the runtime enforces itself. `meetsTier` checks
   both conditions. Before the claim, the conductor asks every runtime the pass
   will dispatch whether it meets the tier. If one cannot, the conductor appends
   `DispatchRefused` naming the runtime and what it lacks. The real boundaries
   are the filtered environment, the disposable worktree and, where one exists,
   the runtime's sandbox. **A hook is not a security boundary**: a model can
   script around any pattern match.

5. **Roles and their powers.**

   | Role | Recipe key | May do |
   |---|---|---|
   | implementer | `agent:` at `implement` (default `runtime.agent`) | read, edit, run commands and tests, and commit in the pass's worktree |
   | fixer | the `implement` entry's runtime | the implementer's powers, in the same worktree, with the refusal's evidence in a fresh session |
   | designer | `agent:` at `design` | write the design document, or decline to |
   | cold reviewer | `agent:` at `review` (and `merge` for re-verification) | read the ticket, the diff and the tree, run checks, report findings; a fresh session per round, keyed on the commit, never the implementer's |
   | judge | `judge:` at `proposed` | `same-worktree` is a built-in function that spends nothing; a runtime judge is a paid one-turn answer, *the lines* or *the approach* |
   | discussion | `discuss.agent` | analyse the log, the ticket and the mirror files Lingtai serves it; **no tools, no commands, no writes** |

   Pushing, merging and closing issues are always the conductor's effects, and
   no agent configuration grants them to an agent.

6. **A role's boundary is enforced by the runtime, never by a prompt.** Callers
   pass `RuntimeOptions.tools: "full" | "none"`, and each row of `RUNTIMES`
   translates that value for its runtime. For Claude Code, `none` is
   `--permission-mode default` plus a settings file that denies every tool.
   Codex throws `ToolsCannotBeDenied`, because `-s read-only` forbids writes but
   still leaves a shell able to read the whole machine. For that reason
   `DiscussAgent` in `packages/recipe/src/recipe.ts` accepts only `claude-code`,
   and `apps/cli/unit/discuss-agent.test.ts` pins the two lists to each other.

7. **The recipe chooses the runtime per step, and a choice is binding.**
   `runtime.agent` (default `claude-code`) is the default for a step that names
   none. An `agent:` or runtime `judge:` on a step dispatches on that runtime.
   `agentRefusal` in `packages/conductor/src/conduct.ts` refuses a pass before
   the claim if a named runtime is one that nothing on this machine is signed in
   to. Lingtai never falls back to another runtime, whether the cause is
   unavailability or exhausted quota.

8. **A dispatch has one shape.** A plugin that pays for a model embeds the
   `DISPATCH` fields: `model` (optional; when absent the runtime uses its own
   default and Lingtai keeps no table of defaults), `prompt` (appended to the
   action's fixed brief, never substituted for it), and `limits: { turns, wall }`.
   These are sibling keys beside the plugin's own key for which runtime to use.
   `agentPlugin` embeds all three. `judgePlugin` embeds `model` and `limits` but
   not `prompt`, because its question is fixed by `judgePrompt`. A built-in
   judge takes neither.

9. **The ceiling is stated once, and a dispatch may only narrow it.**
   `runtime.limits` holds `turns` (default 300), `wall` (default `2h`),
   `rounds` (default 2) and `restarts` (default 0). A dispatch's `limits` may lower `turns`
   or `wall`. Raising either is refused at resolve. Writing `rounds` or
   `restarts` inside a dispatch is refused by name, because those values bound
   the pass, not one call. `lingtai status` computes the pass's worst case from
   these values. `discuss.limits` runs outside any pass, so it has its own
   defaults (40 turns, `5m`, via `callFor`) and is not checked against the
   ceiling.

10. **A limit the runtime cannot enforce is reported, not pretended.** Codex
    does not enforce `turns`, so `lingtai doctor`'s limits row fails for a Codex
    project and says that the wall still stops the run. Turns counted off the
    stream go into the receipt and the never-started check. They never trigger
    a kill.

11. **The hook is a thin client that fails closed.** `lingtai-hook`
    (`packages/hook/src/lingtai-hook.ts`, compiled with Bun to
    `packages/hook/bin/lingtai-hook`) reads JSON on stdin and sends one line to
    the conductor's unix socket. It exits 0 to allow and 2 to deny. A missing
    socket, a timeout (`LINGTAI_HOOK_TIMEOUT_MS`, default 2000), or an
    unparseable payload or reply all deny. The conductor smoke-tests this path at
    startup. All policy and persistence live in the conductor, and the socket
    answers synchronously.

12. **The hook's latency is the runtime's startup, and only the margin is
    tested.** About 16ms p50 is Bun starting up, and p95 crosses 20ms under load.
    `packages/agent/integration/hook.test.ts` asserts the marginal cost of the
    round trip over a fail-fast spawn of the same binary and prints the
    distribution. It does not assert an absolute figure.

## Consequences

- Any feature added to the hook's hot path is added to a budget that is
  already spent. Policy belongs in the conductor. Rewrite the hook in a
  faster-starting language only if hook time becomes a material share of a
  run's wall time.
- A recipe can mix runtimes per step. Mixing has a cost: Codex steps report no
  dollars (see [0110](0110-tokens-on-the-event-money-at-display.md)), and a
  Codex project's doctor shows a permanent `turns` failure.
- A discussion can run only on a runtime that can be given no tools, which
  today means Claude Code alone.
- Every limit or tier a runtime cannot honour shows up as a refusal before the
  claim, not as an overspend found afterwards.

## Not built yet

- **An independent review checkout.** The reviewer is meant to run in its own
  disposable worktree at the exact commit under review, so that its checks
  cannot change the work it is judging. Today the cold reviewer runs in the
  pass's development worktree (`context.cwd` in `packages/actions/src/agent-action.ts`).
  Only its session is separate.
- **A `prompt:` on `judge:`** is deliberately left open, and **per-step
  `tier`** is not offered.

---
*Replaces archived 0007, 0011, 0033, 0053, 0054, 0070 in [decisions-archive](../decisions-archive/).*
