import type { ReactNode } from 'react'

import type { Books, MedianReceipt, Receipt as RealReceipt } from '@/lib/books'

import { REPO } from './chrome'
import { Receipt } from './receipt'

/**
 * Lingtai's own books on the front page (#814).
 *
 * Server-only: it takes the parsed file and draws it, and imports a type alone
 * from `@/lib/books`. **Nothing here adds two figures together** — the file
 * carries medians, means, shares and per-ticket receipts, and so does the page.
 * A figure the file says is `null` is not rendered, never `0`.
 */

const pct = (x: number) => `${Math.round(x * 100)}%`
// Not `dollars` from ./replay-receipt: that file is 'use client', and a server component gets a reference to it, not the function.
const usd = (x: number) => `$${(Math.round(x * 100) / 100).toFixed(2)}`
const num = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1))

/** `N min` under an hour, `H h M min` from one up. */
function span(min: number): string {
  const m = Math.round(min)
  if (m < 60) return `${m} min`
  const rest = m % 60
  return rest === 0 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 60)} h ${rest} min`
}

/** The big figure: the number, with its unit small beside it. */
function Big({ min }: { min: number }) {
  const m = Math.round(min)
  if (m < 60) {
    return (
      <>
        {m}
        <small>min</small>
      </>
    )
  }
  const rest = m % 60
  return (
    <>
      {Math.floor(m / 60)}
      <small>h</small>
      {rest === 0 ? null : (
        <>
          {' '}
          {rest}
          <small>min</small>
        </>
      )}
    </>
  )
}

const times = (n: number) => (n === 1 ? 'once' : n === 2 ? 'twice' : `${num(n)} times`)

/** Sub-line parts that exist, joined with the separator; a part that is null takes its separator with it. */
const joined = (parts: (string | null | false)[]) => parts.filter((p): p is string => !!p).join(' · ')

const PURPOSES: Record<string, { label: string; rest: string; color: string }> = {
  Work: { label: 'Work', rest: 'writing the code, and the cold review', color: 'var(--accent)' },
  Answering: { label: 'Fixes', rest: 'after failed checks or a refused review', color: 'var(--signal)' },
  Triage: { label: 'Triage', rest: 'telling you why it stopped', color: '#7a8fa0' },
  Judge: { label: 'Judging', rest: '', color: 'var(--pass)' },
  Discussion: { label: 'Discussion', rest: '', color: 'var(--held)' },
}

function Figure({ big, label, sub }: { big: ReactNode; label: string; sub: string }) {
  return (
    <div className="fig">
      <div className="n">{big}</div>
      <div className="l">{label}</div>
      {sub ? <div className="s">{sub}</div> : null}
    </div>
  )
}

function receiptCard(r: MedianReceipt | RealReceipt, landed: number) {
  const cost = r.cost === null ? '—' : usd(r.cost)
  const rows = [
    { key: 'Fix rounds', value: num(r.fixRounds) },
    { key: 'Machine time', value: span(r.machineMinutes) },
    { key: 'Asked you', value: times(r.waits) },
  ]
  if (r.median) {
    return (
      <Receipt
        key="median"
        issue="THE MEDIAN TICKET"
        title={`1 of ${landed} landed`}
        status={{ kind: 'landed', text: '✓ Landed' }}
        rows={rows}
        costLabel="MEDIAN COST"
        cost={cost}
        stamp={{ text: 'TYPICAL', shown: true }}
        footnote={
          <>
            <span className="r-real">● REAL</span> medians, from Lingtai&apos;s log
          </>
        }
      />
    )
  }
  if (r.passes > 1) rows.push({ key: 'Passes', value: num(r.passes) })
  const status =
    r.outcome === 'landed'
      ? ({ kind: 'landed', text: '✓ Landed' } as const)
      : r.outcome === 'closed'
        ? ({ kind: 'closed', text: 'Closed' } as const)
        : ({ kind: 'waiting', text: 'Open' } as const)
  const stamp =
    r.outcome === 'landed'
      ? { text: 'LANDED' as const, shown: true }
      : r.outcome === 'closed'
        ? { text: 'NOT LANDED' as const, shown: true }
        : undefined
  return (
    <Receipt
      key={r.number}
      issue={r.kind ? `ISSUE #${r.number} · ${r.kind.toUpperCase()}` : `ISSUE #${r.number}`}
      title={r.title}
      status={status}
      rows={rows}
      costLabel="COST"
      cost={cost}
      stamp={stamp}
      footnote={
        <>
          <span className="r-real">● REAL</span> from Lingtai&apos;s log
          {r.outcome === 'open' ? ' · still open at the end of the window' : null}
          {' · '}
          <a className="r-open" href={`${REPO}/issues/${r.number}`}>
            Open #{r.number} →
          </a>
        </>
      }
    />
  )
}

