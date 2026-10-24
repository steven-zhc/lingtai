import type { ProjectState } from '@lingtai/domain'
import { hasGitHubApp } from '@lingtai/env'
import { baseOf } from '@lingtai/recipe/settings'
import { conflictedPathsAt, type ConflictedPath } from '@lingtai/repo'

import { projectClient } from './filter.ts'
import { ownerlessClient } from './ownerless.ts'
import { currentRecipe } from './projects.ts'

/** The three ports `resolveWait` needs for a `ContinueConflict`, and the same three the board reads the form from. */
export type ContinueConflictPorts =
  | {
      ok: true
      client: { refSha(ref: string): Promise<string | null> }
      base: string
      conflicts: (baseSha: string, headSha: string) => Promise<ConflictedPath[]>
    }
  | { ok: false; detail: string }

/**
 * One assembly for the board's page, the board's action and `lingtai
 * continue-conflict`, so the form is built from — and the command is checked
 * against — the very same remote, base and mirror count (0118 §1: no caller
 * keeps a rule of its own).
 */
export async function continueConflictPorts(state: ProjectState): Promise<ContinueConflictPorts> {
  const resolved = await currentRecipe(state)
  let client: { refSha(ref: string): Promise<string | null> }
  if (state.owner === null) client = (await ownerlessClient(state, resolved.recipe)).client
  else if (hasGitHubApp()) client = (await projectClient(state)).client
  else return { ok: false, detail: 'no GitHub App configured' }
  return {
    ok: true,
    client,
    base: baseOf(resolved.recipe),
    conflicts: (baseSha, headSha) => conflictedPathsAt({ project: state.project!, baseSha, headSha }),
  }
}
