/**
 * The real wiring, in the one file that is allowed to know the names.
 *
 * Kept apart from `run-once.ts` so that file imports **types only** from `repo`
 * and `agent`. A host that wants the real thing asks for it here; a test that
 * wants a fake never loads this module, and so never loads git, a socket or a
 * subprocess.
 *
 * `runOnce` defaults to this rather than demanding it, which is a deliberate
 * concession: making every caller wire three ports to run one issue would buy
 * purity with a worse command line. The default is the seam's cost, and it is
 * one line here rather than five imports there.
 */
import {
  createHookServer,
  smokeTestFailClosed,
  writeHookWiring,
} from "@lingtai/agent";
import { resolveAgentEnv } from "@lingtai/agent-env";
import { git, integrate, provisionWorktree, removeWorktree } from "@lingtai/repo";
import type { RunPorts } from "./ports.ts";

export function livePorts(): RunPorts {
  return {
    repo: {
      provision: provisionWorktree,
      remove: removeWorktree,
      git,
      integrate,
    },
    agent: {
      wire: writeHookWiring,
      smokeTest: smokeTestFailClosed,
      serve: createHookServer,
      resolveEnv: resolveAgentEnv,
    },
  };
}
