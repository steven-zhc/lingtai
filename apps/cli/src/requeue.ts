import { userInfo } from 'node:os'

/**
 * `lingtai requeue <project> --issue <n> [--note <why>] [--into-body <text>]` —
 * hand a blocked item back to the queue.
 *
 * The board has had this button since `#84`; the terminal has not. The two are
 * wanted at different moments, and the moment this one is wanted is the worst
 * possible one for the board: on 2026-09-10 five items — #123 through #127 —
 * blocked against a harness bug in the `agent` gate, so every block was about
 * the harness and none was about the diff. Unblocking them meant writing a
 * throwaway script that imported `@lingtai/conductor` and called the function
 * the button calls.
 *
 * So this is deliberately the same function and not a second path:
 * `requeue()` appends the item's resolution — a requeue — to the item's
 * stream and nothing else, to no other stream, whichever side asked — a run
 * it sends back is left as it was, and nothing it does reads as a run
 * failing. It refuses, appending nothing, while an approval of the same item
 * is still merging (#150). Without `--into-body`, the event is the whole of the
 * decision and `reconcile` converges the label an earlier block left behind —
 * except that a wait whose triage asked questions has its answers written into
 * the body first (#921), which needs the issue channel and refuses without one.
 * With `--into-body`, the issue body is written
 * through the GitHub client before the wait is resolved. A refusal after that
 * write leaves the body changed and reports the item's current state.
 */
import { requeueEffect } from '@lingtai/conductor/decide'
import { editBodyAndRequeueEffect, type IssueChannel } from '@lingtai/conductor/edit-body'
import { projectClientEffect } from '@lingtai/conductor/filter'
import { ownerlessClientEffect } from '@lingtai/conductor/ownerless'
import { currentRecipeEffect, loadProjectEffect } from '@lingtai/conductor/projects'
import { ticketReducer, ticketStream } from '@lingtai/domain'
import { hasGitHubAuth } from '@lingtai/env'
import { eventStore, log, readThroughSnapshot, type EventStore } from '@lingtai/event-store'
import { Effect } from 'effect'

import { type ConductorNote, noteConductor } from './conductor-note.ts'
import { VERBS, fromOutcome, logVerdict, refusal, type Answered } from './verdict.ts'

export interface RequeueCommandOptions {
  project: string
  issue: number
  /**
   * Why, on the record — optional (#424). `--note` left off and `--note` with
   * nothing after it both arrive as `""`, and `requeue()` stores that verbatim
   * rather than inventing a reason.
   */
  note: string
  intoBody?: string
  by?: string
}

type RequeueDeps = {
  loadProject?: typeof loadProjectEffect
  client?: IssueChannel
  store?: EventStore
  /** The line that says no conductor will reduce this. Replaceable so a test needs no lock file. */
  conductorNote?: ConductorNote
  editBodyAndRequeue?: typeof editBodyAndRequeueEffect
  requeue?: typeof requeueEffect
}

export function requeueVerdict(
  options: RequeueCommandOptions,
  progress: (line: string) => void,
  deps: RequeueDeps = {},
): Effect.Effect<Answered, unknown> {
  return Effect.gen(function* () {
    const project = yield* (deps.loadProject ?? loadProjectEffect)(options.project)
    if (!project) {
      return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
    }

    const append = Effect.gen(function* () {
      const by = options.by ?? `human:${userInfo().username}`
      if (options.intoBody !== undefined) {
        const { client } = deps.client ? { client: deps.client } : yield* projectClientEffect(project)
        const ticketId = ticketStream(options.project, options.issue)
        const item = yield* readThroughSnapshot(deps.store ?? eventStore, ticketReducer, ticketId, 'all', {
          snapshots: deps.store === undefined ? log.snapshots : undefined,
        })
        if (item.lifecycle.status !== 'blocked') {
          return refusal(
            1,
            'not-blocked',
            `${ticketId} is ${item.lifecycle.status}, not blocked — nothing was written`,
            { ticketId },
          )
        }
        const outcome = yield* (deps.editBodyAndRequeue ?? editBodyAndRequeueEffect)({
          project: options.project,
          issue: options.issue,
          waitId: item.lifecycle.waitId,
          text: options.intoBody,
          by,
          note: options.note,
          github: client,
          ...(deps.store ? { store: deps.store } : {}),
        })
        return fromOutcome(outcome, { written: outcome.written })
      }
      const github =
        deps.client ??
        (project.owner === null
          ? (yield* ownerlessClientEffect(project, (yield* currentRecipeEffect(project)).recipe)).client
          : hasGitHubAuth()
            ? (yield* projectClientEffect(project)).client
            : undefined)
      const outcome = yield* (deps.requeue ?? requeueEffect)({
        github,
        project: options.project,
        issue: options.issue,
        by,
        note: options.note,
        ...(deps.store ? { store: deps.store } : {}),
      })
      return fromOutcome(outcome)
    })
    const answered: Answered = yield* append
    if (answered.code === 0) yield* noteConductor(progress, deps.conductorNote)
    return answered
  })
}

export function requeueCommand(
  options: RequeueCommandOptions,
  log = console.log,
  deps: RequeueDeps = {},
): Effect.Effect<number, unknown> {
  return Effect.map(requeueVerdict(options, log, deps), (answered) => logVerdict(VERBS['requeue'], answered, log))
}
