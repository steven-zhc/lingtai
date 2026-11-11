/**
 * What holds a project: one function every gate's guard asks (0126 §2).
 *
 * A stop is a lock and an unlock on the stream of what it stops. There are two
 * kinds today, a person's pause of one project and the day's ceiling; the
 * account limit joins as a further member of `Lock` in a later ticket, and
 * `locksOn`'s input is an object so each can add what it reads without
 * changing what a caller passes.
 */
import type { ControlState } from './control.ts'
import type { ToAppend } from './envelope.ts'
import type { PayloadOf } from './events.ts'
import type { ProjectState } from './project.ts'

export type Lock =
  | { kind: 'paused'; by: string; since: Date }
  | {
      kind: 'ceiling'
      since: Date
      day: string
      reportedUsd: number
      estimatedUsd: number
      ceilingUsd: number
      /** The local midnight after `day`. */
      until: Date
    }

/**
 * `project` is the person's pause of one project; `control` is `ctl-conductor`
 * read whole, and adds the day's ceiling. A caller leaves out what it does not
 * read: the guard asks the ceiling in its own check and the pause in another.
 * A `reached` of any day is a lock — whether yesterday's is lifted is the
 * guard's to append, never a reader's to compute (0126 §1).
 */
export function locksOn(input: { project?: ProjectState; control?: ControlState }): readonly Lock[] {
  const locks: Lock[] = []
  const reached = input.control?.dayCeiling.reached ?? null
  if (reached !== null) {
    const [y, m, d] = reached.day.split('-').map(Number) as [number, number, number]
    locks.push({
      kind: 'ceiling',
      since: reached.at,
      day: reached.day,
      reportedUsd: reached.reportedUsd,
      estimatedUsd: reached.estimatedUsd,
      ceilingUsd: reached.ceilingUsd,
      until: new Date(y, m - 1, d + 1),
    })
  }
  const paused = input.project?.paused ?? null
  if (paused !== null) locks.push({ kind: 'paused', by: paused.by, since: paused.at })
  return locks
}

const money = (n: number): string => n.toFixed(2)

function oneSentence(project: string, lock: Lock): string {
  switch (lock.kind) {
    case 'paused':
      return `${project} is paused by ${lock.by} since ${lock.since.toISOString()}`
    case 'ceiling':
      return `daily ceiling reached — today $${money(lock.reportedUsd)} reported + ~$${money(lock.estimatedUsd)} est. of a $${money(lock.ceilingUsd)} ceiling; lingtai ceiling raise <usd> goes on today`
    default: {
      const never: never = lock
      return never
    }
  }
}

/** The locks as one sentence for a person, or null when nothing holds the project. */
export function lockSentence(project: string, locks: readonly Lock[]): string | null {
  if (locks.length === 0) return null
  return locks.map((lock) => oneSentence(project, lock)).join('; ')
}

/** The event that pauses `state`'s project, or null when it is already paused — or not a project yet. */
export function pauseTransition(state: ProjectState, by: string): ToAppend<PayloadOf<'ProjectPaused'>> | null {
  if (state.project === null || state.paused !== null) return null
  return { type: 'ProjectPaused', actor: by, data: { project: state.project, by } }
}

/** The event that resumes `state`'s project, or null when it is not paused. */
export function resumeTransition(state: ProjectState, by: string): ToAppend<PayloadOf<'ProjectResumed'>> | null {
  if (state.project === null || state.paused === null) return null
  return { type: 'ProjectResumed', actor: by, data: { project: state.project, by } }
}
