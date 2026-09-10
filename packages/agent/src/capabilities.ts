/**
 * A runtime id, and what that runtime can do — without constructing one.
 *
 * A recipe names its agent as a string (`runtime.agent`), and every caller in
 * the tree so far has answered "which runtime is that" by calling
 * `createClaudeCodeRuntime()` and not looking. That is fine where something is
 * about to be spawned. It is not fine for `lingtai doctor`, which asks about a
 * project whose recipe may name `codex`, must not spawn anything to find out,
 * and would otherwise report Claude Code's capabilities under Codex's name.
 *
 * A `Record` rather than a `switch`, so a third runtime is a compile error here
 * rather than a silent fallthrough somewhere else.
 */
import type { RuntimeId } from "@lingtai/domain";
import { CLAUDE_CODE_CAPABILITIES } from "./claude-code.ts";
import { CODEX_CAPABILITIES } from "./codex.ts";
import type { RuntimeCapabilities } from "./runtime.ts";

const BY_ID: Record<RuntimeId, RuntimeCapabilities> = {
  "claude-code": CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
};

export function capabilitiesFor(id: RuntimeId): RuntimeCapabilities {
  return BY_ID[id];
}
