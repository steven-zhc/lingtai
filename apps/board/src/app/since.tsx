'use client'

import { useEffect, useState } from 'react'

import { sinceText } from '@/lib/progress'

/**
 * A clock that ticks between appends (#916). It starts at the server's `now`,
 * so the server and the first client render print the same text; only after
 * mount does it read the real clock, once a second.
 */
export function Since({ iso, serverNow }: { iso: string; serverNow: number }) {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="mono">{sinceText(iso, now)}</span>
}
