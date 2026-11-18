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
export function redoStepVerdict(
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
      // An approved redo is retried: its continuation may never have been scheduled.
      const redoApproved =
        life.status === 'approved' &&
        item.waits.find((w) => w.waitId === life.waitId)?.resolution?.resolution._tag === 'RedoStep'
      if (life.status !== 'blocked' && !redoApproved) {
        return refusal(1, 'not-waiting', `${ticketId} is not waiting on a step to redo`, { ticketId })
      }
      if (life.status !== 'blocked' && life.status !== 'approved') {
        return refusal(1, 'not-waiting', `${ticketId} is not waiting on a step to redo`, { ticketId })
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
      if (result.unscheduled) {
        // The wait is resolved but nothing was queued: not an acceptance.
        return refusal(
          1,
          'unscheduled',
          `the wait was resolved, but scheduling failed: ${result.unscheduled}; run it again to schedule it`,
          { ticketId, extra: { unscheduled: result.unscheduled } },
        )
      }
      return {
        code: 0,
        verdict: { outcome: 'accepted', ticketId, detail: 'the step runs again on the saved work' },
      } satisfies Answered
    })
    const answered: Answered = yield* append
    if (answered.code === 0) yield* noteConductor(progress)
    return answered
  })
}

export function redoStepCommand(
  options: { project: string; issue: number; ifHead?: string },
  log = console.log,
): Effect.Effect<number, unknown> {
  return Effect.map(redoStepVerdict(options, log), (answered) => logVerdict(VERBS['redo-step'], answered, log))
}
