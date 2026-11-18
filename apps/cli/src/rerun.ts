import { userInfo } from 'node:os'

import type { IssueChannel } from '@lingtai/conductor'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { currentRecipeEffect } from '@lingtai/conductor/projects'
import { resolveWaitEffect } from '@lingtai/conductor/resolve-wait'
import { ticketReducer, ticketStream } from '@lingtai/domain'
import { hasGitHubAuth } from '@lingtai/env'
import { eventStore, log, readThroughSnapshot } from '@lingtai/event-store'
import { readProjectEffect } from '@lingtai/project'
import { Effect } from 'effect'

import { noteConductor } from './conductor-note.ts'
import { VERBS, logVerdict, refusal, type Answered } from './verdict.ts'

/** The head is selected under the decision lock from the held run's log, and the step reruns on it (#1218). */
export function rerunVerdict(
  options: { project: string; issue: number; ifHead?: string },
  progress: (line: string) => void,
): Effect.Effect<Answered, unknown> {
  return Effect.gen(function* () {
    const project = yield* readProjectEffect(options.project)
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
      const life = item.lifecycle
      // An approved rerun is retried: its continuation may never have been scheduled.
      const rerunApproved =
        life.status === 'approved' &&
        item.waits.find((w) => w.waitId === life.waitId)?.resolution?.resolution._tag === 'RedoStep'
      if (life.status !== 'blocked' && !rerunApproved) {
        return refusal(1, 'not-waiting', `${ticketId} is not waiting on a step to rerun`, { ticketId })
      }
      if (life.status !== 'blocked' && life.status !== 'approved') {
        return refusal(1, 'not-waiting', `${ticketId} is not waiting on a step to rerun`, { ticketId })
      }
      const result = yield* resolveWaitEffect({
        ticketId,
        issue: options.issue,
        waitId: life.waitId,
        resolution: { _tag: 'RedoStep', onSha: options.ifHead ?? '', ref: null },
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
            : 'the step runs again on the saved work',
          ...(result.unscheduled ? { extra: { unscheduled: result.unscheduled } } : {}),
        },
      } satisfies Answered
    })
    const answered: Answered = yield* append
    if (answered.code === 0) yield* noteConductor(progress)
    return answered
  })
}

export function rerunCommand(
  options: { project: string; issue: number; ifHead?: string },
  log = console.log,
): Effect.Effect<number, unknown> {
  return Effect.map(rerunVerdict(options, log), (answered) => logVerdict(VERBS['rerun'], answered, log))
}
