/**
 * The one place a runtime is constructed.
 *
 * Before `#313` there were eight: five `createClaudeCodeRuntime()` calls in the
 * CLI, a written-out pair in `projects.ts`'s sign-in probe, and a ternary in
 * `propose.ts` picking a preference by name. `runtime.agent: codex` was a field
 * the recipe carried, the log recorded and nothing read — so naming it did not
 * run Codex, it made `agentRefusal` refuse every pass. **A `RuntimeId` is
 * dispatchable now because it has a row here and for no other reason.**
 *
 * `Record<RuntimeId, …>` rather than a `Map` or an array, because a `RuntimeId`
 * added to the enum with no row is then a type error *at this table* rather than
 * an `undefined` at whichever call site reached for it first. That is the whole of
 * the third-runtime claim: one enum value, one row, and nothing else to find.
 */
import type { RuntimeId } from "@lingtai/domain";
import { createClaudeCodeRuntime } from "./claude-code.ts";
import { createCodexRuntime } from "./codex.ts";
import type { Runtime } from "./runtime.ts";

/**
 * What a caller may ask of *any* runtime.
 *
 * **Runtime-neutral, and each row translates.** `discuss.ts` used to pass
 * `permissionMode: "default"`, which is Claude Code's enum — Codex has no such
 * word, it has `-s read-only`. A table typed on `ClaudeCodeOptions` would make
 * every other row translate a vocabulary it does not share, and the third runtime
 * would inherit the problem. So the caller says what the agent is *for* and the
 * adapter says how: this is
 * [0054](../../../doc/decisions/0054-a-role-keeps-its-permissions-when-its-agent-changes.md)
 * — *a role keeps its permissions when its agent changes* — one ticket early.
 */
export interface RuntimeOptions {
  /** The executable. Overridable so a test can use a stand-in. */
  binary?: string;
  /**
   * Whether this agent may act, or only read and answer.
   *
   * `full` by default. `none` is the third kind of agent
   * ([0033](../../../doc/decisions/0033-the-third-kind-of-agent.md) §1) — no
   * worktree, no hook, no gates, and therefore no tools. Claude Code's row turns
   * it into `--permission-mode default`; Codex's into `-s read-only`.
   */
  tools?: "full" | "none";
}

export const RUNTIMES: Record<RuntimeId, (options?: RuntimeOptions) => Runtime> = {
  "claude-code": (options = {}) =>
    createClaudeCodeRuntime({
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      permissionMode: options.tools === "none" ? "default" : "bypassPermissions",
    }),
  codex: (options = {}) =>
    createCodexRuntime({
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      sandbox: options.tools === "none" ? "read-only" : "workspace-write",
    }),
};

/**
 * The runtime the recipe named.
 *
 * Total over `RuntimeId`, so there is no `undefined` branch for a caller to
 * invent a fallback in — a fallback is how `runtime.agent` came to be a field
 * that changed nothing.
 */
export function createRuntime(id: RuntimeId, options?: RuntimeOptions): Runtime {
  return RUNTIMES[id](options);
}

/**
 * Which runtime answers where **nothing named one**.
 *
 * Not a default for a run: a run's runtime is the recipe's `runtime.agent`, and
 * `createRuntime` is total so there is no branch to default in. This is for the
 * one caller that has no recipe to read and must still answer — `answerDiscussion`,
 * asked about a project that is not registered — and it is *named* rather than
 * inlined so that "which one did we pick, and why" has one answer instead of a
 * literal in a file nobody would grep. `unit/runtimes.test.ts` pins it to the
 * enum's own first, so it cannot drift from `propose.ts`'s preference order.
 */
export const FIRST_RUNTIME: RuntimeId = "claude-code";

/**
 * Every runtime, one of each — for asking all of them something.
 *
 * `projects.ts`'s sign-in probe is the caller, and its own docstring is *"every
 * runtime is asked, not only the one that runs today"*. Written out as a pair, it
 * was a list that would silently stop being every runtime; derived, the probe is
 * where a forgotten runtime would be **broken rather than invisible**.
 */
export function everyRuntime(options?: RuntimeOptions): Runtime[] {
  return Object.values(RUNTIMES).map((make) => make(options));
}
