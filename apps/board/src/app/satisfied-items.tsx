import { evidenceSource } from '../lib/task.ts'

/**
 * The per-item reading of a satisfied ticket (#1252): each `## Done when` item,
 * a `met` mark, where the evidence came from, and the evidence itself. One
 * component, drawn twice — on the task page's ending and in the confirm wait —
 * as the agreed mock says. An item with no evidence says so; it is never hidden.
 *
 * Every row is `met`: a `TicketSatisfied` or a `SatisfiedUnconfirmed` exists only
 * when each item cleared.
 */
export function SatisfiedItems({
  items,
  children = [],
  base = null,
}: {
  items: readonly { item: string; evidence: string }[]
  /** The split's child ticket numbers, which a row's source tag may name. */
  children?: readonly number[]
  base?: string | null
}) {
  return (
    <ul className="ssatisfied" aria-label="Done when, item by item">
      {items.map((it, i) => {
        const source = evidenceSource(it.evidence, children, base)
        return (
          <li key={i} data-met="true">
            <span className="ssatisfied-item">{it.item}</span> <span className="ssatisfied-met">met</span>
            {source === null ? null : <span className="ssatisfied-source"> {source}</span>}
            {it.evidence.trim() === '' ? (
              <p className="sevidence snone">no evidence recorded</p>
            ) : (
              <p className="sevidence">{it.evidence}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
