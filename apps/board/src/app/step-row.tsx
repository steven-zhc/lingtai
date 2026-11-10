import type { ReactNode } from 'react'

/**
 * One of the ten steps, drawn: its number, its name, what it is for, and the
 * children — what this recipe sets there (#983). `on` is false for a step with
 * nothing declared, which is greyed and still drawn.
 */
export function StepRow({
  n,
  step,
  says,
  on,
  children,
}: {
  n: number
  step: string
  says: string
  on: boolean
  children?: ReactNode
}) {
  return (
    <li className={on ? 'step-row on' : 'step-row'}>
      <span className="step-n">{n}</span>
      <div>
        <div className="step-h">
          <b>{step}</b>
          <span>{says}</span>
        </div>
        {on ? children : <div className="step-empty">nothing declared</div>}
      </div>
    </li>
  )
}
