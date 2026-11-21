/**
 * The small graph of a mode (0130 §1), drawn static: *solo* lands on one
 * branch; *team* works on a personal branch and takes main in at a submit.
 * One component, shared by the board's add-a-project step (#1325) and `/recipe` (#1326).
 */
export function ModeGraph({ mode }: { mode: 'team' | 'solo' }) {
  return (
    <svg
      className="mode-graph"
      viewBox="0 0 120 44"
      width="120"
      height="44"
      role="img"
      aria-label={mode === 'team' ? 'main, and a personal branch that main is brought into' : 'a single branch'}
    >
      <line x1="8" y1="10" x2="112" y2="10" stroke="currentColor" strokeWidth="2" />
      {[20, 52, 84, 108].map((x) => (
        <circle key={x} cx={x} cy="10" r="3" fill="currentColor" />
      ))}
      {mode === 'team' ? (
        <>
          <path d="M20 10 L32 34 H100 L108 10" fill="none" stroke="currentColor" strokeWidth="2" />
          {[44, 70, 96].map((x) => (
            <circle key={x} cx={x} cy="34" r="3" fill="currentColor" />
          ))}
        </>
      ) : null}
    </svg>
  )
}
