/**
 * The real wiring, in the one file that is allowed to know the names.
 *
 * Kept apart from `run-once.ts` so that file imports **types only** from `repo`
 * and `agent`. A host that wants the real thing asks for it here; a test that
 * wants a fake never loads this module, and so never loads git, a socket or a
 * subprocess.
 *
 * Every name below is already an `Effect` in the package that owns it
 * ([0026](../../../doc/decisions/0026-the-conversion-past-the-seam.md)), so
 * this file is a table of names and not an adapter — except for one row, and
 * the exception is stated rather than hidden.
 */
import {
  AgentHostFailed,
  serveHookServer,
  smokeTestFailClosedEffect,
  writeHookWiringEffect,
} from "@lingtai/agent";
import { resolveAgentEnv } from "@lingtai/agent-env";
import {
  gitEffect,
  integrateEffect,
  provisionWorktreeEffect,
  removeWorktreeEffect,
} from "@lingtai/repo";
import { Effect, Layer } from "effect";
import { AgentHost, Repo, type RunPorts } from "./ports.ts";

export function livePorts(): RunPorts {
  return {
    repo: {
      provision: provisionWorktreeEffect,
      remove: removeWorktreeEffect,
      git: gitEffect,
      integrate: integrateEffect,
    },
    agent: {
      wire: writeHookWiringEffect,
      smokeTest: smokeTestFailClosedEffect,
      serve: serveHookServer,
      // The one row that is wrapped here rather than in the package it comes
      // from. `@lingtai/agent-env` decides what an agent may see; it acquires
      // nothing and has no lifetime, so 0023's "plain functions that Effect
      // code calls" applies to it as it does to `domain` and `recipe`. The
      // conductor asks for it through `AgentHost` because from a run's point of
      // view resolving the environment is something the host does.
      resolveEnv: (options) =>
        Effect.tryPromise({
          try: () => resolveAgentEnv(options),
          catch: (err) =>
            new AgentHostFailed({ operation: "resolveEnv", detail: (err as Error).message }),
        }),
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
