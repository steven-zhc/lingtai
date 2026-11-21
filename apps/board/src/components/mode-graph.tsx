/**
 * The mode's small graph (#1326): inline SVG, props in and nothing else, so the add step (#1325)
 * draws the same one. Team: `main`, the personal branch, *your PR*. Solo: tickets landing on `main`.
 */
export function ModeGraph({ mode, main, personal }: { mode: 'solo' | 'team'; main: string; personal: string | null }) {
  if (mode === 'solo') {
    return (
      <svg
        className="mode-graph"
        role="img"
        aria-label={`tickets land on ${main}`}
        viewBox="0 0 240 40"
        width="240"
        height="40"
      >
        <text x="4" y="24" fontSize="11" fill="currentColor">
          tickets
        </text>
        <line x1="50" y1="20" x2="150" y2="20" stroke="currentColor" />
        <circle cx="170" cy="20" r="5" fill="currentColor" />
        <text x="180" y="24" fontSize="11" fill="currentColor">
          {main}
        </text>
      </svg>
    )
  }
  return (
    <svg
      className="mode-graph"
      role="img"
      aria-label={`tickets land on ${personal ?? main}, and reach ${main} through your PR`}
      viewBox="0 0 280 70"
      width="280"
      height="70"
    >
      <line x1="10" y1="16" x2="270" y2="16" stroke="currentColor" />
      <circle cx="10" cy="16" r="4" fill="currentColor" />
      <circle cx="270" cy="16" r="4" fill="currentColor" />
      <text x="10" y="10" fontSize="11" fill="currentColor">
        {main}
      </text>
      <path d="M 30 16 L 50 52 L 230 52 L 270 16" fill="none" stroke="currentColor" strokeDasharray="4 3" />
      <text x="60" y="66" fontSize="11" fill="currentColor">
        {personal ?? main}
      </text>
      <text x="200" y="36" fontSize="11" fill="currentColor">
        your PR
      </text>
    </svg>
  )
}
