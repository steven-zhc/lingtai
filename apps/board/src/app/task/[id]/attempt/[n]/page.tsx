import { notFound } from 'next/navigation'

import { attemptOfSegment } from '@/lib/tabs'
import { loadAttemptTab } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { AttemptTab } from '../../../../attempt-tab.tsx'
import { TabFailed } from '../../../../tab-failed.tsx'
import { guarded } from '../../../../tab-view.ts'

export const dynamic = 'force-dynamic'

/**
 * `/task/<id>/attempt/<n>`: one attempt's tab (#885). Its loader is its own and
 * **never `loadTask`** — a tab switch must not re-run the layout's reads.
 */
export default async function AttemptTabPage({ params }: { params: Promise<{ id: string; n: string }> }) {
  const { id, n } = await params
  const attempt = attemptOfSegment(n)
  if (attempt === null) notFound()
  const [read, timings] = await measure(() => guarded(() => loadAttemptTab(decodeURIComponent(id), attempt)), {
    label: '/task tab',
  })
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? <TabFailed what={`attempt ${attempt}`} /> : <AttemptTab detail={read.detail} />}
    </>
  )
}
