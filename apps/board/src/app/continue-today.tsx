'use client'

/**
 * *continue today to $[x]* on the ceiling's banner row (#1006, 0126 §7).
 *
 * The figure is the person's: prefilled with a suggestion, editable, and never
 * applied silently. Anything that is not a positive number disables the button
 * and sends nothing; the server's refusals are shown beside it word for word.
 */
import { useState, useTransition } from 'react'

import { continueToday } from './actions.ts'

export function ContinueToday({ suggested }: { suggested: number }) {
  const [value, setValue] = useState(String(suggested))
  const [pending, startTransition] = useTransition()
  const [refusal, setRefusal] = useState<string | null>(null)
  const toUsd = value.trim() === '' ? Number.NaN : Number(value)
  const valid = Number.isFinite(toUsd) && toUsd > 0
  return (
    <>
      <label>
        continue today to ${' '}
        <input
          type="number"
          inputMode="decimal"
          min={1}
          step={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="raise today's ceiling to (dollars)"
        />
      </label>
      <button
        type="button"
        disabled={pending || !valid}
        onClick={() => {
          if (!valid) return
          setRefusal(null)
          startTransition(async () => {
            const result = await continueToday({ toUsd })
            if (!result.ok) setRefusal(result.detail)
          })
        }}
      >
        {pending ? 'continuing…' : 'continue'}
      </button>
      {refusal ? <span className="refusal">{refusal}</span> : null}
    </>
  )
}
