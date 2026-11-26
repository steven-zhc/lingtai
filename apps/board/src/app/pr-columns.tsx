/**
 * The PRs board's columns (#1319): `prBoard`'s view, drawn. Pure markup over the view — no read, no action import but
 * through `PrButtons` — so a unit test renders it. Each card is a branch: a header in the state's colour, its tickets
 * as slips on a rail, never more than three and then `+ N more`.
 */
import Link from 'next/link'

import { type CardView, type ColumnView, type FailedCard, PR_COLUMNS, type PrBoardView } from '@/lib/pr-board.ts'

import { PrButtons } from './pr-buttons.tsx'
import { Skeleton } from './skeleton.tsx'

const BranchMark = () => (
  <svg className="pr-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="4" cy="3" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="4" cy="13" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <circle cx="12" cy="6" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4 5v6M12 8c0 2-4 2-8 3" fill="none" stroke="currentColor" strokeWidth="1.5" />
  </svg>
)

export function PrCard({ project, card }: { project: string; card: CardView }) {
  return (
    <article className={`pr-card ${card.tone === 'queued' ? 'progress queued' : card.tone}`}>
      <header className="pr-head">
        <BranchMark />
        {card.href === null ? (
          <span className="pr-name">{card.name}</span>
        ) : (
          <Link className="pr-name" href={card.href}>
            {card.name}
          </Link>
        )}
        {card.pill === null ? null : (
          <span className={card.pill === 'in progress' ? 'pr-pill pulse' : 'pr-pill'}>{card.pill}</span>
        )}
        {card.count === null ? null : <span className="pr-count">{card.count}</span>}
      </header>
      <div className="pr-body">
        {card.sub.map((s) => (
          <p key={s} className="pr-sub">
            {s}
          </p>
        ))}
        {card.chips.length === 0 ? null : (
          <div className="pr-chips">
            {card.chips.map((c) => (
              <span key={c.step} className={`pr-chip ${c.status}`}>
                {c.text}
              </span>
            ))}
          </div>
        )}
        {card.slips.length === 0 ? null : (
          <ol className={card.more > 0 ? 'pr-rail cut' : 'pr-rail'}>
            {card.slips.map((s) => (
              <li key={`${s.fix ? 'fix' : 't'}${s.ticket}`} className="pr-slip">
                <span className="pr-dot" aria-hidden="true" />
                <span className="pr-slip-id">#{s.ticket}</span> <span className="pr-slip-title">{s.title}</span>
                {s.fix ? <span className="pr-fix"> pr-fix</span> : null}
              </li>
            ))}
            {card.more === 0 ? null : (
              <li className="pr-slip more">
                {card.href === null ? `+ ${card.more} more` : <Link href={card.href}>{`+ ${card.more} more`}</Link>}
              </li>
            )}
          </ol>
        )}
        {card.meta.map((m) => (
          <p key={m} className="pr-meta">
            {m}
          </p>
        ))}
        {card.byHand.length === 0 ? null : (
          <details className="pr-hand" open>
            <summary>or resolve it by hand</summary>
            <pre>{card.byHand.join('\n')}</pre>
          </details>
        )}
        <PrButtons project={project} n={card.n} buttons={card.buttons} small />
      </div>
    </article>
  )
}

const Failed = ({ card }: { card: FailedCard }) => (
  <p className="pr-card failed" role="alert">
    {card.text}
  </p>
)

function Column({ project, column }: { project: string; column: ColumnView }) {
  return (
    <section className={`pr-col ${column.tone}`} aria-label={column.title}>
      <h2 className={`sec-h${column.tone === 'waiting' ? ' wait' : ''}`}>
        {column.title}{' '}
        <span className="pr-n">
          {column.count}
          {column.unread === true ? '+' : ''}
        </span>
      </h2>
      {column.cards.length === 0 ? <p className="pr-empty">{column.empty}</p> : null}
      {column.cards.map((c) =>
        c.failed ? <Failed key={c.key} card={c} /> : <PrCard key={c.key} project={project} card={c} />,
      )}
      {column.note === null ? null : <p className="pr-note">{column.note}</p>}
    </section>
  )
}

export function PrColumns({ project, view }: { project: string; view: PrBoardView }) {
  return (
    <div className="pr-board">
      {view.submitted === null ? null : (
        <p className="pr-submitted" role="status">
          ✓ PR {view.submitted.n} submitted{view.submitted.at === null ? '' : ` at ${view.submitted.at}`}
          {view.submitted.daemon === 'running' ? ' — it starts when the daemon next looks for work. ' : '. '}
          <Link href={view.submitted.href}>Open PR {view.submitted.n}</Link>
        </p>
      )}
      <p className="pr-strip">
        <b>{view.strip.branches}</b> · {view.strip.notInPr} · {view.strip.mainNote}
      </p>
      <div className="pr-cols">
        {view.columns.map((c) => (
          <Column key={c.id} project={project} column={c} />
        ))}
      </div>
    </div>
  )
}

/**
 * What `/p/<project>/pr` draws while it loads (#1319, #1419): the board's own frame — the strip and the five columns
 * with their titles — and a card-shaped skeleton in each, so the real cards arrive in place. The titles come from
 * `PR_COLUMNS`, never written here; the counts and the strip are bars, and there are no other words (0111 §15).
 */
export function PrBoardSkeleton() {
  return (
    <div className="pr-board">
      <p className="pr-strip">
        <span className="sk-bar sk-line sk-strip" aria-hidden="true" />
      </p>
      <div className="pr-cols">
        {PR_COLUMNS.map((c) => (
          <section key={c.id} className={`pr-col ${c.tone}`} aria-label={c.title}>
            <h2 className={`sec-h${c.tone === 'waiting' ? ' wait' : ''}`}>
              {c.title}{' '}
              <span className="pr-n">
                <span className="sk-bar sk-n" aria-hidden="true" />
              </span>
            </h2>
            <Skeleton shape="card" count={1} />
          </section>
        ))}
      </div>
    </div>
  )
}
