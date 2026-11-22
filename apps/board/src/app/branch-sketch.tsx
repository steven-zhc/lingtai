import type { OnBranchSketch } from '@/lib/task'

/**
 * `main` above, the personal branch below, and the tickets of the PR (or the draft) that holds this one as dots inside a
 * box (#1323). A server component with no animation; the tests read the labels and titles, never the coordinates.
 */
export function BranchSketch({ sketch }: { sketch: OnBranchSketch }) {
  const x = (i: number) => 150 + i * 70
  const boxRight = Math.max(250, x(sketch.dots.length - 1) + 40)
  const dashed = sketch.box === 'draft'
  return (
    <svg
      className="obs-sketch"
      viewBox="0 0 640 170"
      role="img"
      aria-label={`${sketch.personal} branching from ${sketch.main}${sketch.label === '' ? '' : `; ${sketch.label}`}`}
    >
      <text x="8" y="16" className="prp-svg-t">
        {sketch.main}
      </text>
      <line x1="8" y1="26" x2="632" y2="26" className="prp-line main" />
      <path d="M40 26 C60 26 60 120 90 120" className="prp-line personal" />
      <line x1="90" y1="120" x2="632" y2="120" className="prp-line personal" />
      <text x="8" y="160" className="prp-svg-t">
        {sketch.personal}
      </text>
      {sketch.box === null ? null : (
        <>
          <rect
            x="110"
            y="84"
            width={boxRight - 110}
            height="68"
            rx="10"
            className={dashed ? 'obs-box draft' : 'obs-box'}
            strokeDasharray={dashed ? '5 4' : undefined}
          />
          <text x="120" y="100" className="prp-svg-t">
            {sketch.label}
            {sketch.more === 0 ? '' : ` · + ${sketch.more} more`}
          </text>
          {sketch.dots.map((d, i) => (
            <g key={d.ticket}>
              {d.this ? <circle cx={x(i)} cy="120" r="12" className="obs-ring" /> : null}
              <circle cx={x(i)} cy="120" r={d.this ? 8 : 6} className={d.fix ? 'prp-dot fix' : 'prp-dot'}>
                <title>{`#${d.ticket} ${d.title}${d.fix ? ' · pr-fix' : ''}`}</title>
              </circle>
              {d.this ? (
                <text x={x(i)} y="68" textAnchor="middle" className="prp-svg-t">
                  this ticket
                </text>
              ) : null}
            </g>
          ))}
        </>
      )}
    </svg>
  )
}
