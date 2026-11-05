import { AttemptTab } from '../src/app/attempt-tab.tsx'
import type { AttemptTabDetail, AttemptView, StandingView } from '../src/lib/task.ts'

/**
 * One attempt's tab, for a test that holds an `AttemptView` and not a database
 * (#885). `followed` is the item running at this attempt — the page's own log is
 * rank 2 there — and `blocked` is the ticket stopped here with the page
 * deciding on it.
 */
export function Attempt({
  run,
  followed = false,
  blocked = false,
  standing = {},
  events = [],
  now,
}: {
  run: AttemptView
  followed?: boolean
  blocked?: boolean
  standing?: Partial<StandingView>
  events?: AttemptTabDetail['events']
  now?: number
}) {
  const detail: AttemptTabDetail = {
    taskId: 'ticket-lingtai-1',
    project: 'lingtai',
    run,
    events,
    standing: {
      state: followed ? 'running' : blocked ? 'blocked' : 'queued',
      runId: followed || blocked ? run.runId : null,
      deciding: blocked ? { attempt: run.attempt } : null,
      diagnosis: null,
      saidBy: null,
      ...standing,
    } as StandingView,
  }
  return <AttemptTab detail={detail} now={now} />
}
