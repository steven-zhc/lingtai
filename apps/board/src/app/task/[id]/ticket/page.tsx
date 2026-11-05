import { notFound } from 'next/navigation'

import { loadTicketTab } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { TabFailed } from '../../../tab-failed.tsx'
import { guarded } from '../../../tab-view.ts'
import { TicketTab } from '../../../ticket-tab.tsx'

export const dynamic = 'force-dynamic'

/** `/task/<id>/ticket`: the Ticket tab (#885). Its loader is its own and never `loadTask`. */
export default async function TicketTabPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [read, timings] = await measure(() => guarded(() => loadTicketTab(decodeURIComponent(id))), {
    label: '/task tab',
  })
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? <TabFailed what="the ticket" /> : <TicketTab detail={read.detail} />}
    </>
  )
}
