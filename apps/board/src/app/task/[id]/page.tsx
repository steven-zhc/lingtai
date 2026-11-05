import { notFound } from 'next/navigation'

import { loadTicketAnswer } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { AttemptTab } from '../../attempt-tab.tsx'
import { TabFailed } from '../../tab-failed.tsx'
import { loadDefaultTab } from '../../tab-view.ts'
import { TicketTab } from '../../ticket-tab.tsx'

export const dynamic = 'force-dynamic'

/**
 * `/task/<id>`: the default tab, in place (#885). The attempt the page is
 * deciding on while the ticket is blocked, else the newest, else the Ticket —
 * `defaultTabOf`, the function the tab row marks the selection with. Not a
 * redirect: the URL stays the one that was asked for.
 */
export default async function TaskDefaultTab({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const taskId = decodeURIComponent(id)
  // Not awaited, and shared with the layout's read: only the Ticket tab draws it (0118 §2).
  const answer = loadTicketAnswer(taskId)
  const [read, timings] = await measure(() => loadDefaultTab(taskId), { label: '/task tab' })
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? (
        <TabFailed what="this tab" />
      ) : read.detail.kind === 'ticket' ? (
        <TicketTab detail={read.detail.detail} answer={answer} />
      ) : (
        <AttemptTab key={read.detail.detail.run.runId} detail={read.detail.detail} />
      )}
    </>
  )
}
