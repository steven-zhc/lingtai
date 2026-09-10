/**
 * Turning a point's action list into gates that can run.
 *
 * An action whose dependency is missing is **refused loudly**, naming what is
 * absent. A pipeline that silently skipped a `human` action because nothing
 * supplied it would produce a green board for a change nobody approved — which
 * is worse than a run that will not start.
 */
import { type GateAction, kindOfAction } from "@lingtai/recipe";
import { type AgentGateDeps, createAgentGate } from "./agent-gate.ts";
import type { Gate } from "./gate.ts";
import { createHumanGate } from "./human-gate.ts";
import { createWatchGate, type WatchGateDeps } from "./watch-gate.ts";
import { createProcessGate } from "./process-gate.ts";

/**
 * What the actions that are not pure processes need from the caller.
 *
 * Optional, because `lingtai doctor` and the config tests build gates purely to
 * check that a recipe *can* be built. Absent deps make an `agent` action refuse
 * loudly, rather than by quietly not running.
 */
export interface GateDeps {
  agent?: AgentGateDeps;
  watch?: WatchGateDeps;
  /**
   * The declared names of a `run:` action → the whole environment its process
   * gets ([0037](../../../doc/decisions/0037-an-extension-is-a-command.md) §1).
   *
   * A function rather than a map because only the caller can read 0021's
   * layers, and only it knows to add `runnableEnv`'s `PATH`. It is optional for
   * the reason the other two are — a caller checking that a recipe *can* be
   * built has no machine to read — and absent it refuses a `run:` action by
   * name rather than running one with no environment at all.
   */
  env?: (declared: readonly string[]) => Record<string, string>;
}

export class GateActionUnavailableError extends Error {
  override readonly name = "GateActionUnavailableError";
  readonly kind: string;
  readonly action: string;

  constructor(action: string, kind: string, missing: string) {
    super(
      `the "${action}" action is a "${kind}", and ${missing}. ` +
        "Refusing to run rather than skipping it: an action that is silently absent is worse than a run that will not start.",
    );
    this.action = action;
    this.kind = kind;
  }
}

export function gatesFromRecipe(actions: readonly GateAction[], deps: GateDeps = {}): Gate[] {
  return actions.map((action) => {
    const kind = kindOfAction(action);

    if ("run" in action) {
      if (!deps.env) {
        // Refused rather than run with `{}`: without a resolver there is no
        // `PATH` either, so every such gate would fail on "command not found"
        // and read as a broken build rather than as a gate built wrong.
        throw new GateActionUnavailableError(
          action.name,
          kind,
          "no environment resolver was supplied to gatesFromRecipe",
        );
      }
      return createProcessGate({
        name: action.name,
        run: action.run,
        timeout: action.timeout,
        // 0037 §1: the declared set is the whole set. An action that declares
        // nothing gets only what any process needs, never the daemon's.
        env: deps.env(action.env),
      });
    }

    if ("agent" in action) {
      if (!deps.agent) {
        throw new GateActionUnavailableError(action.name, kind, "no reviewer was supplied to gatesFromRecipe");
      }
      return createAgentGate({ name: action.name, prompt: action.agent }, deps.agent);
    }

    if ("watch" in action) {
      if (!deps.watch) {
        throw new GateActionUnavailableError(action.name, kind, "no file list was supplied to gatesFromRecipe");
      }
      // Compiles the globs here, so a bad pattern refuses at configuration time
      // rather than becoming a watch that quietly matches nothing.
      return createWatchGate({ name: action.name, watch: action.watch, then: action.then }, deps.watch);
    }

    if ("human" in action) {
      // Needs nothing: it asks, and the answer arrives later on the same
      // stream. The question is the action's own string.
      return createHumanGate({ name: action.name, question: action.human });
    }

    // `close` and `labels` are effects, not verdicts — they belong at `end`,
    // the one point that cannot refuse, and are carried out by `tell.ts`
    // rather than run here. Reaching this is a recipe that put one at a gating
    // point, and refusing loudly beats a gate that silently does nothing.
    throw new GateActionUnavailableError(
      action.name,
      kind,
      "it is an effect and only runs at the `end` point, which produces no verdict",
    );
  });
}
