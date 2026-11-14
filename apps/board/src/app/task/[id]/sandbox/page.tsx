import { notFound } from 'next/navigation'

import { attemptOfQuery } from '@/lib/tabs'
import { loadSandboxTab } from '@/lib/task'
import { measure } from '@/lib/timing'
import { TimingMeta } from '@/lib/timing-meta'

import { SandboxTab } from '../../../sandbox-tab.tsx'
import { TabFailed } from '../../../tab-failed.tsx'
import { guarded } from '../../../tab-view.ts'

export const dynamic = 'force-dynamic'

/**
 * `/task/<id>/sandbox?attempt=<n>`: what each run of one attempt could reach and what it was refused (#1161). Its
 * loader is its own and **never `loadTask`**; it reads the attempt streams and nothing else, and writes nothing.
 */
export default async function SandboxTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ attempt?: string | string[] }>
}) {
  const { id } = await params
  const { attempt } = await searchParams
  const [read, timings] = await measure(
    () => guarded(() => loadSandboxTab(decodeURIComponent(id), attemptOfQuery(attempt))),
    { label: '/task tab' },
  )
  if (read.status === 'missing') notFound()
  return (
    <>
      <TimingMeta timings={timings} />
      {read.status === 'failed' ? <TabFailed what="the sandbox record" /> : <SandboxTab detail={read.detail} />}
    </>
  )
}
