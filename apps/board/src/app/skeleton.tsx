/**
 * The board's one placeholder (0111 §15, #897): what a part of the page that
 * waits for something draws where its answer will go, in the answer's own
 * shape, so that nothing else moves when it arrives.
 *
 * Generic on purpose — it knows nothing of the board's data. The next caller
 * is the task page's GitHub parts (#898), which draw `lines`.
 */

export type SkeletonShape = 'card' | 'lines' | 'cells'

export function Skeleton({
  shape,
  count,
}: {
  /** `card` draws a card's outline; `lines` draws text lines; `cells` draws a row of rail cells. */
  shape: SkeletonShape
  /** How many placeholders. 0 draws an empty container. */
  count: number
}) {
  // The shape is the whole placeholder: no words, for anyone (0111 §15). The
  // container is only marked busy; it has no name and no text node.
  return (
    <div className="skeleton" aria-busy="true">
      {shape === 'cells' ? (
        <div className="sk-cells" aria-hidden="true" style={{ '--steps': Math.max(1, count) } as React.CSSProperties}>
          {Array.from({ length: Math.max(0, count) }, (_, i) => (
            <span key={i} className="sk-bar sk-cell" />
          ))}
        </div>
      ) : null}
      {Array.from({ length: shape === 'cells' ? 0 : Math.max(0, count) }, (_, i) =>
        shape === 'card' ? (
          <div key={i} className="sk-card" aria-hidden="true">
            <span className="sk-bar sk-id" />
            <span className="sk-bar sk-title" />
            <span className="sk-bar sk-rail" />
          </div>
        ) : (
          <span key={i} className="sk-bar sk-line" aria-hidden="true" />
        ),
      )}
    </div>
  )
}
