/**
 * The board's one placeholder (0111 §15, #897): what a part of the page that
 * waits for something draws where its answer will go, in the answer's own
 * shape, so that nothing else moves when it arrives.
 *
 * Generic on purpose — it knows nothing of the board's data. The next caller
 * is the task page's GitHub parts (#898), which draw `lines`.
 */

export type SkeletonShape = 'card' | 'lines'

export function Skeleton({
  shape,
  count,
  label,
}: {
  /** `card` draws a card's outline; `lines` draws text lines. */
  shape: SkeletonShape
  /** How many placeholders. 0 draws the label alone. */
  count: number
  /** Said to a reader of the text, once; the outlines are hidden from them. */
  label: string
}) {
  return (
    <div className="skeleton">
      <p className="empty asking">{label}</p>
      {Array.from({ length: Math.max(0, count) }, (_, i) =>
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
