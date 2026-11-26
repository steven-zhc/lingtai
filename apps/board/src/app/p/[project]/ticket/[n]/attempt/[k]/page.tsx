import { notFound } from 'next/navigation'

import { ticketIdOf } from '@/lib/paths'
import { attemptOfSegment } from '@/lib/tabs'
import { loadAttemptTab } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { AttemptTab } from '../../../../../../attempt-tab.tsx'
import { TabFailed } from '../../../../../../tab-failed.tsx'
import { guarded } from '../../../../../../tab-view.ts'

export const dynamic = 'force-dynamic'

/**
 * `/p/<project>/ticket/<n>/attempt/<k>`: one attempt's tab (#885). Its loader is its own and
 * **never `loadTask`** — a tab switch must not re-run the layout's reads.
 */
export default async function AttemptTabPage({
  params,
}: {
  params: Promise<{ project: string; n: string; k: string }>
}) {
  const { project, n, k } = await params
  const taskId = ticketIdOf(project, n)
  if (taskId === null) notFound()
  const attempt = attemptOfSegment(k)
  if (attempt === null) notFound()
  const [read, timings] = await measure(() => guarded(() => loadAttemptTab(taskId, attempt)), {
    label: '/task tab',
  })
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? (
        <TabFailed what={`attempt ${attempt}`} />
      ) : (
        <AttemptTab key={read.detail.run.runId} detail={read.detail} />
      )}
    </>
  )
}
