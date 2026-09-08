/**
 * Start it, and hear it.
 *
 * One package for the two halves of running an agent, which were three before
 * [0022](../../../doc/decisions/0022-the-seams.md): `@lingtai/runtime` started
 * the process, and `conductor` owned both the hook wiring planted in the
 * worktree and the socket that catches what comes back. Starting a subprocess
 * and listening to it are one concern; the orchestrator's job is to decide that
 * a run should happen, not to hold its file descriptors.
 *
 * `@lingtai/hook` stays separate and unchanged — a compiled binary planted in
 * the worktree, not a library, with this package as the end that talks to it.
 */
export {
  meetsTier,
  missingForTier,
  type AuthStatus,
  type RunOutcome,
  type RunRequest,
  type Runtime,
  type RuntimeCapabilities,
} from "./runtime.ts";
export {
  CLAUDE_CODE_CAPABILITIES,
  createClaudeCodeRuntime,
  newRunId,
  parseResult,
  sessionIdFor,
  type ClaudeCodeOptions,
} from "./claude-code.ts";
export { CODEX_CAPABILITIES, CodexNotImplementedError, createCodexRuntime } from "./codex.ts";
export {
  AgentHostFailed,
  CLAUDE_ONLY_HOOKS,
  INTERSECTION_HOOKS,
  SUN_PATH_MAX,
  renderSettings,
  settingsPathFor,
  smokeTestFailClosed,
  smokeTestFailClosedEffect,
  socketPathFor,
  writeHookWiring,
  writeHookWiringEffect,
  type HookWiring,
  type RenderOptions,
} from "./hook-config.ts";
export {
  createHookServer,
  redact,
  serveHookServer,
  type HookName,
  type HookServer,
  type HookServerOptions,
  type RegisteredRun,
} from "./hook-socket.ts";
