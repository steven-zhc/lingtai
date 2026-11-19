import { userInfo } from 'node:os'

import type { IssueChannel } from '@lingtai/conductor'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { currentRecipeEffect } from '@lingtai/conductor/projects'
import { resolveWaitEffect } from '@lingtai/conductor/resolve-wait'
import { ticketReducer, ticketStream } from '@lingtai/domain'
import { allowedResolutions } from '@lingtai/domain/wait'
import { hasGitHubAuth } from '@lingtai/env'
import { eventStore, log, readThroughSnapshot } from '@lingtai/event-store'
import { readProjectEffect } from '@lingtai/project'
import { Effect } from 'effect'

import { noteConductor } from './conductor-note.ts'
import { refusal, type Answered } from './verdict.ts'

/**
 * `--pick <q>=<a>` as the answers an `AnswerQuestions` carries: `q` is the question's number as the page draws it
 * (from 1), `a` the answer id. A pick that is not that is refused by name; a question with no pick takes its
 * recommended answer, which is what the resolution means by a missing index (#1254).
 */
export function parsePicks(
  picks: readonly string[],
): { ok: true; answers: Record<string, string> } | { ok: false; detail: string } {
  const answers: Record<string, string> = {}
  for (const pick of picks) {
    const match = /^(\d+)=(.+)$/.exec(pick.trim())
    if (match === null || Number(match[1]) < 1)
      return { ok: false, detail: `--pick takes <question number>=<answer id>, like --pick 1=a — not "${pick}"` }
    answers[String(Number(match[1]) - 1)] = match[2]!
  }
  return { ok: true, answers }
}

/**
 * `lingtai answer <project> --issue <n> [--pick <q>=<a> …]` on a wait that asked questions: the answers are written
 * into the body, then the step that asked continues on its saved head. `null` where the wait offers no such answer,
 * so the caller falls back to the single-choice `answer` of a question asked before any run.
 */
export function answerQuestionsVerdict(
  options: { project: string; issue: number; picks: readonly string[] },
  progress: (line: string) => void,
): Effect.Effect<Answered | null, unknown> {
  return Effect.gen(function* () {
    const parsed = parsePicks(options.picks)
    if (!parsed.ok) return refusal(2, 'bad-pick', parsed.detail)
    const project = yield* readProjectEffect(options.project)
    if (!project) return refusal(1, 'no-project', `no project named "${options.project}"`)
    const ticketId = ticketStream(options.project, options.issue)
    const item = yield* readThroughSnapshot(eventStore, ticketReducer, ticketId, 'all', { snapshots: log.snapshots })
    const life = item.lifecycle
    const answeredAlready =
      life.status === 'approved' &&
      item.waits.find((w) => w.waitId === life.waitId)?.resolution?.resolution._tag === 'AnswerQuestions'
    if (life.status !== 'blocked' && !answeredAlready) return null
    if (life.status !== 'blocked' && life.status !== 'approved') return null
    const wait = item.waits.findLast((w) => w.waitId === life.waitId)
    if (wait === undefined) return null
    if (!answeredAlready && !allowedResolutions(wait.reason, wait.triage.result).includes('AnswerQuestions')) {
      if (options.picks.length > 0)
        return refusal(1, 'not-offered', `${ticketId} asked no questions to answer — nothing was resolved`, {
          ticketId,
        })
      return null
    }
    let client: IssueChannel & { refSha(ref: string): Promise<string | null> }
    if (project.owner === null) {
      const resolved = yield* currentRecipeEffect(project)
      client = (yield* ownerlessClientEffect(project, resolved.recipe)).client
    } else {
      if (!hasGitHubAuth()) return refusal(1, 'no-github-app', 'no GitHub App configured')
      client = (yield* projectClientEffect(project)).client
    }
    const result = yield* resolveWaitEffect({
      ticketId,
      issue: options.issue,
      waitId: life.waitId,
      resolution: { _tag: 'AnswerQuestions', onSha: '', ref: null, answers: parsed.answers },
      by: `human:${userInfo().username}`,
      client,
      github: client,
    })
    if (!result.ok) return refusal(1, result.reason, result.detail, { ticketId: result.ticketId })
    if (result.unscheduled !== undefined)
      return refusal(
        1,
        'unscheduled',
        `the wait was resolved, but scheduling failed: ${result.unscheduled}; run it again to schedule it`,
        { ticketId, extra: { unscheduled: result.unscheduled } },
      )
    yield* noteConductor(progress)
    return {
      code: 0,
      verdict: {
        outcome: 'accepted',
        ticketId,
        detail: 'the answers are in the body; the step continues on the saved work',
      },
    } satisfies Answered
  })
}
