import type { BacklogEntry } from '@lingtai/projector'
/**
 * The backlog: minor findings passing gates raised, and what was decided
 * about each ([0038](../../../../../doc/decisions-archive/0038-a-finding-buys-an-agent-before-it-buys-your-attention.md)
 * §5, `#137`).
 *
 * A read of `finding_backlog`, which is a reducer like `task_view` — nothing on
 * this page writes to it but the reducer. The two buttons append, through the same
 * functions `lingtai backlog` calls, and the next reduce closes the entry.
 *
 * **Read as it stands, and said so.** The page reduces nothing: a daemon older
 * than this projection follows `task_view` alone, so each render reads the table
 * and its lag (`@/lib/backlog`), and the chip says how far behind it is. It
 * catches up when something next appends with a projector, or on `lingtai
 * projection rebuild finding_backlog`. *Nothing open* is printed only at lag 0.
 */
import Link from 'next/link'

import { Bar } from '@/app/bar.tsx'
import { LockBanner } from '@/app/lock-banner.tsx'
import { backlogChip, currentBacklog } from '@/lib/backlog'

import { FooterFetched } from '../footer-fetched'
import { sandboxSlot } from '../sandbox-slot.tsx'
import { DecideFinding, OpenAccepted } from './decide-finding.tsx'

export const dynamic = 'force-dynamic'

function Entry({ entry }: { entry: BacklogEntry }) {
  const where = entry.line === null ? entry.file : `${entry.file}:${entry.line}`
  return (
    <li>
      <p>
        <span className="mono">{where}</span> — {entry.claim}
      </p>
      <p className="why">fails when: {entry.failureScenario}</p>
      <p className="why">
        <Link href={`/task/${encodeURIComponent(entry.taskId)}`}>#{entry.issue}</Link> · {entry.step}:{entry.action} ·{' '}
        <span className="mono">{entry.runId}</span> · seq {entry.raisedSeq} · <span className="mono">{entry.key}</span>
      </p>
      {entry.status === 'open' ? (
        <DecideFinding project={entry.project} entryKey={entry.key} />
      ) : entry.status === 'accepted' && entry.proposedRef === null ? (
        <p className="why">
          accepted as {entry.kind} by {entry.decidedBy}, and no issue is recorded yet —{' '}
          <OpenAccepted project={entry.project} entryKey={entry.key} />
        </p>
      ) : entry.status === 'accepted' ? (
        <p className="why">
          accepted by {entry.decidedBy} →{' '}
          {entry.proposedUrl ? (
            <a href={entry.proposedUrl} target="_blank" rel="noreferrer">
              #{entry.proposedRef}
            </a>
          ) : (
            entry.proposedRef
          )}
        </p>
      ) : (
        <p className="why">
          declined by {entry.decidedBy}: {entry.reason}
        </p>
      )}
    </li>
  )
}

export default async function BacklogPage() {
  const { entries, currency } = await currentBacklog()
  const chip = backlogChip(currency)
  // An accepted entry whose issue is not recorded still owes something, so it
  // is listed with the open ones.
  const owed = (e: BacklogEntry) => e.status === 'open' || (e.status === 'accepted' && e.proposedRef === null)
  const open = entries.filter(owed)
  const decided = entries.filter((e) => !owed(e))

  return (
    <>
      <main className="detail">
        <Bar sandbox={sandboxSlot(undefined)} project={undefined}>
          <span className="sep" />
          <span>backlog</span>
          <span className="sep" />
          <span className="chip idle">{open.length} open</span>
          <span className="sep" />
          <span className={`chip ${chip.tone}`} title={chip.title}>
            {chip.label}
          </span>
        </Bar>
        <LockBanner project={undefined} />
        <div className="detail-body">
          <section>
            <h2>Open</h2>
            {open.length === 0 ? (
              <p className="why">
                {chip.current ? 'nothing open' : `nothing open that this page could read — ${chip.title}`}
              </p>
            ) : (
              <ul>
                {open.map((e) => (
                  <Entry key={`${e.project}:${e.key}`} entry={e} />
                ))}
              </ul>
            )}
          </section>
          <section>
            <h2>Decided</h2>
            {decided.length === 0 ? (
              <p className="why">nothing decided yet</p>
            ) : (
              <ul>
                {decided.map((e) => (
                  <Entry key={`${e.project}:${e.key}`} entry={e} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>
      <FooterFetched />
    </>
  )
}
