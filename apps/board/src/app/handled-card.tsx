import Link from 'next/link'

import type { HandledToday } from '@/lib/handled-today'

const STRIP = 40

/** The empty Waiting column's card (#1286, `doc/design/handled-for-you.html`, second tab). */
export function HandledCard({
  today,
  todayHref,
  weekHref,
}: {
  today: HandledToday
  todayHref: string
  weekHref: string
}) {
  const total = today.solved + today.needed
  const shown = Math.min(total, STRIP)
  const solvedTicks = total === 0 ? 0 : Math.round((today.solved / total) * shown)
  return (
    <div className="handled">
      <div className="handled-h">
        <span className="handled-t">Nothing needs you</span>
        <span className="handled-w">today · since 00:00</span>
      </div>
      <div className="handled-n">
        <span className="handled-big">{today.solved}</span>
        <span className="handled-lbl">problems solved without you</span>
      </div>
      <div className="handled-strip" aria-hidden="true">
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className={i < solvedTicks ? 'tk on' : 'tk'} />
        ))}
      </div>
      <ul className="handled-kinds">
        {today.kinds.map((k) => (
          <li key={k.kind}>
            <span>{k.kind}</span>
            <span className="n">{k.count}</span>
          </li>
        ))}
      </ul>
      {today.more === null ? null : (
        <Link className="handled-more" href={`${todayHref}#handled`}>
          + {today.more.kinds} more {today.more.kinds === 1 ? 'kind' : 'kinds'} · {today.more.problems}{' '}
          {today.more.problems === 1 ? 'problem' : 'problems'} →
        </Link>
      )}
      <div className="handled-f">
        <span>
          {today.percent}% without you · {today.needed} needed you
        </span>
        <Link href={`${weekHref}#handled`}>this week →</Link>
      </div>
    </div>
  )
}
