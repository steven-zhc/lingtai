/**
 * `/landed`'s body, drawn from what `lib/landed.ts` loaded (#895, 0123 §8). It
 * takes the data as props so a test renders a page from fixture rows and
 * `page.tsx` only loads.
 *
 * A ticket with a summary is a card and one without is a line. The summary is
 * rendered by the board's one renderer (`DocumentBody`, source `summary`) and
 * this file writes none; the ticket's own title is shown as it is. Colour is the
 * kind's series (`kindColourOf`), never amber — amber means a person is waited
 * on, and a past decision is written in ink.
 */
import { type Money, ticketMoney } from '@lingtai/conductor/report'
import type { BacklogEntry, TicketReportRow } from '@lingtai/projector'
import type { TicketSource } from '@lingtai/recipe/settings'
import type { CSSProperties } from 'react'

import { DocumentBody } from '@/app/markdown.tsx'
import { issueUrl } from '@/lib/board.ts'
import {
  commitUrl,
  costText,
  diffOf,
  diffSquares,
  groupDays,
  kindColourOf,
  landedHref,
  type LandedData,
  type LandedQuery,
  ticketRef,
  addTotals,
  sumText,
  totalsOf,
  type LandedTotals,
  type LandedDay,
} from '@/lib/landed.ts'
import { leadOf } from '@/lib/markdown.ts'
import { moveTitle } from '@/lib/resolution-copy.ts'

import { Earlier } from './earlier.tsx'

