import { userInfo } from 'node:os'

import { currentRecipe, loadProject, ownerlessClient, resolveWait } from '@lingtai/conductor'
import { projectClient } from '@lingtai/conductor/filter'
import { reduceTicket, ticketStream } from '@lingtai/domain'
import { hasGitHubApp } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'

import { withProjector } from './projector.ts'

/** The SHA and ref are selected under the decision lock from the held run's log. */
export async function grantFixRoundCommand(
  options: { project: string; issue: number },
  log = console.log,
): Promise<number> {
  const project = await loadProject(options.project)
  if (!project) {
    log(`no project named "${options.project}"`)
    return 1
  }
  let client: { refSha(ref: string): Promise<string | null> }
  if (project.owner === null) {
    const resolved = await currentRecipe(project)
    client = (await ownerlessClient(project, resolved.recipe)).client
  } else {
    if (!hasGitHubApp()) {
      log('no GitHub App configured')
      return 1
    }
    client = (await projectClient(project)).client
  }
  return withProjector(log, async () => {
    const ticketId = ticketStream(options.project, options.issue)
    const item = reduceTicket(await eventStore.read(ticketId))
    if (
      item.lifecycle.status !== 'blocked' &&
      !(item.lifecycle.status === 'approved' && item.lifecycle.grantRef !== undefined)
    ) {
      log(`${ticketId} is not waiting on a fix decision`)
      return 1
    }
    const result = await resolveWait({
      ticketId,
      issue: options.issue,
      waitId: item.lifecycle.waitId,
      resolution: { _tag: 'GrantFixRound', onSha: '', ref: '' },
      by: `human:${userInfo().username}`,
      client,
    })
    if (!result.ok) {
      log(`fix round refused (${result.reason}): ${result.detail}`)
      return 1
    }
    log(
      result.unscheduled
        ? `fix round granted; scheduling failed: ${result.unscheduled}`
        : `fix round granted for ${ticketId}`,
    )
    return 0
  })
}
