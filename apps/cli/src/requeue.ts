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
 * is still merging (#150). Without `--into-body`, there is no GitHub call:
 * the event is the whole of the decision and `reconcile` converges the label
 * an earlier block left behind. With `--into-body`, the issue body is written
 * through the GitHub client before the wait is resolved. A refusal after that
 * write leaves the body changed and reports the item's current state.
 */
import { loadProject, requeue } from '@lingtai/conductor'
import { editBodyAndRequeue, type IssueChannel } from '@lingtai/conductor/edit-body'
import { projectClient } from '@lingtai/conductor/filter'
import { reduceTicket, ticketStream } from '@lingtai/domain'
import { eventStore, type EventStore } from '@lingtai/event-store'

import { withProjector } from './projector.ts'

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

export async function requeueCommand(
  options: RequeueCommandOptions,
  log = console.log,
  deps: {
    loadProject?: typeof loadProject
    client?: IssueChannel
    store?: EventStore
    withProjector?: typeof withProjector
    editBodyAndRequeue?: typeof editBodyAndRequeue
    requeue?: typeof requeue
  } = {},
): Promise<number> {
  // Checked before the stream is read, so a mistyped project says so. Without
  // it the refusal would be `ticket-lingati-130 is backlog, not blocked`, which is
  // true, unhelpful, and about the wrong mistake.
  const project = await (deps.loadProject ?? loadProject)(options.project)
  if (!project) {
    log(`no project named "${options.project}" — run lingtai add <owner>/<repo> first`)
    return 1
  }

  // Moves a card off the lane the board exists for, so it follows the log while
  // it works — the same reason `lingtai approve` does. See `withProjector`.
  return (deps.withProjector ?? withProjector)(log, async () => {
    const by = options.by ?? `human:${userInfo().username}`
    if (options.intoBody !== undefined) {
      const { client } = deps.client ? { client: deps.client } : await projectClient(project)
      const item = reduceTicket(await (deps.store ?? eventStore).read(ticketStream(options.project, options.issue)))
      if (item.lifecycle.status !== 'blocked') {
        log(
          `${ticketStream(options.project, options.issue)} is ${item.lifecycle.status}, not blocked — nothing was written`,
        )
        return 1
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
      log(outcome.detail)
      return outcome.ok ? 0 : 1
    }
    const outcome = await (deps.requeue ?? requeue)({
      project: options.project,
      issue: options.issue,
      // The local account: a weak claim, but a true one, and the same one the
      // board records (0007). An unblocking that named nobody would be the
      // silent waiver this system exists to remove.
      by,
      note: options.note,
      ...(deps.store ? { store: deps.store } : {}),
    })

    log(outcome.detail)
    return outcome.ok ? 0 : 1
  })
}
