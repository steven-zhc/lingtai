/**
 * The row under the bar for each paused project in scope (#994, 0126 §8).
 *
 * Absent when nothing holds the scope. A failed read is a row of its own and
 * never an absence: "nothing is paused" drawn from a read that failed is the
 * silence #77 was about. The old `Paused` chip is a different fact (the whole
 * installation) and is left where it is; when both hold, both show.
 *
 * `LockBanner` reads; `LockRows` is the markup and takes its rows, so a test
 * renders it without a store.
 */
import Link from 'next/link'

import { inScope, readProjectLocks, sinceLabel, type HeldProject, type ProjectLocks } from '@/lib/locks.ts'

import { withProject } from './bar.tsx'
import { PauseButton, ResumeButton } from './pause-button.tsx'

export async function LockBanner({ project }: { project: string | undefined }) {
  const read = await readProjectLocks()
  const locks: ProjectLocks = read.ok ? { ok: true, held: inScope(read.held, project) } : read
  return <LockRows locks={locks} now={new Date()} />
}

/**
 * The bar's `pause` slot for `project`: nothing for *all projects*, nothing
 * when the read failed (the banner's row already says why), otherwise the
 * button in the state the locks give.
 */
export async function pauseSlot(project: string | undefined) {
  if (project === undefined) return undefined
  const read = await readProjectLocks()
  if (!read.ok) return undefined
  return <PauseButton project={project} paused={inScope(read.held, project).length > 0} />
}

export function LockRows({ locks, now }: { locks: ProjectLocks; now: Date }) {
  if (!locks.ok) {
    return (
      <div className="pbanner">
        <div className="pbrow">
          <b className="lab">Paused</b>
          <span className="what">could not read which projects are paused — {locks.problem}</span>
        </div>
      </div>
    )
  }
  if (locks.held.length === 0) return null
  return (
    <div className="pbanner">
      {locks.held.map((row: HeldProject) =>
        row.locks.map((lock) => (
          <div className="pbrow" key={`${row.project}:${lock.kind}`}>
            <b className="lab">Paused</b>
            <span className="what">
              <Link href={withProject('/', row.project)} title={`show only ${row.project}`}>
                {row.project}
              </Link>{' '}
              · <span className="person">by {lock.by}</span> since {sinceLabel(lock.since, now)}
            </span>
            <small className="sub">an attempt in flight finishes</small>
            <ResumeButton project={row.project} />
          </div>
        )),
      )}
    </div>
  )
}
