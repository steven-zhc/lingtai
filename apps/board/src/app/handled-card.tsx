import Link from 'next/link'

import { kindCopy } from '@/lib/handled-copy'
import type { HandledToday } from '@/lib/handled-today'

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
  const marks = today.marks.reduce((n, m) => n + m.count, 0)
  return (
    <div className="handled">
      <div className="handled-k">
        <span className="l">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <circle cx="7" cy="7" r="6.25" fill="var(--pass-soft)" stroke="var(--pass)" strokeWidth="1.5" />
            <path
              d="M4 7.2l2 2 4-4.4"
              fill="none"
              stroke="var(--pass)"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Nothing needs you
        </span>
        <span className="when" title="counted from midnight, your time zone">
          today · since 00:00
        </span>
      </div>
      <div className="handled-n">
        <b>{today.solved}</b>
        <span>
          problems solved
          <br />
          without you
        </span>
      </div>
      <p className="handled-sub">each would have stopped the work until you stepped in</p>
      <div
        className="handled-ticks"
        style={{ gridTemplateColumns: `repeat(${marks}, 1fr)` }}
        title="one mark per problem today · hollow ones needed you"
      >
        {today.marks.flatMap((m, g) =>
          Array.from({ length: m.count }, (_, i) => (
            <i
              key={`${g}:${i}`}
              className={m.you ? 'you' : undefined}
              style={m.you ? undefined : { background: kindCopy(m.kind).colour }}
            />
          )),
        )}
      </div>
      <ul className="handled-leg">
        {today.kinds.map((k) => {
          const c = kindCopy(k.kind)
          return (
            <li key={k.kind} title={c.hint}>
              <i style={{ background: c.colour }} />
              <span>
                <span className="w">{c.problem}</span>
                <span className="ar">→</span>
                <span className="d">{c.action}</span>
              </span>
              <b>{k.count}</b>
            </li>
          )
        })}
        {today.more === null ? null : (
          <li className="more" title={today.more.hint}>
            <i />
            <Link href={`${todayHref}#handled`}>
              + {today.more.kinds} more {today.more.kinds === 1 ? 'kind' : 'kinds'} · {today.more.problems}{' '}
              {today.more.problems === 1 ? 'problem' : 'problems'} →
            </Link>
          </li>
        )}
      </ul>
      <div className="handled-f">
        <span>
          <b>{today.percent}%</b> without you · {today.needed} needed you
        </span>
        <Link href={`${weekHref}#handled`}>this week →</Link>
      </div>
    </div>
  )
}
