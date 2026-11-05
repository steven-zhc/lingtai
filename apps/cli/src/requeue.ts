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
import { currentRecipe, loadProject, ownerlessClient, requeue } from '@lingtai/conductor'
import { editBodyAndRequeue, type IssueChannel } from '@lingtai/conductor/edit-body'
import { projectClient } from '@lingtai/conductor/filter'
import { readState } from '@lingtai/conductor/snapshot-state'
import { ticketReducer, ticketStream } from '@lingtai/domain'
import { hasGitHubAuth } from '@lingtai/env'
import { eventStore, log, type EventStore } from '@lingtai/event-store'

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
  loadProject?: typeof loadProject
  client?: IssueChannel
  store?: EventStore
  /** The line that says no conductor will reduce this. Replaceable so a test needs no lock file. */
  conductorNote?: ConductorNote
  editBodyAndRequeue?: typeof editBodyAndRequeue
  requeue?: typeof requeue
}

export async function requeueVerdict(
  options: RequeueCommandOptions,
  progress: (line: string) => void,
  deps: RequeueDeps = {},
): Promise<Answered> {
  // Checked before the stream is read, so a mistyped project says so. Without
  // it the refusal would be `ticket-lingati-130 is backlog, not blocked`, which is
  // true, unhelpful, and about the wrong mistake.
  const project = await (deps.loadProject ?? loadProject)(options.project)
  if (!project) {
    return refusal(1, 'no-project', `no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
  }

  // Holds no projector (0100 §13): the conductor lock's holder reduces this onto
  // the board, and the note after the append says when none is up.
  const append = async (): Promise<Answered> => {
    const by = options.by ?? `human:${userInfo().username}`
    if (options.intoBody !== undefined) {
      const { client } = deps.client ? { client: deps.client } : await projectClient(project)
      const ticketId = ticketStream(options.project, options.issue)
      const item = await readState(deps.store ?? eventStore, ticketReducer, ticketId, 'all', {
        snapshots: deps.store === undefined ? log.snapshots : undefined,
      })
      if (item.lifecycle.status !== 'blocked') {
        return refusal(1, 'not-blocked', `${ticketId} is ${item.lifecycle.status}, not blocked — nothing was written`, {
          ticketId,
        })
      }
      const outcome = await (deps.editBodyAndRequeue ?? editBodyAndRequeue)({
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
    // Only needed when the wait's triage asked questions; with no GitHub App the
    // requeue refuses by name in that case and is unchanged otherwise (#921).
    const github =
      deps.client ??
      (project.owner === null
        ? (await ownerlessClient(project, (await currentRecipe(project)).recipe)).client
        : hasGitHubAuth()
          ? (await projectClient(project)).client
          : undefined)
    const outcome = await (deps.requeue ?? requeue)({
      github,
      project: options.project,
      issue: options.issue,
      // The local account: a weak claim, but a true one, and the same one the
      // board records (0007). An unblocking that named nobody would be the
      // silent waiver this system exists to remove.
      by,
      note: options.note,
      ...(deps.store ? { store: deps.store } : {}),
    })
    return fromOutcome(outcome)
  }
  const answered = await append()
  if (answered.code === 0) await noteConductor(progress, deps.conductorNote)
  return answered
}

export async function requeueCommand(
  options: RequeueCommandOptions,
  log = console.log,
  deps: RequeueDeps = {},
): Promise<number> {
  return logVerdict(VERBS['requeue'], await requeueVerdict(options, log, deps), log)
}
