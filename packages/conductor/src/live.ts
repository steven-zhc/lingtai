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
import { Layer } from "effect";
import { AgentHost, Repo, type RunPorts } from "./ports.ts";

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

/**
 * The same wiring as a `Layer`, for a host that provides rather than passes.
 *
 * `Layer.succeed` and not `Layer.effect`: neither of these acquires anything —
 * they are records of functions, and the resources they *reach* (a worktree, a
 * socket, a subprocess) are each acquired and released inside the call that
 * needs them. The one thing a host genuinely holds for a whole run is the
 * projector, and that is `Layer.scoped` in `apps/cli/src/projector.ts`, where
 * `Scope` earns what it is for.
 */
export const RepoLive = Layer.succeed(Repo, livePorts().repo);
export const AgentHostLive = Layer.succeed(AgentHost, livePorts().agent);

/** Both, for a host that wants the real world and no choices. */
export const PortsLive = Layer.merge(RepoLive, AgentHostLive);
