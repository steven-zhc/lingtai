'use client'

import { useEffect, useState } from 'react'

import { elapsed, sinceText } from '@/lib/progress'
import { stuckOf, type RunningWatch, type Stuck } from '@/lib/stuck'

import { useFollowing } from './live.tsx'
import { useWriting } from './run-log.tsx'

/** The warning in words. Never amber: amber means a person is waited on (0123 §7). */
export function stuckText(stuck: Stuck): string {
  switch (stuck.kind) {
    case 'unwritten':
      return 'nothing is writing this attempt’s run log, so the conductor running it has stopped. `lingtai doctor` says whether a daemon is up.'
    case 'overdue':
      return `it has run ${elapsed(stuck.overMs)} past its limit of ${elapsed(stuck.budgetMs)}, which the conductor enforces, so it is probably not being watched.`
    case 'quiet':
      return `nothing has been recorded for ${elapsed(stuck.quietMs)}: no file written, no step ended.`
  }
}

/**
 * The reading `LastEvent` draws, from `now` alone so a clock moved forward
 * changes it without new props (#918).
 */
export function lastEventReading(
  watch: RunningWatch,
  writing: boolean | null,
  now: number,
): { age: string | null; stuck: Stuck | null } {
  return {
    age: watch.lastEvent === null ? null : sinceText(watch.lastEvent.at, now),
    stuck: stuckOf({ now, watch, writing }),
  }
}

/**
 * When the attempt last did anything, and whether it may be stuck. The page does
 * not re-render while nothing happens, so both are computed here, once a second,
 * and not on the server (#918). Starts at the server's `now` so the first client
 * render matches the markup.
 */
export function LastEvent({ watch, serverNow }: { watch: RunningWatch; serverNow: number }) {
  return <Ticking key={watch.runId} watch={watch} serverNow={serverNow} />
}

export function Ticking({ watch, serverNow }: { watch: RunningWatch; serverNow: number }) {
  const [now, setNow] = useState(serverNow)
  useEffect(() => {
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const writing = useWriting()
  const following = useFollowing()
  const { age, stuck } = lastEventReading(watch, writing, now)
  if (watch.lastEvent === null) return null
  const notFollowing = following ? null : <> (this page is not following the log)</>
  return stuck === null ? (
    <p className="triage-then" data-rank="last-event">
      Last event <span className="mono">{age}</span> ago: {watch.lastEvent.sentence}
      {notFollowing}
    </p>
  ) : (
    <p className="refusal" data-rank="last-event">
      Possibly stuck: {stuckText(stuck)} Last event <span className="mono">{age}</span> ago: {watch.lastEvent.sentence}
      {notFollowing}
    </p>
  )
}
