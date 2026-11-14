'use client'

/**
 * What the board says while a setup pause recorded before 0.14 still stands:
 * every project stops until somebody resumes (`lingtai resume`). Nothing
 * appends a new one. Every other stop is a project's lock, shown by the banner
 * (#994).
 *
 * The health dot next door answers *is what I am looking at current?* and it was
 * answering correctly for four days while nothing moved (`#77`): the
 * projection was at the head, the stream was open, and the one fact that
 * decided whether anything would ever happen — a `ConductorPaused` in the
 * control stream — had no word anywhere on the screen. Being current and being
 * stopped are independent facts, so this is its own thing on the row rather
 * than a further state of the dot.
 *
 * **A box, where health is a dot, and absent when there is nothing to say.**
 * That is what makes it affordable on a row whose unit is the row (#134): the
 * bar's ordinary state does not draw this at all, and when it does draw it the
 * pause is the news.
 *
 * It shows the reason as the conductor gave it; that already names the project,
 * the project and the runtime. Who is not shown: it is always `lingtai`.
 *
 * **Resume is an append, like Approve.** It does not start a daemon and does
 * not reach into a running pass; it records the decision, and whatever is
 * hosting the work reads it on its next opportunity (0013). So the button
 * asks once before it acts: this is the whole installation, not one card.
 */
import { useState, useTransition } from 'react'

import { resumeWork } from './actions.ts'

export function Paused({ reason }: { by?: string | null; reason: string | null }) {
  const [asking, setAsking] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  const said = reason ?? 'the setup is paused'

  return (
    <>
      {/* Held, not failed: nothing is broken, and a red chip here would send
          somebody looking for the fault instead of reading the sentence. */}
      <span
        className="chip held"
        title="a setup pause recorded before 0.14 still stands; nothing starts until it is resumed (lingtai resume) — an attempt already in flight finishes"
      >
        setup paused
      </span>
      <span className="why" title={said}>
        {reason}
      </span>
      {asking ? (
        <span className="btnrow">
          {/* `held` and not `pri`: this renders inside the bar, and a solid
              amber button would be a second amber beside the headline (#134). */}
          <button
            className="btn held"
            disabled={pending}
            onClick={() => {
              setRefusal(null)
              startTransition(async () => {
                const result = await resumeWork()
                // Reverted, with the server's own sentence. The chip stays
                // paused, because it is: this reports the append, and the
                // append is what a re-read will find or not find.
                if (!result.ok) setRefusal(result.detail)
                else setAsking(false)
              })
            }}
          >
            {pending ? '…' : 'Resume every project — fix the recipe first?'}
          </button>
          <button className="btn" disabled={pending} onClick={() => setAsking(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button className="btn" onClick={() => setAsking(true)}>
          Resume
        </button>
      )}
      {refusal ? <span className="refusal">{refusal}</span> : null}
    </>
  )
}
