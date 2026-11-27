import type { ReactNode } from 'react'

/**
 * One cell of a facts row: a name, a figure, an optional sub-line. The running
 * meters (`data-meter`) and the totals strip (`data-cell`) share it.
 */
export function Cell({
  name,
  children,
  sub,
  cell,
}: {
  name: string
  children: ReactNode
  sub?: string | null
  /** Set on the totals strip: the `data-cell` key tests read a cell by. */
  cell?: string
}) {
  return (
    <div className="meter" data-meter={cell === undefined ? name : undefined} data-cell={cell}>
      <dt>{name}</dt>
      <dd>{children}</dd>
      {sub == null || sub === '' ? null : <dd className="sub">{sub}</dd>}
    </div>
  )
}
