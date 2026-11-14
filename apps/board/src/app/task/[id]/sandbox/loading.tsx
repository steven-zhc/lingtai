import { Skeleton } from '../../../skeleton.tsx'

/** The Sandbox tab's parts while the attempt streams are read: shaped placeholders, no words (0111 §15). */
export default function Loading() {
  return <Skeleton shape="lines" count={8} />
}
