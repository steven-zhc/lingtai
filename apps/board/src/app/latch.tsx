'use client'

/**
 * A disclosure that opens itself when something starts, and stays where you put it.
 *
 * **Opening is a signal; closing is not** (#132). The board and the task page
 * each re-render on every append (`live.tsx`), so anything derived from the reducer
 * is a value that changes under a reader's hands — and `<details open={running}>` is the whole of the
 * bug that makes: React writes the attribute whenever the prop changes, so the
 * attempt that opened itself when its run started *collapses under somebody
 * reading it* the moment that run finishes, and a `RunLog` that was already
 * mounted when the run started never opens at all, because `useState(live)`
 * read `live` once at mount and the run was not going yet.
 *
 * So the open state is held here and moved in one direction only: the signal
 * going true opens it, nothing closes it but the reader, and a signal that was
 * already true at mount is the initial state rather than an effect. What a
 * person opened stays open and what they closed stays closed, which is the only
 * behaviour a disclosure on a live page can have and still be usable.
 */
import { useEffect, useState } from 'react'

/**
 * The open state of one disclosure, latched.
 *
 * `initial` is what the server rendered — the same value, so nothing
 * hydrates differently — and `openWhen` is the live signal. `RunLog` needs the
 * boolean itself (it decides whether to follow a file), so this is a hook.
 */
export function useLatch(initial: boolean, openWhen = false): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(initial || openWhen)

  // Only ever true. This runs when `openWhen` becomes true — a run that started
  // after this mounted — and never puts it back, which is the half `open={…}`
  // as a bare attribute got wrong in both directions.
  useEffect(() => {
    if (openWhen) setOpen(true)
  }, [openWhen])

  return [open, setOpen]
}

/**
 * The element id a `#fragment` names. A malformed escape — `#100%`, a link cut
 * off mid-escape — is taken as written rather than thrown: an effect that
 * throws takes the whole task page to the error boundary, and an unknown
 * fragment has only ever done nothing.
 */
export function fragmentId(hash: string): string {
  const raw = hash.slice(1)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}
