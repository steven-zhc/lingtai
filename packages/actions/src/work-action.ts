/**
 * The work action: **the one agent that writes the change, as a plugin rather
 * than as a step's body**
 * ([0065](../../../doc/decisions/0065-the-default-is-a-plugin.md) §1, `#266`).
 *
 * It closes the asymmetry 0065 §1 names. The cold reviewer has been an `agent:`
 * a person can read and edit since the recipe existed; the agent that writes the
 * code was `runtime.agent` in `~/.lingtai/config.yml`, reached through a port and
 * named nowhere a recipe could say it. Both are in the recipe now, and
 * `runtime.agent` is what the default reads where a recipe says nothing.
 *
 * **It is the second action that *makes* rather than judges, and it reports a
 * `head` for `createWorktreeAction`'s reason** — with one difference that is the
 * whole of this step: `admit`'s head is where the tree was cut, and this one is
 * *the commit this agent left*, which is what moves `onSha` for every step after
 * it. A round judged against the wrong head is a round spent on a diff nobody
 * wrote, so the thing that dispatched the agent is the only thing that says where
 * it stopped, and `LeftTheTreeAt` in `packages/conductor/src/pass.ts` carries it
 * onto the step's ending.
 *
 * **It wraps and does not reimplement** (`#226`). The dispatch itself is
 * `conduct.ts`'s — the hook wired and smoke-tested before a turn is spent, the
 * socket served, `RunStarted`/`RunFinished`/`RunProposedCompletion` appended, the
 * receipt measured from where the tree stands now, and the fix round that reads
 * `ActionContext.again` — and the caller hands it over as `WorkActionDeps.work`
 * for the reason `agent:` is handed a runtime: only a caller with a machine under
 * it can build one, and an action built without one is refused by name rather
 * than quietly doing nothing (`from-recipe.ts`).
 *
 * **Four answers, and the money is why they are four and not one.** A commit,
 * which is the receipt (0057 §2). A **question**, which buys a decision at
 * `proposed` and nothing else (0058 §3c) — the one `did-not-finish` that may
 * reach the router, which is what `because: NEEDS_INPUT` says and why this action
 * sets it. **Started and left no receipt**, which buys nothing and stands the
 * pass down. **Never started**, which is about the account rather than the diff
 * and stands the *conductor* down, releasing the item (0031 §3).
 *
 * It cannot refuse, and that is 0058 §3b's rectangle rather than this action's
 * choice: `implement` is not one of `REFUSING_STEPS`, so arriving at the router
 * and refusing are different things and only one of them is charged for.
 */
import { NEEDS_INPUT, type Action, type ActionContext, type ActionResult } from "./action.ts";
import { boundedEvidence } from "./command.ts";

/**
 * What the dispatch answers. The same four arms `Worked` carries in
 * `packages/conductor/src/pass-steps.ts`, which is where the caller's two
 * implementations — the first dispatch and the fix round — already produce them.
 */
export type WorkedAnswer =
  /** The commit it left the worktree at — the whole of what moves `onSha`. */
  | { readonly committed: string }
  /** What it wants answered, in words a person reads (0043) and a judge routes on. */
  | { readonly asked: string }
  /** 0031 §1's `never-started`: zero turns, zero cost, and about the account. */
  | { readonly neverStarted: { readonly agent: string; readonly detail: string } }
  /** It started and left no receipt — a crash, a spent turn budget, no commit. */
  | { readonly stopped: string };

/**
 * The dispatch, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `AgentActionDeps` and `WorktreeActionDeps` and a reader meets one convention.
 *
 * It is handed the **whole context** rather than the three fields it reads,
 * because what a fix round needs — `again`, `recheck`, `round`, `onSha` — is the
 * context and nothing else since `#266`, and a caller picking fields here would
 * be the second place that decides what a brief is.
 */
export interface WorkActionDeps {
  work(
    spec: { readonly prompt: string; readonly model?: string },
    context: ActionContext,
  ): Promise<WorkedAnswer>;
}

export interface WorkActionSpec {
  name: string;
  /**
   * Appended to the implementer's brief, never substituted for it — the rule
   * `createAgentAction` follows and for the same reason: a project can add what
   * it cares about and cannot remove the ticket, the design or the round it is in.
   */
  prompt: string;
  /**
   * The recipe's `model:`, handed to the runtime as-is — and **absent means the
   * runtime's own default**, so it is passed through absent rather than resolved
   * to a name here (`#245`, 0063 §2).
   */
  model?: string;
}

export function createWorkAction(spec: WorkActionSpec, deps: WorkActionDeps): Action {
  return {
    name: spec.name,
    kind: "agent",

    async run(context: ActionContext): Promise<ActionResult> {
      const answer = await deps.work(
        { prompt: spec.prompt, ...(spec.model === undefined ? {} : { model: spec.model }) },
        context,
      );

      if ("committed" in answer) {
        return {
          verdict: "passed",
          evidence: `committed ${answer.committed.slice(0, 7)}`,
          findings: [],
          head: answer.committed,
        };
      }
      if ("asked" in answer) {
        // **Not `needs-approval`**, which holds the item for a person. A question
        // from the agent that writes the code is 0058 §3c's: it buys a decision at
        // `proposed`, where there is a round to spend on the answer, and the token
        // that gets it there is this one.
        return {
          verdict: "did-not-finish",
          because: NEEDS_INPUT,
          evidence: boundedEvidence(answer.asked),
          findings: [],
        };
      }
      if ("neverStarted" in answer) {
        // The wall's own words and nothing added, exactly as `createDraftAction`
        // reports the same wall: `standDownConductor` writes the sentence a person
        // reads, and this is the detail it quotes. Which runtime met it is the
        // conductor's — one conductor dispatches one — so a name spliced in here
        // would be the second place it is said.
        return {
          verdict: "never-ran",
          evidence: boundedEvidence(answer.neverStarted.detail),
          findings: [],
        };
      }
      return { verdict: "did-not-finish", evidence: boundedEvidence(answer.stopped), findings: [] };
    },
  };
}
