import { notFound } from 'next/navigation'

import { loadTicketAnswer, loadTicketTab } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { TabFailed } from '../../../tab-failed.tsx'
import { guarded } from '../../../tab-view.ts'
import { TicketTab } from '../../../ticket-tab.tsx'

export const dynamic = 'force-dynamic'

/** `/task/<id>/ticket`: the Ticket tab (#885). Its loader is its own and never `loadTask`. */
export default async function TicketTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const taskId = decodeURIComponent(id)
  // Not awaited: the tab is sent and the body streams in (0118 §2). Shared with the layout's read.
  const answer = loadTicketAnswer(taskId)
  const [read, timings] = await measure(() => guarded(() => loadTicketTab(taskId)), {
    label: '/task tab',
  })
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? <TabFailed what="the ticket" /> : <TicketTab detail={read.detail} answer={answer} />}
    </>
  )
}
