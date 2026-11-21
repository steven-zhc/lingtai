/**
 * What a PR's checks add up to (0130 §5, #1339): **one pure verdict, Lingtai's and never an adapter's**. A CI provider
 * only reports `CiCheck`s; the required filter, the none-started rule, the timeout and what each verdict means live
 * here once, so the next provider copies none of it.
 */

export type CiCheckState =
  | 'queued'
  | 'running'
  | 'success'
  | 'failure'
  | 'neutral'
  | 'skipped'
  | 'cancelled'
  | 'timed-out'
  | 'unknown'

/** Evidence a check left on the CI platform: Lingtai keeps the link and never the content. */
export interface CiArtifact {
  readonly kind: 'log' | 'screenshot' | 'video' | 'other'
  readonly name: string
  readonly url: string
}

/** One check on a commit, as any provider reports it. */
export interface CiCheck {
  readonly name: string
  readonly state: CiCheckState
  readonly url: string
  readonly startedAt?: Date | undefined
  readonly endedAt?: Date | undefined
  readonly artifacts?: readonly CiArtifact[] | undefined
}

export interface CiFailing {
  readonly name: string
  readonly state: CiCheckState
  readonly url: string
}

export type CiVerdict =
  | { readonly kind: 'green' }
  | { readonly kind: 'red'; readonly failing: readonly CiFailing[] }
  | { readonly kind: 'running' }
  | { readonly kind: 'none-started' }
  | { readonly kind: 'timed-out' }

/** No check started within this long of the push: the PR waits on a person. */
export const NONE_STARTED_MS = 30 * 60_000

const PASSING: ReadonlySet<CiCheckState> = new Set(['success', 'neutral', 'skipped'])
const PENDING: ReadonlySet<CiCheckState> = new Set(['queued', 'running'])

/**
 * `required` is the recipe's `pr.ci.required`: `'all'` counts every check on the head, a list counts only those names —
 * and a listed name absent from the head is still running. Running while any counted check is queued or running, or
 * while none exists and the push is under 30 minutes old. **The timeout anchors on the oldest counted `startedAt`, or
 * on the push when none has one**, so a required check that never appears ends in `timed-out` and not in silence.
 */
export function ciVerdict(input: {
  readonly checks: readonly CiCheck[]
  readonly required: readonly string[] | 'all'
  readonly pushedAt: Date
  readonly now: Date
  readonly timeoutMs: number
}): CiVerdict {
  const { required, pushedAt, now, timeoutMs } = input
  const counted = required === 'all' ? input.checks : input.checks.filter((c) => required.includes(c.name))
  const missing = required === 'all' ? [] : required.filter((name) => !counted.some((c) => c.name === name))

  if (counted.length === 0 && missing.length === 0) {
    return now.getTime() - pushedAt.getTime() >= NONE_STARTED_MS ? { kind: 'none-started' } : { kind: 'running' }
  }

  const pending = counted.some((c) => PENDING.has(c.state)) || missing.length > 0
  if (pending) {
    const starts = counted.flatMap((c) => (c.startedAt === undefined ? [] : [c.startedAt.getTime()]))
    const anchor = starts.length === 0 ? pushedAt.getTime() : Math.min(...starts)
    return now.getTime() - anchor > timeoutMs ? { kind: 'timed-out' } : { kind: 'running' }
  }

  const failing = counted.filter((c) => !PASSING.has(c.state))
  if (failing.length === 0) return { kind: 'green' }
  return { kind: 'red', failing: failing.map((c) => ({ name: c.name, state: c.state, url: c.url })) }
}
