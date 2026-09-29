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
// The enum itself and not only its type: `createToollessRuntime` walks
// `RuntimeId.options`, so a third runtime is a candidate by being in the enum.
import { RuntimeId } from "@lingtai/domain";
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
   * worktree, no hook, no gates, and therefore **no tools at all**. Claude Code's
   * row turns it into `--permission-mode default` beside a settings file that
   * denies every tool by name; **Codex's row refuses it**, because Codex has no
   * way to say it (`ToolsCannotBeDenied`).
   */
  tools?: "full" | "none";
}

/**
 * A runtime asked for something it has no way to promise.
 *
 * Thrown rather than approximated (`#313`). `tools: "none"` is not a preference:
 * it is the containment the third kind of agent *is*, and a row that answered it
 * with the nearest flag it had would hand a caller an agent it believed was
 * tool-free. 0007's rule about a tier applies to this for the same reason — it
 * *"records `DispatchRefused` when the combination cannot meet the tier — it
 * never silently downgrades."*
 */
export class ToolsCannotBeDenied extends Error {
  override readonly name = "ToolsCannotBeDenied";
  /**
   * Assigned in the body rather than declared as a constructor parameter
   * property, which is the one TypeScript feature this repository cannot use:
   * [0010](../../../doc/decisions/0010-source-runs-unbuilt.md) runs the source
   * through Node's **strip-only** type removal, and a parameter property needs
   * a transform rather than an erasure — `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`,
   * at import, before any of this file runs.
   *
   * It is invisible to both gates: `tsc` and vitest each transform properly, so
   * `pnpm test` and `pnpm typecheck` were green on the commit that broke every
   * `lingtai` command.
   */
  readonly id: RuntimeId;
  constructor(id: RuntimeId) {
    super(
      `${id} has no way to be given no tools, and a discussion has no other containment: ` +
        "measured on codex-cli 0.155.1, `-s read-only` forbids writes and forbids nothing " +
        "else — the agent keeps a shell and read access to the whole machine, ~/.ssh " +
        "included. Claude Code's tool-deny list is not a file Codex reads (0033 §1).",
    );
    this.id = id;
  }
}

export const RUNTIMES: Record<RuntimeId, (options?: RuntimeOptions) => Runtime> = {
  "claude-code": (options = {}) =>
    createClaudeCodeRuntime({
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      permissionMode: options.tools === "none" ? "default" : "bypassPermissions",
    }),
  codex: (options = {}) => {
    /**
     * **`read-only` is not `tools: "none"`, and this row says so** (`#313`).
     *
     * It translated the one to the other, which looked like the Codex half of
     * 0054 and was the loss of a whole layer: `answerDiscussion` hands its
     * runtime a settings file whose docstring is *"Every tool, denied"* — Bash,
     * Read, Write, Glob, Grep, WebFetch, Task — and Codex reads no Claude Code
     * settings file. `codexHookArgs` looks for a `hooks` key, finds none and
     * returns `[]`, so nothing reported that the list had been dropped.
     *
     * What `-s read-only` buys is a *write* boundary. Measured: a Codex agent in
     * an empty directory under `-s read-only` was asked to `ls /Users/steven` and
     * printed it. Two of the three stated layers are gone and the third (the
     * empty working directory) is one `cd` from irrelevant.
     *
     * Nothing else in the binary closes it: the `[permissions]` filesystem table
     * did not restrict reads under `-s` when tried, and `enabled_tools` /
     * `disabled_tools` are MCP server keys and not the built-in shell.
     */
    if (options.tools === "none") throw new ToolsCannotBeDenied("codex");
    return createCodexRuntime({
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      sandbox: "workspace-write",
    });
  },
};

/**
 * The runtime the recipe named.
 *
 * Total over `RuntimeId`, so there is no `undefined` branch for a caller to
 * invent a fallback in — a fallback is how `runtime.agent` came to be a field
 * that changed nothing.
 *
 * **Total over ids and not over options**: `ToolsCannotBeDenied` is thrown where
 * the runtime named cannot keep the promise the options asked for. A caller that
 * asks for `tools: "none"` has to say what it does when the answer is no, and
 * `createToollessRuntime` is what a caller that must still answer does.
 */
export function createRuntime(id: RuntimeId, options?: RuntimeOptions): Runtime {
  return RUNTIMES[id](options);
}

/**
 * A runtime that can be given **no tools**, preferring the one named.
 *
 * For the third kind of agent (0033) — a discussion — whose containment is a
 * deny-everything settings file and an empty working directory, and **not the
 * project's business**. Which runtime works a project's tickets is the recipe's
 * `runtime.agent`; which one answers a question about one is whichever can be
 * held to no tools, and there is no reason those must be the same. Asking for the
 * recipe's first is still worth doing, because a project that names a runtime has
 * said something about what its operator has — so this prefers it and falls back
 * rather than refusing.
 *
 * Falling back and not refusing, because the alternative was measured against
 * this repository's own board: `createRuntime("codex", {tools: "none"})` throws,
 * and a project whose recipe named Codex then had **every** question answered
 * with the refusal, permanently — a capability 0033 calls a kind of agent, lost
 * as the price of choosing a runtime for passes. The containment is not lost
 * with it: what comes back can be given no tools, which is the whole of what the
 * caller asked for.
 *
 * **What this does not ask is what is signed in, and the fallback is not a claim
 * that anything is.** It reads one thing — which rows can be given no tools —
 * which is a fact about the table and never about the machine; asking otherwise
 * is `checkAuth`, a spawn, and this is synchronous. So on a machine signed in to
 * Codex alone, `createToollessRuntime("codex")` returns `claude-code`, `ask`
 * answers `{failure: {kind: "crash"}}` from a `claude` that is absent or signed
 * out, and `holdDiscussion` appends `DiscussionAnswered` with `answered: false`.
 * The row that says *that* is `lingtai doctor`'s `runtime: signed in`, which asks
 * every runtime — and `runtime: <project> signed in`, which asks the one the
 * recipe names. Neither is asked here, and a reader looking for why a discussion
 * answered nothing should look there rather than at `prepare` or the settings
 * file.
 *
 * `null` where **no** row can keep the promise, so the caller still has to say
 * what it does then. Unreachable while `claude-code` has a row, and a type is a
 * better guarantee than that sentence staying true.
 */
export function createToollessRuntime(
  preferred: RuntimeId,
): { id: RuntimeId; runtime: Runtime; instead: RuntimeId | null } | null {
  for (const id of [preferred, ...RuntimeId.options.filter((one) => one !== preferred)]) {
    try {
      return { id, runtime: createRuntime(id, { tools: "none" }), instead: id === preferred ? null : preferred };
    } catch (err) {
      // Only the promise being refused. Anything else is this table being
      // broken, and swallowing it here would make that look like a preference.
      if (!(err instanceof ToolsCannotBeDenied)) throw err;
    }
  }
  return null;
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
