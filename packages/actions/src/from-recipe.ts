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
import { type AgentActionDeps, createAgentAction, createDraftAction } from "./agent-action.ts";
import { type WorkActionDeps, createWorkAction } from "./work-action.ts";
import type { Action } from "./action.ts";
import { createFileAction, type FileActionDeps } from "./file-action.ts";
import { createHumanAction } from "./human-action.ts";
import { createWatchAction, type WatchActionDeps } from "./watch-action.ts";
import { createProcessAction } from "./process-action.ts";
import { createMergeAction, type MergeActionDeps } from "./merge-action.ts";
import { createQueueAction, type QueueActionDeps } from "./queue-action.ts";
import { createWorktreeAction, type WorktreeActionDeps } from "./worktree-action.ts";

/**
 * What the actions that are not pure processes need from the caller.
 *
 * Optional, because `lingtai doctor` and the config tests build actions purely to
 * check that a recipe *can* be built. Absent deps make an `agent` action refuse
 * loudly, rather than by quietly not running.
 */
export interface ActionDeps {
  agent?: AgentActionDeps;
  /**
   * The dispatch the `agent:` at `implement` wraps (`#266`).
   *
   * Its own dep rather than a field on `agent`, because the two share only the
   * key a recipe writes: a cold reviewer needs a runtime and the diff, and the
   * agent that writes the change needs the hook wired, the socket served and the
   * receipt measured — all of which is `conduct.ts`'s and none of which this
   * package can build.
   */
  work?: WorkActionDeps;
  watch?: WatchActionDeps;
  /**
   * The cut a `worktree:` action runs — `provisionWorktree`, as the conductor
   * already calls it (0065 §2, `#268`).
   *
   * Optional for the reason the other two are: `lingtai doctor` and the config
   * tests build actions to check that a recipe *can* be built, and have no
   * machine to cut a tree on. Absent, a `worktree:` action is refused by name
   * rather than becoming a step that passes having cut nothing — which at
   * `admit` is a pass that briefs an agent on a directory that does not exist.
   */
  worktree?: WorktreeActionDeps;
  /**
   * The lane a `merge:` action runs — `integrate`, as the conductor already
   * calls it (0065 §2, `#270`).
   *
   * Optional for the reason the other three are, and absent it refuses a
   * `merge:` action by name rather than becoming a step that passes having
   * landed nothing — which at `merge` is a pass the board says merged and a
   * branch that is not on the base.
   */
  merge?: MergeActionDeps;
  /**
   * The take a `queue:` action runs — `runnableNow` and `claimWorkItem`, as the
   * conductor already calls them (0065 §2, `#269`).
   *
   * Optional for the reason the other three are, and absent it refuses a
   * `queue:` action by name rather than becoming a step that passes having
   * claimed nothing — which at `claim` is a pass that cuts a worktree and briefs
   * an agent about an item nobody holds.
   */
  queue?: QueueActionDeps;
  /**
   * The keep a `file:` action runs — the write into the worktree, and the commit
   * where the recipe asked for one (0066 §5, `#300`).
   *
   * Optional for the reason the others are, and absent it refuses a `file:`
   * action by name rather than becoming a step that passes having kept nothing —
   * which at `design` is a locator on the card pointing at a file that was never
   * written.
   */
  file?: FileActionDeps;
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
 * **The step is an argument because the answer depends on it** (`#61`). Each
 * plugin's own `at` in `@lingtai/recipe` is which step × kind cells run (0064
 * §4), `whyNoKindAt` is the one reading of it, and it is asked here as well as
 * in the schema: a recipe cannot reach this with a cell that does not run, and
 * a caller constructing actions in code gets the same sentence rather than an
 * action that silently does nothing.
 *
 * **Not every legal cell is an action, and `judge:` at `proposed` is the first
 * that is not** (`#274`). The pipeline runs a list and reads a verdict off each
 * entry; a judge produces neither — it answers *which step is next*, once per
 * arrival, and the router asks it (`judgeDeclaredAt` in
 * `packages/conductor/src/judge.ts`, through `ports.judge`). So it is passed over
 * here rather than refused or wrapped, which is the shape `close:` at `end`
 * already has: a cell whose consumer is a resolver and never `runActionPipeline`.
 *
 * **Passed over is not dropped, and the difference is that something else reads
 * it.** A skip nothing consumed would be `#61` wearing this function's name, so
 * the reader is asserted rather than described: `conductor/unit/step-matrix.test.ts`
 * walks `proposed × judge` through `judgeDeclaredAt` exactly as it walks `end`'s
 * effects through `resolveEndActions`, and `conduct.ts`'s one line handing it
 * `recipe.steps.proposed` is pinned there too.
 */
