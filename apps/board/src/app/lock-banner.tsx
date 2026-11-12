/**
 * The rows under the bar: the day's ceiling, then each paused project in scope
 * (#994, #1006, 0126 §8).
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

import { isPaused } from '@/lib/lock-marks.ts'
import {
  bannerRows,
  inScope,
  readProjectLocks,
  sinceLabel,
  suggestedRaise,
  type BannerRow,
  type ProjectLocks,
} from '@/lib/locks.ts'

import { withProject } from './bar.tsx'
import { ContinueToday } from './continue-today.tsx'
import { PauseButton, ResumeButton } from './pause-button.tsx'

export async function LockBanner({ project }: { project: string | undefined }) {
  const read = await readProjectLocks()
  return <LockRows locks={read} scope={project} now={new Date()} />
}

/**
 * The bar's `pause` slot for `project`: nothing for *all projects*, nothing
 * when the read failed (the banner's row already says why), otherwise the
 * button in the state the project's own pause gives. The ceiling is in every
 * project's locks and is not this button's to resume.
 */
export async function pauseSlot(project: string | undefined) {
  if (project === undefined) return undefined
  const read = await readProjectLocks()
  if (!read.ok) return undefined
  return <PauseButton project={project} paused={isPaused(inScope(read.held, project)[0]?.locks)} />
}

const usd = (n: number): string => `$${n.toFixed(2)}`
const whole = (n: number): string => (Number.isInteger(n) ? `$${n}` : usd(n))

function CeilingRow({ facts, now }: { facts: Extract<BannerRow, { kind: 'ceiling' }>['facts']; now: Date }) {
  if (facts.passed) {
    return (
      <div className="pbrow passed">
        <b className="lab">Spend ceiling</b>
        <span className="what">
          reached on {facts.day}
          <span className="sub"> · passed, lifts when the conductor next looks</span>
        </span>
      </div>
    )
  }
  const title = `${usd(facts.reportedUsd)} reported + ~${usd(facts.estimatedUsd)} estimated at ${sinceLabel(facts.since, now)}`
  return (
    <div className="pbrow">
      <b className="lab">Spend ceiling</b>
      <span className="what" title={title}>
        today's spend reached {whole(facts.ceilingUsd)}
        <span className="sub"> · nothing starts until midnight</span>
      </span>
      <span className="grow" />
      <ContinueToday suggested={suggestedRaise(facts.ceilingUsd, facts.reportedUsd + facts.estimatedUsd)} />
    </div>
  )
}

export function LockRows({ locks, scope, now }: { locks: ProjectLocks; scope?: string | undefined; now: Date }) {
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
  const rows = bannerRows(locks, scope)
  if (rows.length === 0) return null
  return (
    <div className="pbanner">
      {rows.map((row) => {
        switch (row.kind) {
          case 'ceiling':
            return <CeilingRow key="ceiling" facts={row.facts} now={now} />
          case 'control-unread':
            return (
              <div className="pbrow" key="control-unread">
                <b className="lab">Spend ceiling</b>
                <span className="what">could not read whether today's ceiling holds — {row.problem}</span>
              </div>
            )
          case 'paused':
            return (
              <div className="pbrow" key={`paused:${row.project}`}>
                <b className="lab">Paused</b>
                <span className="what">
                  <Link href={withProject('/', row.project)} title={`show only ${row.project}`}>
                    {row.project}
                  </Link>{' '}
                  · <span className="person">by {row.by}</span> since {sinceLabel(row.since, now)}
                </span>
                <small className="sub">an attempt in flight finishes</small>
                <span className="grow" />
                <ResumeButton project={row.project} />
              </div>
            )
        }
      })}
    </div>
  )
}