export function BooksSection({ books }: { books: Books }) {
  const { window, outcomes, fixRounds, cost, machineMinutes, elapsedMinutes } = books
  const finished = outcomes.landed + outcomes.closed
  const landedShare = finished > 0 ? pct(outcomes.landed / finished) : null
  const spend = (books.spendShare ?? []).filter((s) => Math.round(s.share * 100) > 0)
  const showSpend = books.spendShare !== null && cost.median !== null && spend.length > 0

  return (
    <section className="books" id="books" aria-labelledby="books-title">
      <div className="books-head">
        <div>
          <p className="kicker">The work, in the open</p>
          <h2 id="books-title">Lingtai builds Lingtai. Open its books.</h2>
        </div>
        <p>
          <span className="real-badge">● REAL DATA</span> Every ticket Lingtai finished on its own repository,{' '}
          <code>{window.from}</code> → <code>{window.to}</code>. Nothing left out.
        </p>
      </div>

      {finished > 0 ? (
        <div className="outcome">
          <div className="outcome-head">
            <b>{finished} tickets finished</b>
            <span>each ticket counted once, however many tries it took</span>
          </div>
          <div className="outcome-bar">
            <i className="landed" style={{ width: `${(outcomes.landed / finished) * 100}%` }} />
            <i className="closed" style={{ width: `${(outcomes.closed / finished) * 100}%` }} />
          </div>
          <div className="outcome-key">
            <span>
              <i className="landed" />
              <b>{outcomes.landed} landed</b> · {landedShare}
            </span>
            <span>
              <i className="closed" />
              <b>{outcomes.closed} closed without landing</b> — by a person
            </span>
            <span>
              <i className="open" />
              <b>{outcomes.open} still open</b> at the end of the window
            </span>
          </div>
        </div>
      ) : null}

      <div className="figs">
        {fixRounds.zeroOrOneShare !== null ? (
          <Figure
            big={pct(fixRounds.zeroOrOneShare)}
            label="landed with 0 or 1 fix round"
            sub={joined([
              fixRounds.median !== null && `median ${num(fixRounds.median)}`,
              fixRounds.fiveOrMoreShare !== null && `${pct(fixRounds.fiveOrMoreShare)} needed 5 or more`,
            ])}
          />
        ) : null}
        {cost.median !== null ? (
          <Figure
            big={usd(cost.median)}
            label="median cost per landed ticket"
            sub={joined([
              cost.mean !== null && `mean ${usd(cost.mean)}`,
              cost.p90 !== null && `90% under ${usd(cost.p90)}`,
              cost.includesEstimates && 'includes estimates',
              cost.costUnknown > 0 && `${cost.costUnknown} runs could not be priced`,
            ])}
          />
        ) : null}
        {machineMinutes.median !== null ? (
          <Figure
            big={<Big min={machineMinutes.median} />}
            label="median machine time"
            sub={joined([
              machineMinutes.mean !== null && `mean ${span(machineMinutes.mean)}`,
              'while agents and checks were running, not while waiting for you',
            ])}
          />
        ) : null}
        {elapsedMinutes.median !== null ? (
          <Figure
            big={<Big min={elapsedMinutes.median} />}
            label="median from start to landed"
            sub={joined([
              elapsedMinutes.mean !== null && `mean ${span(elapsedMinutes.mean)}`,
              elapsedMinutes.withinHourShare !== null && `${pct(elapsedMinutes.withinHourShare)} within an hour`,
              books.waitedShare !== null && `${pct(books.waitedShare)} waited for a person`,
            ])}
          />
        ) : null}
      </div>

      {showSpend && cost.median !== null ? (
        <div className="money">
          <div className="money-head">
            <b>What the {usd(cost.median)} pays for</b>
            <span>the AI model calls made for the ticket &mdash; not your CI, your machine or your time</span>
          </div>
          <div className="outcome-bar">
            {spend.map((s) => (
              <i
                key={s.purpose}
                style={{
                  width: `${s.share * 100}%`,
                  background: (PURPOSES[s.purpose] ?? { color: 'var(--muted)' }).color,
                }}
              />
            ))}
          </div>
          <div className="outcome-key">
            {spend.map((s) => {
              const p = PURPOSES[s.purpose] ?? { label: s.purpose, rest: '', color: 'var(--muted)' }
              return (
                <span key={s.purpose}>
                  <i style={{ background: p.color }} />
                  <b>{p.label}</b> {pct(s.share)}
                  {p.rest ? ` — ${p.rest}` : ''}
                </span>
              )
            })}
          </div>
        </div>
      ) : null}

      {books.receipts.length > 0 ? (
        <div className="real-grid">{books.receipts.map((r) => receiptCard(r, outcomes.landed))}</div>
      ) : null}

      <p className="books-repro">
        Reproduce it:{' '}
        <code>
          lingtai report --from {window.from} --to {window.to} --project lingtai
        </code>
        . No totals are published.
      </p>
    </section>
  )
}
