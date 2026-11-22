'use client'

/**
 * The PRs board's buttons (#1319): each calls one server action, is disabled from the click to the answer, and draws a
 * refusal in its sentence where the button was. Imports only the actions and the view types — nothing server-only.
 */
import { useState, useTransition } from 'react'

import type { Button } from '@/lib/pr-board.ts'

import { moreRoundsNow, retryPrNow, submitPrNow } from './actions.ts'

export function PrButtons({ project, n, buttons }: { project: string; n: number | null; buttons: readonly Button[] }) {
  const [pending, startTransition] = useTransition()
  const [refusal, setRefusal] = useState<string | null>(null)
  if (buttons.length === 0) return null
  const run = (go: () => Promise<{ ok: boolean; detail: string }>) => {
    setRefusal(null)
    startTransition(async () => {
      const result = await go()
      if (!result.ok) setRefusal(result.detail)
    })
  }
  return (
    <div className="pr-actions">
      {buttons.map((b) =>
        b.kind === 'link' ? (
          <a key={b.label} className="pr-btn" href={b.href} target="_blank" rel="noreferrer">
            {b.label}
          </a>
        ) : (
          <button
            key={b.label}
            type="button"
            className={b.kind === 'submit' ? 'pr-btn primary' : 'pr-btn'}
            disabled={pending || b.disabled !== undefined}
            title={b.disabled}
            onClick={() =>
              run(() =>
                b.kind === 'submit'
                  ? submitPrNow({ project })
                  : b.kind === 'rounds' && b.grant !== undefined && n !== null
                    ? moreRoundsNow({ project, n, merging: b.grant.merging, commit: b.grant.commit })
                    : retryPrNow({ project, n: n ?? 0 }),
              )
            }
          >
            {b.label}
          </button>
        ),
      )}
      {buttons.some((b) => b.disabled !== undefined) ? (
        <p className="pr-why">{buttons.find((b) => b.disabled !== undefined)?.disabled}</p>
      ) : null}
      {refusal === null ? null : (
        <p className="pr-refusal" role="alert">
          {refusal}
        </p>
      )}
    </div>
  )
}
