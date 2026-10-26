import { userInfo } from 'node:os'

import { currentRecipe, loadProject, ownerlessClient, resolveWait } from '@lingtai/conductor'
import { projectClient } from '@lingtai/conductor/filter'
import { reduceTicket, ticketStream } from '@lingtai/domain'
import { hasGitHubApp } from '@lingtai/env'
import { eventStore } from '@lingtai/event-store'

import { withProjector } from './projector.ts'
import { VERBS, logVerdict, refusal, type Answered } from './verdict.ts'

/** The SHA and ref are selected under the decision lock from the held run's log. */
export async function grantFixRoundVerdict(
  options: { project: string; issue: number; ifHead?: string },
  progress: (line: string) => void,
): Promise<Answered> {
  const project = await loadProject(options.project)
  if (!project) {
    return refusal(1, 'no-project', `no project named "${options.project}"`)
  }
  let client: { refSha(ref: string): Promise<string | null> }
  if (project.owner === null) {
    const resolved = await currentRecipe(project)
    client = (await ownerlessClient(project, resolved.recipe)).client
  } else {
    if (!hasGitHubApp()) {
      return refusal(1, 'no-github-app', 'no GitHub App configured')
    }
    client = (await projectClient(project)).client
  }
  return withProjector(progress, async (): Promise<Answered> => {
    const ticketId = ticketStream(options.project, options.issue)
    const item = reduceTicket(await eventStore.read(ticketId))
    if (
      item.lifecycle.status !== 'blocked' &&
      !(item.lifecycle.status === 'approved' && item.lifecycle.grantRef !== undefined)
    ) {
      return refusal(1, 'not-waiting', `${ticketId} is not waiting on a fix decision`, { ticketId })
    }
    const result = await resolveWait({
      ticketId,
      issue: options.issue,
      waitId: item.lifecycle.waitId,
      resolution: { _tag: 'GrantFixRound', onSha: options.ifHead ?? '', ref: '' },
      by: `human:${userInfo().username}`,
      client,
    })
    if (!result.ok) {
      return refusal(1, result.reason, result.detail, { ticketId: result.ticketId })
    }
    return {
      code: 0,
      verdict: {
        outcome: 'accepted',
        ticketId,
        detail: result.unscheduled
          ? `scheduling failed: ${result.unscheduled}`
          : 'one more implementation round is granted',
        ...(result.unscheduled ? { extra: { unscheduled: result.unscheduled } } : {}),
      },
    }
  })
}

export async function grantFixRoundCommand(
  options: { project: string; issue: number; ifHead?: string },
  log = console.log,
): Promise<number> {
  return logVerdict(VERBS['grant-fix-round'], await grantFixRoundVerdict(options, log), log)
}
