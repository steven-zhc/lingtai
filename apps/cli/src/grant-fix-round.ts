import { userInfo } from 'node:os'

import type { IssueChannel } from '@lingtai/conductor'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { currentRecipeEffect, loadProjectEffect } from '@lingtai/conductor/projects'
import { resolveWaitEffect } from '@lingtai/conductor/resolve-wait'
import { ticketReducer, ticketStream } from '@lingtai/domain'
import { hasGitHubAuth } from '@lingtai/env'
import { eventStore, log, readThroughSnapshot } from '@lingtai/event-store'
import { Effect } from 'effect'

import { noteConductor } from './conductor-note.ts'
import { lift } from './exit.ts'
import { VERBS, logVerdict, refusal, type Answered } from './verdict.ts'

/** The SHA and ref are selected under the decision lock from the held run's log. */
export function grantFixRoundVerdict(
  options: { project: string; issue: number; ifHead?: string },
  progress: (line: string) => void,
): Effect.Effect<Answered, unknown> {
  return Effect.gen(function* () {
    const project = yield* loadProjectEffect(options.project)
    if (!project) {
      return refusal(1, 'no-project', `no project named "${options.project}"`)
    }
    let client: IssueChannel & { refSha(ref: string): Promise<string | null> }
    if (project.owner === null) {
      const resolved = yield* currentRecipeEffect(project)
      client = (yield* ownerlessClientEffect(project, resolved.recipe)).client
    } else {
      if (!hasGitHubAuth()) {
        return refusal(1, 'no-github-app', 'no GitHub App configured')
      }
      client = (yield* projectClientEffect(project)).client
    }
    const append = Effect.gen(function* () {
      const ticketId = ticketStream(options.project, options.issue)
      const item = yield* readThroughSnapshot(eventStore, ticketReducer, ticketId, 'all', { snapshots: log.snapshots })
      if (
        item.lifecycle.status !== 'blocked' &&
        !(item.lifecycle.status === 'approved' && item.lifecycle.grantRef !== undefined)
      ) {
        return refusal(1, 'not-waiting', `${ticketId} is not waiting on a fix decision`, { ticketId })
      }
      const result = yield* resolveWaitEffect({
        ticketId,
        issue: options.issue,
        waitId: item.lifecycle.waitId,
        resolution: { _tag: 'GrantFixRound', onSha: options.ifHead ?? '', ref: '' },
        by: `human:${userInfo().username}`,
        client,
        github: client,
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
      } satisfies Answered
    })
    const answered: Answered = yield* append
    if (answered.code === 0) yield* lift(() => noteConductor(progress))
    return answered
  })
}

export function grantFixRoundCommand(
  options: { project: string; issue: number; ifHead?: string },
  log = console.log,
): Effect.Effect<number, unknown> {
  return Effect.map(grantFixRoundVerdict(options, log), (answered) =>
    logVerdict(VERBS['grant-fix-round'], answered, log),
  )
}
