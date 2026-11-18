import { accountDisplayName, limitSentence, runtimeAccounts } from '@lingtai/domain'
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
import { Suspense } from 'react'

import { isPaused, joinNames } from '@/lib/lock-marks.ts'
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
import { LiftButton, PauseButton, ResumeButton } from './pause-button.tsx'
import { sandboxBanner } from './sandbox-banner.tsx'

async function Locks({ project }: { project: string | undefined }) {
  const read = await readProjectLocks()
  return <LockRows locks={read} scope={project} now={new Date()} />
}

/**
 * Not `async`: the sandbox rows' own boundary mounts at once, beside the lock read and not after it, so its
 * skeleton covers the registered-project read both share (#1167).
 */
export function LockBanner({ project }: { project: string | undefined }) {
  return (
    <>
      <Suspense fallback={null}>
        <Locks project={project} />
      </Suspense>
      {sandboxBanner(project)}
    </>
  )
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

function AccountRow({
  row,
  scope,
  now,
}: {
  row: Extract<BannerRow, { kind: 'account' }>
  scope: string | undefined
  now: Date
}) {
  // A lock written with what the runtime said names which limit it is (#1214), and says it once, here (#1216).
  if (row.named != null) {
    const sentence = limitSentence(row.account, row.named, now, { untilFrom: row.untilFrom, said: row.said })
    const then = row.passed
      ? ' · lifts when the conductor next looks'
      : row.named.resetsAt === null
        ? '; raise it, then Lift'
        : ' — nothing starts until then'
    const others = row.others.map((o) => o.project)
    return (
      <div className={row.passed ? 'pbrow passed' : 'pbrow'}>
        <b className="lab">{`${accountDisplayName(row.account)} limit`}</b>
        <span className="what" title={row.title}>
          {sentence}
          {then}
          {!row.passed && others.length > 0 ? (
            <span className="sub">
              {' '}
              · {joinNames(others)} {others.length > 1 ? 'run' : 'runs'} elsewhere and still{' '}
              {others.length > 1 ? 'take' : 'takes'} work
            </span>
          ) : null}
        </span>
        <span className="grow" />
        <LiftButton account={row.account} />
      </div>
    )
  }
  const plural = row.waiting.length > 1
  const waits = `${joinNames(row.waiting)} ${plural ? 'wait' : 'waits'}`
  let tail: string
  if (scope !== undefined) {
    tail =
      row.account === 'github'
        ? `${scope} is on GitHub, so it waits`
        : `${scope}'s recipe uses ${row.account}, so it waits`
  } else if (row.others.length === 0) {
    tail = waits
  } else {
    const names = row.others.map((o) => o.project)
    const runtimes = runtimeAccounts([...new Set(row.others.flatMap((o) => o.accounts))])
    const on = runtimes.length === 0 ? '' : ` on ${joinNames(runtimes)}`
    const many = names.length > 1
    tail = `${waits}; ${joinNames(names)} ${many ? 'run' : 'runs'}${on} and still ${many ? 'take' : 'takes'} work`
  }
  return (
    <div className={row.passed ? 'pbrow passed' : 'pbrow'}>
      <b className="lab">{row.account === 'github' ? 'GitHub rate limit' : `${row.account} limit`}</b>
      <span className="what" title={row.title}>
        until {row.untilLabel}
        {row.passed ? <span className="sub"> — passed · lifts when the conductor next looks</span> : <> · {tail}</>}
      </span>
      <span className="grow" />
      <LiftButton account={row.account} />
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
  const rows = bannerRows(locks, scope, now)
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
          case 'account':
            return <AccountRow key={`account:${row.account}`} row={row} scope={scope} now={now} />
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
