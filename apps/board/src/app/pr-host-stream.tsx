/**
 * The one thing a PR's page asks the code host (#1320, 0130 §5): *is this PR still open there?* — streamed in after
 * everything the log answers, as the Queued column's GitHub half is (#884). One request per render, and a failed one is
 * said in place and never read as *closed*. **Nothing is appended from here**: #1317's sweep records a merge.
 */
import { type PrState } from '@lingtai/domain'

import { hostLine } from '@/lib/pr-page.ts'
import { readHostPull } from '@/lib/prs.ts'

import { Skeleton } from './skeleton'

export function HostFallback() {
  return <Skeleton shape="lines" count={1} />
}

export async function PrHostLine({
  project,
  number,
  status,
}: {
  project: string
  number: number
  status: PrState['status']
}) {
  const line = hostLine({ status }, await readHostPull(project, number))
  return (
    <span className={line.failed ? 'prp-host failed' : 'prp-host'} role={line.failed ? 'alert' : undefined}>
      {line.text}
    </span>
  )
}
