/**
 * Everything Lingtai does to a git repository.
 *
 * Extracted from `conductor` by
 * [0022](../../../doc/decisions/0022-the-seams.md), and the cost that made it
 * worth doing was not aesthetic: `apps/board/src/app/actions.ts` imported `git`
 * and `stateDir` from `@lingtai/conductor/worktree`, because that was the only
 * place a git helper lived. A page reached into the orchestrator to run a shell
 * command.
 *
 * A decision about *whether* to merge belongs to `conductor`. Running the merge
 * belongs here.
 */
export { git, type GitRunOptions, type TokenSource } from "./git.ts";
export {
  ensureMirror,
  provisionWorktree,
  removeWorktree,
  worktreePath,
  type ProvisionOptions,
  type Worktree,
} from "./worktree.ts";
export {
  integrate,
  type IntegrateOptions,
  type IntegrateResult,
} from "./integrate.ts";