export interface LandedEnv {
  kinds: readonly string[]
  owners: ReadonlyMap<string, string | null>
  sources: ReadonlyMap<string, TicketSource>
}

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const pad = (n: number) => String(n).padStart(2, '0')
const minuteOf = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`

function Squares({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <span className="ld-sq" aria-hidden="true">
      {diffSquares(insertions, deletions).map((s, i) => (
        <i key={i} className={s} />
      ))}
    </span>
  )
}

function Facts({ row, env, money }: { row: TicketReportRow; env: LandedEnv; money: Money }) {
  const ref = ticketRef(row)
  const diff = diffOf(row)
  const owner = ref === null ? null : (env.owners.get(ref.project) ?? null)
  const source = ref === null ? null : (env.sources.get(ref.project) ?? null)
  const issue = ref === null ? null : issueUrl(owner, ref.project, ref.issue, source)
  const commit =
    ref === null || row.mergeCommit === null ? null : commitUrl(owner, ref.project, row.mergeCommit, source)
  return (
    <p className="ld-facts mono">
      {row.kind === null ? null : <span>{row.kind}</span>}
      {row.landingAttempt === null ? null : (
        <span>
          Attempt {row.landingAttempt}
          {row.landingFixRounds === null || row.landingFixRounds === 0
            ? ''
            : ` · ${row.landingFixRounds} fix round${row.landingFixRounds === 1 ? '' : 's'}`}
        </span>
      )}
      {diff === null ? null : (
        <span>
          <Squares insertions={diff.insertions} deletions={diff.deletions} /> {diff.files} file
          {diff.files === 1 ? '' : 's'} <b className="add">+{diff.insertions}</b>{' '}
          <b className="del">−{diff.deletions}</b>
        </span>
      )}
      <span>{costText(money)}</span>
      <span className="ld-links">
        {row.mergeCommit === null ? null : commit === null ? (
          <span>{row.mergeCommit.slice(0, 7)}</span>
        ) : (
          <a href={commit}>{row.mergeCommit.slice(0, 7)}</a>
        )}
        {ref === null ? null : issue === null ? <span>#{ref.issue}</span> : <a href={issue}>#{ref.issue}</a>}
      </span>
    </p>
  )
}

function Notes({ row, entries }: { row: TicketReportRow; entries: readonly BacklogEntry[] }) {
  const decisions = row.waits.filter((w) => w.resolution !== null)
  if (decisions.length === 0 && entries.length === 0 && row.summaryClipped === null) return null
  return (
    <div className="ld-notes">
      {decisions.map((w) => (
        <p key={w.waitId} className="ld-decision">
          A person decided: {moveTitle(w.resolution!)}
        </p>
      ))}
      {entries.length === 0 ? null : (
        <details>
          <summary>
            {entries.length} minor finding{entries.length === 1 ? '' : 's'} sent to the backlog
          </summary>
          <ul>
            {entries.map((e) => (
              <li key={e.key}>{e.claim}</li>
            ))}
          </ul>
        </details>
      )}
      {row.summaryClipped === null ? null : (
        <p>
          the reviewer read the first {row.summaryClipped.read} of {row.summaryClipped.of}
        </p>
      )}
    </div>
  )
}

function Card({
  row,
  env,
  entries,
  colour,
}: {
  row: TicketReportRow
  env: LandedEnv
  entries: readonly BacklogEntry[]
  colour: string
}) {
  const { lead, rest } = leadOf(row.summary!)
  const ref = ticketRef(row)
  return (
    <article className="ld-card" style={{ '--kind': colour } as CSSProperties}>
      {ref === null ? null : (
        <span className="ld-mark" aria-hidden="true">
          {ref.issue}
        </span>
      )}
      <p className="ld-caption mono">{row.title ?? row.ticket}</p>
      <div className="ld-head">
        <DocumentBody source="summary" text={lead} rawClass="" />
      </div>
      {rest === '' ? null : (
        <div className="ld-rest">
          <DocumentBody source="summary" text={rest} rawClass="" />
        </div>
      )}
      <Notes row={row} entries={entries} />
      <Facts row={row} env={env} money={moneyOf(row)} />
    </article>
  )
}

const moneyOf = (row: TicketReportRow): Money => ticketMoney(row)

function Line({ row }: { row: TicketReportRow }) {
  const ref = ticketRef(row)
  const diff = diffOf(row)
  return (
    <p className="ld-line">
      {ref === null ? null : <span className="mono">#{ref.issue}</span>}
      <span className="ld-title">{row.title ?? row.ticket}</span>
      {diff === null ? null : <Squares insertions={diff.insertions} deletions={diff.deletions} />}
      <span className="mono">{costText(moneyOf(row))}</span>
    </p>
  )
}

function DateColumn({ day, colour }: { day: LandedDay; colour: (kind: string | null) => string }) {
  return (
    <div className="ld-date">
      <span className="wd mono">{WEEKDAYS[day.date.getDay()]}</span>
      <span className="dn">{day.date.getDate()}</span>
      <span className="my">
        {MONTHS[day.date.getMonth()]} {day.date.getFullYear()}
      </span>
      <span className="ct mono">{day.rows.length} landed</span>
      <span className="ct mono">{costText(day.money)}</span>
      <span className="mix" aria-hidden="true">
        {day.kinds.map((k) => (
          <i key={k.kind ?? ''} style={{ flex: k.count, background: colour(k.kind) }} />
        ))}
      </span>
    </div>
  )
}

export function KindFilter({ query, kinds }: { query: LandedQuery; kinds: readonly string[] }) {
  const colour = kindColourOf(kinds)
  return (
    <nav className="ld-filter" aria-label="kind">
      <a href={landedHref({ project: query.project })} aria-current={query.kind === null ? 'true' : undefined}>
        all
      </a>
      {kinds.map((k) => (
        <a
          key={k}
          href={landedHref({ project: query.project, kind: k })}
          aria-current={query.kind === k ? 'true' : undefined}
        >
          <i style={{ background: colour(k) }} />
          {k}
        </a>
      ))}
    </nav>
  )
}

export function LandedView({
  data,
  query,
  env,
  carry = null,
}: {
  data: LandedData
  query: LandedQuery
  env: LandedEnv
  /** The pages already on a reader's screen, when this one is fetched to append to them. */
  carry?: LandedTotals | null
}) {
  const colour = kindColourOf(env.kinds)
  const days = groupDays(data.rows)
  const totals = carry === null ? totalsOf(data.rows) : addTotals(carry, totalsOf(data.rows))
  const empty =
    query.project !== null
      ? `nothing landed for ${query.project}`
      : query.kind !== null
        ? `nothing landed for ${query.kind}`
        : 'nothing has landed yet'
  return (
    <>
      <header className="ld-header">
        <div>
          <h1>landed</h1>
          <p>what Lingtai changed, newest first</p>
        </div>
        <dl className="ld-totals" data-landed-sum={sumText(totals)}>
          <div>
            <dt>landed</dt>
            <dd>{totals.landed}</dd>
          </div>
          <div>
            <dt>spent</dt>
            <dd>{costText(totals.money)}</dd>
          </div>
          <div>
            <dt>changed</dt>
            <dd>
              <b className="add">+{totals.insertions}</b> <b className="del">−{totals.deletions}</b>
            </dd>
          </div>
        </dl>
      </header>
      <KindFilter query={query} kinds={env.kinds} />
      <div data-landed-page="">
        {data.backlogError === null ? null : (
          <p className="rp-note">the backlog could not be read, so findings are not shown: {data.backlogError}</p>
        )}
        {days.length === 0 ? (
          <p className="rp-empty">{empty}</p>
        ) : (
          days.map((day) => (
            <section key={day.key} className="ld-day">
              <DateColumn day={day} colour={colour} />
              <ol className="ld-rail">
                {day.rows.map((row) => (
                  <li key={row.ticket} className={row.summary === null ? 'ld-has-line' : 'ld-has-card'}>
                    <time className="mono" dateTime={row.outcomeAt!.toISOString()}>
                      {minuteOf(row.outcomeAt!)}
                    </time>
                    {row.summary === null ? (
                      <Line row={row} />
                    ) : (
                      <Card
                        row={row}
                        env={env}
                        entries={data.backlog.get(row.ticket) ?? []}
                        colour={colour(row.kind)}
                      />
                    )}
                  </li>
                ))}
              </ol>
            </section>
          ))
        )}
        {data.next === null ? null : (
          <nav className="ld-more" data-landed-more="">
            <Earlier href={landedHref({ project: query.project, kind: query.kind, before: data.next })} />
          </nav>
        )}
      </div>
    </>
  )
}
