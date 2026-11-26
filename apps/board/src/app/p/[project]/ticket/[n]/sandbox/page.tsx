import { notFound } from 'next/navigation'
import { Suspense } from 'react'

import { ticketIdOf } from '@/lib/paths'
import { attemptOfQuery } from '@/lib/tabs'
import { loadSandboxTab } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { SandboxTab } from '../../../../../sandbox-tab.tsx'
import { Skeleton } from '../../../../../skeleton.tsx'
import { TabFailed } from '../../../../../tab-failed.tsx'
import { guarded } from '../../../../../tab-view.ts'

export const dynamic = 'force-dynamic'

async function Loaded({ taskId, attempt }: { taskId: string; attempt: number | null }) {
  const [read, timings] = await measure(() => guarded(() => loadSandboxTab(taskId, attempt)), {
    label: '/task tab',
  })
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? <TabFailed what="the sandbox record" /> : <SandboxTab detail={read.detail} />}
    </>
  )
}

/**
 * `/p/<project>/ticket/<n>/sandbox?attempt=<k>`: what each run of one attempt could reach and what it was refused (#1161). Its
 * loader is its own and **never `loadTask`**; it reads the attempt streams and nothing else, and writes nothing.
 * The read sits under a Suspense keyed by the attempt: switching attempts changes only the search params, which
 * the segment's `loading.tsx` does not see, so the key is what shows the skeleton again.
 */
export default async function SandboxTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ project: string; n: string }>
  searchParams: Promise<{ attempt?: string | string[] }>
}) {
  const { project, n } = await params
  const taskId = ticketIdOf(project, n)
  if (taskId === null) notFound()
  const attempt = attemptOfQuery((await searchParams).attempt)
  return (
    <Suspense key={attempt ?? 'newest'} fallback={<Skeleton shape="lines" count={8} />}>
      <Loaded taskId={taskId} attempt={attempt} />
    </Suspense>
  )
}
