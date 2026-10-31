import { serverTiming, type Timing } from './timing.ts'

/** The page's read timings, for the inspector and for a test (#774). Renders nothing for an empty list. */
export function TimingMeta({ timings }: { timings: readonly Timing[] }) {
  if (timings.length === 0) return null
  return <meta name="lingtai-timing" content={serverTiming(timings)} />
}
