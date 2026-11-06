'use client'

/**
 * The footer on every page that reads the log but `/` (#906): fetched by the
 * browser once when mounted, so a page that re-renders on every append
 * (`router.refresh()` keeps a client component's state) does not read the day's
 * spend again. Imports no server module (#230): the footer and types only.
 */
import { useEffect, useRef, useState } from 'react'

import type { FooterReading } from '@/lib/footer'

import { Footer } from './footer.tsx'
import { Skeleton } from './skeleton.tsx'

type State = { kind: 'asking' } | { kind: 'failed' } | { kind: 'read'; reading: FooterReading }

export function FooterFetched({ project }: { project: string | undefined }) {
  const [state, setState] = useState<State>({ kind: 'asking' })
  const latest = useRef(0)

  // Mount only: `project` builds hrefs, and a different project is a different page.
  useEffect(() => {
    const mine = ++latest.current
    const settle = (next: State) => {
      if (latest.current === mine) setState(next)
    }
    fetch('/api/footer')
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status))
        return res.json() as Promise<FooterReading>
      })
      .then((reading) => settle({ kind: 'read', reading }))
      .catch(() => settle({ kind: 'failed' }))
  }, [])

  if (state.kind === 'read') return <Footer day={state.reading.day} lags={state.reading.lags} project={project} />
  return (
    <footer className="footer">
      {state.kind === 'asking' ? (
        <Skeleton shape="lines" count={1} label="reading today's spend…" />
      ) : (
        <span>the footer could not be read</span>
      )}
    </footer>
  )
}