export function actionsFromRecipe(
  step: Step,
  actions: readonly StepAction[],
  deps: ActionDeps = {},
): Action[] {
  return actions.flatMap((action) => {
    const kind = kindOfAction(action);

    // The step's own answer first: "there is no diff at `prepared`" is a
    // better refusal than "no file list was supplied", and it is the true one.
    const wrongStep = whyNoKindAt(step, kind);
    if (wrongStep !== null) {
      throw new ActionUnavailableError(action.name, kind, wrongStep, step);
    }

    // The router's, not the pipeline's — and the only cell that is legal here and
    // is no action. `whyNoKindAt` above has already refused it at the other nine
    // steps, so this is `proposed` and nothing else.
    if ("judge" in action) return [];

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
      const agent = {
        name: action.name,
        prompt: action.prompt,
        ...(action.model === undefined ? {} : { model: action.model }),
      };
      // **One key, two actions, and the step is what picks** (`#265`). `agent:`
      // at `design` drafts and everywhere else it reviews, which is 0065 §4's own
      // table — *an `agent:` that drafts* at one step, *a cold reviewer* at the
      // others — and it is a branch rather than a flag on the spec because the
      // difference is total: the reviewer opens by asking for the diff and
      // returns `passed` when there is none, and at `design` there never is one.
      // Built here because this is the seam that knows the step; the actions
      // themselves know only what they were handed.
      // **And a third since `#266`.** `agent:` at `implement` is the agent that
      // *writes the change* — it is handed the worktree and leaves a commit, and
      // what it needs from its caller is the dispatch rather than a reviewer's
      // runtime and diff. The reviewer built for this step would ask for the diff
      // one step before there is one and return `passed` on it, which is `#61`
      // with a new spelling and the case 0065 §5 removes.
      if (step === "implement") {
        if (!deps.work) {
          throw new ActionUnavailableError(action.name, kind, "no dispatch was supplied to actionsFromRecipe");
        }
        return createWorkAction(agent, deps.work);
      }
      if (!deps.agent) {
        throw new ActionUnavailableError(action.name, kind, "no reviewer was supplied to actionsFromRecipe");
      }
      return step === "design"
        ? createDraftAction(agent, deps.agent)
        : createAgentAction(agent, deps.agent);
    }

    if ("file" in action) {
      if (!deps.file) {
        throw new ActionUnavailableError(action.name, kind, "no keep was supplied to actionsFromRecipe");
      }
      return createFileAction({ name: action.name, path: action.file }, deps.file);
    }

    if ("watch" in action) {
      if (!deps.watch) {
        throw new ActionUnavailableError(action.name, kind, "no file list was supplied to actionsFromRecipe");
      }
      // Compiles the globs here, so a bad pattern refuses at configuration time
      // rather than becoming a watch that quietly matches nothing.
      return createWatchAction({ name: action.name, watch: action.watch, then: action.then }, deps.watch);
    }

    if ("worktree" in action) {
      if (!deps.worktree) {
        throw new ActionUnavailableError(action.name, kind, "no cut was supplied to actionsFromRecipe");
      }
      // `base` and `submodules` are both read, and `submodules` is required by
      // `worktreePlugin`'s schema rather than defaulted there: a block that
      // named only the base would otherwise cut a tree with empty submodule
      // directories and read as the agent breaking the tests (`#268`).
      return createWorktreeAction(
        { name: action.name, base: action.worktree.base, submodules: action.worktree.submodules },
        deps.worktree,
      );
    }

    if ("merge" in action) {
      if (!deps.merge) {
        throw new ActionUnavailableError(action.name, kind, "no merge lane was supplied to actionsFromRecipe");
      }
      // `strategy` and nothing else, because the plugin declares nothing else:
      // the base is one value that flows, and a `merge:` block carrying one of
      // its own would manufacture a disagreement between what the pass cut and
      // what it lands (0061 §4, `mergePlugin` in `@lingtai/recipe`).
      return createMergeAction({ name: action.name, strategy: action.merge.strategy }, deps.merge);
    }

    if ("queue" in action) {
      if (!deps.queue) {
        throw new ActionUnavailableError(action.name, kind, "no take was supplied to actionsFromRecipe");
      }
      // All four fields, and the far side re-reads none of them: a `claim` that
      // selected over the recipe while the board drew the action's block would be
      // the ticket taken not being the ticket a reading says was taken (`#269`).
      return createQueueAction({ name: action.name, ...action.queue }, deps.queue);
    }

    if ("human" in action) {
      // Needs nothing: it asks, and the answer arrives later on the same
      // stream. The question is the action's own string.
      return createHumanAction({ name: action.name, question: action.human });
    }

    // `close` and `labels` are effects, not verdicts. The check above refuses
    // one at any step that decides; reaching here is `actionsFromRecipe("end",
    // …)`, which nothing does — `end` is resolved by `end-step.ts` and carried
    // out by `tell.ts`, and there is no pipeline for it to be an action in.
    throw new ActionUnavailableError(
      action.name,
      kind,
      "the `end` step resolves its effects rather than running them as actions — see `resolveEndActions`",
      step,
    );
  });
}
