/**
 * `lingtai now <project> --issue <n>` — ask for one ticket ahead of the queue.
 *
 * It appends and returns, and holds **no** projector: a projector catches up to
 * the head before it returns, so a request against a daemon that has been down
 * would replay the backlog first (`lingtai.ts`'s `controlCommand`, which this
 * was a branch of before #621).
 */
import { type Guard, makeGuard, requestRun } from '@lingtai/daemon'
import { eventStore } from '@lingtai/event-store'

import { refuseIfLocked, runEffect } from './project-pause.ts'
import { type Answered, refusal } from './verdict.ts'

export async function nowVerdict(
  project: string,
  issue: number,
  by: string,
  request: typeof requestRun = requestRun,
  guard: Guard = makeGuard({ store: eventStore }),
): Promise<Answered> {
  // A paused project is refused by name before anything is appended (#992).
  const refused = await runEffect(refuseIfLocked(project, guard))
  if (refused !== null) {
    return refusal(1, 'locked', refused, { subject: `${project} #${issue}` })
  }
  await request(project, String(issue), by)
  return {
    code: 0,
    verdict: {
      outcome: 'accepted',
      subject: `${project} #${issue}`,
      detail: `requested ${project} #${issue}`,
      extra: { project, issue, by },
    },
  }
}
