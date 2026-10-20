import { userInfo } from 'node:os'

/**
 * `lingtai approve <project> --issue <n>` — grant the approval a held run is
 * waiting for.
 *
 * The counterpart to `lingtai run --once --no-merge`. Without it that flag is
 * half a feature: the only other way to finish a held run is to run it again
 * without the flag, which starts a new run with a new worktree and a new diff
 * — so the thing that lands is not the thing anyone looked at.
 *
 * **Does not merge** (#465). It appends `WaitResolved{Approve}`, and whoever
 * holds the conductor lock continues the run from there; this command's exit
 * code says whether the approval was granted, not whether anything landed.
 */
import { approve as approveRun, currentRecipe, loadProject, ownerlessClient } from '@lingtai/conductor'
import { projectClient } from '@lingtai/conductor/filter'
import { hasGitHubApp } from '@lingtai/env'

import { withProjector } from './projector.ts'

export interface ApproveCommandOptions {
  project: string
  issue: number
  note?: string
  by?: string
}

export async function approveCommand(options: ApproveCommandOptions, log = console.log): Promise<number> {
  const project = await loadProject(options.project)
  if (!project) {
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
    return 1
  }

  // **A project with no owner has no App to check and no GitHub client to
  // build** — the same branch `conductWork` takes (`conduct.ts`). Only
  // `refSha` is read off it now (`ApproveOptions.client`).
  let client: Parameters<typeof approveRun>[0]['client']
  if (project.owner === null) {
    const resolved = await currentRecipe(project)
    client = (await ownerlessClient(project, resolved.recipe)).client
  } else {
    if (!hasGitHubApp()) {
      log(
        'no GitHub App configured — write github: in ~/.lingtai/config.yml (the /setup/github-app page on the board writes it), see doc/decisions/0114-a-github-app-not-a-token.md',
      )
      return 1
    }
    client = (await projectClient(project)).client
  }

  const by = options.by ?? `human:${userInfo().username}`

  // This is the command most likely to be run with the board open, and it moves
  // a card off the lane the board exists for. So it follows the log while it
  // works, like every other host that appends — see `withProjector`.
  return withProjector(log, async () => {
    const result = await approveRun({
      project: options.project,
      issue: options.issue,
      client,
      // An approval is never anonymous. The local account is a weak claim, but it
      // is a true one, and it is what a single-machine deployment has (0007).
      by,
      note: options.note,
      log,
    })

    if (result.ok) {
      log(`approved ${result.ticketId} — continues at ${result.continuesAt}`)
      return 0
    }
    log(`not approved (${result.reason}): ${result.detail}`)
    return 1
  })
}
