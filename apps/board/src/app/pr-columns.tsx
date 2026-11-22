/**
 * The PRs board's columns (#1319): `prBoard`'s view, drawn. Pure markup over the view — no read, no action import but
 * through `PrButtons` — so a unit test renders it. Each card is a branch: a header in the state's colour, its tickets
 * as slips on a rail, never more than three and then `+ N more`.
 */
import Link from 'next/link'

import type { CardView, ColumnView, FailedCard, PrBoardView } from '@/lib/pr-board.ts'

import { PrButtons } from './pr-buttons.tsx'

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
    <article className={`pr-card ${card.tone}`}>
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
          <span className={card.pill === 'CI' ? 'pr-pill pulse' : 'pr-pill'}>{card.pill}</span>
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
        <PrButtons project={project} n={card.n} buttons={card.buttons} />
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
      <h2>
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
      {column.older.length === 0 ? null : (
        <details className="older">
          <summary>▸ {column.older.length} older</summary>
          {column.older.map((c) => (
            <PrCard key={c.key} project={project} card={c} />
          ))}
        </details>
      )}
      {column.note === null ? null : <p className="pr-note">{column.note}</p>}
    </section>
  )
}

export function PrColumns({ project, view }: { project: string; view: PrBoardView }) {
  return (
    <div className="pr-board">
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
