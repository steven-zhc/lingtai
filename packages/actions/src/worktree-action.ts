/**
 * The worktree action: **the branch a pass owns, cut — as a plugin rather than
 * as a step's body**
 * ([0065](../../../doc/decisions-archive/0065-the-default-is-a-plugin.md) §2, `#268`).
 *
 * It is the first action that *makes* something the rest of the pass needs
 * rather than judging something already there, and that is why it carries a
 * fifth field on its result: `head`. Every other kind is handed `onSha` and says
 * yes or no about it; this one is where `onSha` gets a value at all, because
 * `admit` is where the tree is cut (`LeftTheTreeAt` in
 * `packages/conductor/src/pass.ts`).
 *
 * **It wraps and does not reimplement.** The cut itself is
 * `provisionWorktree`'s, in `packages/repo/src/worktree.ts`, and the caller
 * hands it over as `WorktreeActionDeps.cut` for the reason `agent:` is handed a
 * runtime: only a caller with a machine under it can build one, and an action
 * built without one is refused by name rather than quietly doing nothing
 * (`from-recipe.ts`).
 *
 * **Why `did-not-finish` and never `failed` when the cut does not happen.** A
 * clone that did not finish is not a judgement about the change — nothing has
 * been written yet, so there is nothing to have been judged
 * ([0057](../../../doc/decisions-archive/0057-a-gate-that-did-not-finish.md) §1–3). So
 * it buys no fix round and stands the pass down, which is exactly what `admit`'s
 * own body said before this existed: *it cannot refuse*.
 *
 * `base` and `submodules` are read off the action rather than off `repo:`, and
 * `baseOf`/`submodulesOf` in `@lingtai/recipe` are the one place that knows
 * which of the two spellings a recipe wrote them in.
 */
import type { Action, ActionContext, ActionResult } from './action.ts'

/**
 * What the cut answers — three branches, and only two of them happen today.
 *
 * `asked` is the third and is the contract for an implementation **somebody else
 * writes**: 0058 §3b's second drawing has an edge out of `admit` for a step that
 * stopped and asked, and a port cannot report what its type cannot say. What it
 * costs has changed with the move: a question from a plugin is the pipeline's
 * `needs-approval`, so it holds the item for a person (`endingOf` reads it as
 * `held`) rather than reaching the judge at `proposed` as `needs-input`. One way
 * in for *is this worth interrupting somebody over* either way; a shorter one.
 */
export type CutAnswer =
  /** Cut, at this commit — `head`, which is the whole of what moves `onSha`. */
  | { readonly head: string; readonly where: string }
  /** What the step wants answered, in words a person reads (0043). */
  | { readonly asked: string }
  /** `RepoFailed`'s words: no mirror, no base ref, a clone that did not finish. */
  | { readonly notCut: string }

/**
 * The cut, as the only thing this action needs from its caller.
 *
 * A method on an object rather than a bare function, so the shape matches
 * `AgentActionDeps` and `WatchActionDeps` and a reader meets one convention.
 */
export interface WorktreeActionDeps {
  cut(spec: { readonly base: string; readonly submodules: boolean }): Promise<CutAnswer>
}

export interface WorktreeActionSpec {
  name: string
  /** The branch the agent's work is cut from and lands on. `origin/<base>`, never local state. */
  base: string
  /**
   * Whether the tree gets the submodules.
   *
   * Never defaulted here and never optional in the recipe: `git worktree add`
   * leaves submodule directories empty, and the tests that import one then fail
   * in a way that reads as the agent's fault — so a value nobody wrote is worse
   * than a recipe that will not resolve (`worktreePlugin` in `@lingtai/recipe`).
   */
  submodules: boolean
}

export function createWorktreeAction(spec: WorktreeActionSpec, deps: WorktreeActionDeps): Action {
  return {
    name: spec.name,
    kind: 'worktree',

    async run(context: ActionContext): Promise<ActionResult> {
      const answer = await deps.cut({ base: spec.base, submodules: spec.submodules })
      if ('head' in answer) {
        return {
          verdict: 'passed',
          evidence: `${answer.where} at ${answer.head.slice(0, 7)}, from origin/${spec.base}${
            spec.submodules ? ' with submodules' : ''
          }`,
          findings: [],
          head: answer.head,
        }
      }
      if ('asked' in answer) {
        return { verdict: 'needs-approval', evidence: answer.asked, findings: [] }
      }
      return {
        // The head the caller handed in is all a person has, because nothing was
        // cut — and at `admit` that is the base the pass started from.
        verdict: 'did-not-finish',
        evidence: `${answer.notCut} (nothing was cut at ${context.onSha.slice(0, 12)})`,
        findings: [],
      }
    },
  }
}
