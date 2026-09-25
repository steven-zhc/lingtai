/**
 * Turning a step's action list into actions that can run.
 *
 * An action whose dependency is missing is **refused loudly**, naming what is
 * absent. A pipeline that silently skipped a `human` action because nothing
 * supplied it would produce a green board for a change nobody approved — which
 * is worse than a run that will not start.
 */
import type { Step } from "@lingtai/domain";
import { type ActionKind, type StepAction, kindOfAction, kindRefusedAt, whyNoKindAt } from "@lingtai/recipe";
import { type AgentActionDeps, createAgentAction } from "./agent-action.ts";
import type { Action } from "./action.ts";
import { createHumanAction } from "./human-action.ts";
import { createWatchAction, type WatchActionDeps } from "./watch-action.ts";
import { createProcessAction } from "./process-action.ts";

/**
 * What the actions that are not pure processes need from the caller.
 *
 * Optional, because `lingtai doctor` and the config tests build actions purely to
 * check that a recipe *can* be built. Absent deps make an `agent` action refuse
 * loudly, rather than by quietly not running.
 */
export interface ActionDeps {
  agent?: AgentActionDeps;
  watch?: WatchActionDeps;
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

export class ActionUnavailableError extends Error {
  override readonly name = "ActionUnavailableError";
  readonly kind: string;
  readonly action: string;
  /** The step it was declared at, when it was a step that decided. */
  readonly step: Step | null;

  constructor(action: string, kind: string, missing: string, step: Step | null = null) {
    super(
      step === null
        ? `the "${action}" action is a "${kind}", and ${missing}. ` +
            "Refusing to run rather than skipping it: an action that is silently absent is worse than a run that will not start."
        : kindRefusedAt(step, kind as ActionKind, action, missing),
    );
    this.action = action;
    this.kind = kind;
    this.step = step;
  }
}

/**
 * The step's actions, or a refusal naming the first one it cannot run.
 *
 * **The step is an argument because the answer depends on it** (`#61`).
 * `KINDS_AT` in `@lingtai/recipe` is which of the thirty step × kind cells run,
 * and it is asked here as well as in the schema: a recipe cannot reach this
 * with a cell that does not run, and a caller constructing actions in code
 * gets the same sentence rather than an action that silently does nothing.
 */
export function actionsFromRecipe(
  step: Step,
  actions: readonly StepAction[],
  deps: ActionDeps = {},
): Action[] {
  return actions.map((action) => {
    const kind = kindOfAction(action);

    // The step's own answer first: "there is no diff at `prepared`" is a
    // better refusal than "no file list was supplied", and it is the true one.
    const wrongStep = whyNoKindAt(step, kind);
    if (wrongStep !== null) {
      throw new ActionUnavailableError(action.name, kind, wrongStep, step);
    }

    if ("run" in action) {
      if (!deps.env) {
        // Refused rather than run with `{}`: without a resolver there is no
        // `PATH` either, so every such action would fail on "command not found"
        // and read as a broken build rather than as an action built wrong.
        throw new ActionUnavailableError(
          action.name,
          kind,
          "no environment resolver was supplied to actionsFromRecipe",
        );
      }
      return createProcessAction({
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
        throw new ActionUnavailableError(action.name, kind, "no reviewer was supplied to actionsFromRecipe");
      }
      // `action.agent` is the *runtime* since `#245`; the prose is `prompt:`.
      // Reading the old field here would compile and send a runtime's name
      // where a reviewer's instructions belong (0063 §2).
      //
      // `agent` itself is **not** passed on, and that is not it being dropped:
      // one conductor dispatches one runtime, `deps.agent.runtime` is it, and a
      // step naming the other is refused by `agentRefusal` before the claim —
      // so by the time an action is built the two agree. `model` is spread rather
      // than assigned, because absent has to reach `RunRequest` as absent (an
      // explicit `undefined` and no key are the same to the adapter, but not to
      // a reader deciding whether this seam invents a default).
      return createAgentAction(
        { name: action.name, prompt: action.prompt, ...(action.model === undefined ? {} : { model: action.model }) },
        deps.agent,
      );
    }

    if ("watch" in action) {
      if (!deps.watch) {
        throw new ActionUnavailableError(action.name, kind, "no file list was supplied to actionsFromRecipe");
      }
      // Compiles the globs here, so a bad pattern refuses at configuration time
      // rather than becoming a watch that quietly matches nothing.
      return createWatchAction({ name: action.name, watch: action.watch, then: action.then }, deps.watch);
    }

    if ("human" in action) {
      // Needs nothing: it asks, and the answer arrives later on the same
      // stream. The question is the action's own string.
      return createHumanAction({ name: action.name, question: action.human });
    }

    // `close` and `labels` are effects, not verdicts. The check above refuses
    // one at any step that decides; reaching here is `actionsFromRecipe("end",
    // …)`, which nothing does — `end` is resolved by `end-point.ts` and carried
    // out by `tell.ts`, and there is no pipeline for it to be an action in.
    throw new ActionUnavailableError(
      action.name,
      kind,
      "the `end` step resolves its effects rather than running them as actions — see `resolveEndActions`",
      step,
    );
  });
}
