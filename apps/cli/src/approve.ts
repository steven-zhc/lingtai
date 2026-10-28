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
import { hasGitHubAuth } from '@lingtai/env'

import { withProjector } from './projector.ts'
import { VERBS, logVerdict, refusal, type Answered } from './verdict.ts'

export interface ApproveCommandOptions {
  project: string
  issue: number
  note?: string
  by?: string
}

/** `progress` is where `withProjector`'s warnings go: stdout, or stderr under `--json`. */
export async function approveVerdict(
  options: ApproveCommandOptions,
  progress: (line: string) => void,
): Promise<Answered> {
  const project = await loadProject(options.project)
  if (!project) {
    return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
  }

  // **A project with no owner has no App to check and no GitHub client to
  // build** — the same branch `conductWork` takes (`conduct.ts`). Only
  // `refSha` is read off it now (`ApproveOptions.client`).
  let client: Parameters<typeof approveRun>[0]['client']
  if (project.owner === null) {
    const resolved = await currentRecipe(project)
    client = (await ownerlessClient(project, resolved.recipe)).client
  } else {
    if (!hasGitHubAuth()) {
      return refusal(
        1,
        'no-github-app',
        'no GitHub App configured — write github: in ~/.lingtai/config.yml (the /setup/github-app page on the board writes it), see doc/decisions/0114-a-github-app-not-a-token.md',
      )
    }
    client = (await projectClient(project)).client
  }

  const by = options.by ?? `human:${userInfo().username}`

  // This is the command most likely to be run with the board open, and it moves
  // a card off the lane the board exists for. So it follows the log while it
  // works, like every other host that appends — see `withProjector`.
  return withProjector(progress, async (): Promise<Answered> => {
    // `approveRun`'s own line carries the sha and the actor; it is held back and
    // becomes the verdict's detail, so a success prints one verdict and not two.
    const said: string[] = []
    const result = await approveRun({
      project: options.project,
      issue: options.issue,
      client,
      // An approval is never anonymous. The local account is a weak claim, but it
      // is a true one, and it is what a single-machine deployment has (0007).
      by,
      note: options.note,
      // `'open'`: `approveRun` takes the `deciding` lock and reads the item
      // inside it (`approve.ts`'s own `deciding`), so "the wait it reads" and
      // "the wait it resolves" are the same read — there is no card, read
      // before the lock, for a stale one to disagree with (#508).
      waitId: 'open',
      log: (line) => said.push(line),
    })

    if (!result.ok) {
      return refusal(1, result.reason, result.detail, { ticketId: result.ticketId })
    }
    const unscheduled = result.unscheduled
    return {
      code: 0,
      verdict: {
        outcome: 'accepted',
        ticketId: result.ticketId,
        detail:
          unscheduled === undefined
            ? (said.at(-1)?.replace(/^approved /, '') ?? `continues at ${result.continuesAt}`)
            : `continues at ${result.continuesAt}, but the continuation was not scheduled (${unscheduled}); run it again to schedule it`,
        ...(unscheduled === undefined ? {} : { next: `lingtai approve ${options.project} --issue ${options.issue}` }),
        extra: { continuesAt: result.continuesAt, ...(unscheduled === undefined ? {} : { unscheduled }) },
      },
    }
  })
}

export async function approveCommand(options: ApproveCommandOptions, log = console.log): Promise<number> {
  return logVerdict(VERBS['approve'], await approveVerdict(options, log), log)
}
