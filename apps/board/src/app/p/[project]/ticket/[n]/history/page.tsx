import { notFound } from 'next/navigation'

import { ticketIdOf } from '@/lib/paths'
import { loadTicketAnswer, loadTicketTab } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { TabFailed } from '../../../../../tab-failed.tsx'
import { guarded } from '../../../../../tab-view.ts'
import { TicketTab } from '../../../../../ticket-tab.tsx'

export const dynamic = 'force-dynamic'

/** `/p/<project>/ticket/<n>/history`: the Ticket tab (#885). Its loader is its own and never `loadTask`. */
export default async function TicketTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; n: string }>
  searchParams: Promise<{ events?: string }>
}) {
  const { project, n } = await params
  const { events } = await searchParams
  const taskId = ticketIdOf(project, n)
  if (taskId === null) notFound()
  // Not awaited: the tab is sent and the body streams in (0118 §2). Shared with the layout's read.
  const answer = measure(() => loadTicketAnswer(taskId), { label: '/task github' }).then(([a]) => a)
  const [read, timings] = await measure(() => guarded(() => loadTicketTab(taskId)), {
    label: '/task tab',
  })
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? (
        <TabFailed what="the ticket" />
      ) : (
        <TicketTab detail={read.detail} answer={answer} eventsOpen={events === '1'} />
      )}
    </>
  )
}
