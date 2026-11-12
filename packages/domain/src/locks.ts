/**
 * What holds a project: one function every gate's guard asks (0126 §2).
 *
 * A stop is a lock and an unlock on the stream of what it stops. There are two
 * kinds today, a person's pause of one project and the day's ceiling; the
 * account limit joins as a further member of `Lock` in a later ticket, and
 * `locksOn`'s input is an object so each can add what it reads without
 * changing what a caller passes.
 */
import type { AccountState } from './account.ts'
import type { ControlState } from './control.ts'
import type { ToAppend } from './envelope.ts'
import type { PayloadOf, RuntimeId } from './events.ts'
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
  | {
      kind: 'account'
      runtime: RuntimeId
      by: 'lingtai'
      since: Date
      until: Date
      untilFrom: PayloadOf<'AccountLimitReached'>['untilFrom']
      said: string
    }

/**
 * `project` is the person's pause of one project; `control` is `ctl-conductor`
 * read whole, and adds the day's ceiling. A caller leaves out what it does not
 * read: the guard asks the ceiling in its own check and the pause in another.
 * A `reached` of any day is a lock — whether yesterday's is lifted is the
 * guard's to append, never a reader's to compute (0126 §1).
 */
export function locksOn(input: {
  project?: ProjectState
  control?: ControlState
  /**
   * The state of each runtime the project's recipe uses, and no other. Required,
   * so a reader that forgets it fails `tsc` rather than showing no account lock.
   * A limit whose `until` has passed is still a lock: lifting it is the guard's.
   */
  accounts: ReadonlyMap<RuntimeId, AccountState>
}): readonly Lock[] {
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
  for (const runtime of [...input.accounts.keys()].sort()) {
    const limit = input.accounts.get(runtime)?.limit ?? null
    if (limit === null) continue
    locks.push({
      kind: 'account',
      runtime,
      by: 'lingtai',
      since: limit.since,
      until: limit.until,
      untilFrom: limit.untilFrom,
      said: limit.said,
    })
  }
  const paused = input.project?.paused ?? null
  if (paused !== null) locks.push({ kind: 'paused', by: paused.by, since: paused.at })
  return locks
}

/** For a read that is not about accounts. Grep for it to find every reader that opted out. */
export const NO_ACCOUNTS: ReadonlyMap<RuntimeId, AccountState> = new Map()

const money = (n: number): string => n.toFixed(2)

const pad = (n: number): string => String(n).padStart(2, '0')
const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`

/** `HH:MM` when `at` is today, otherwise the date and the time. */
export function whenLabel(at: Date, now: Date): string {
  if (Number.isNaN(at.getTime())) return 'an unreadable time'
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return sameDay ? clock(at) : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${clock(at)}`
}

/** What `untilFrom` says about where the time came from. */
export function untilFromWords(from: PayloadOf<'AccountLimitReached'>['untilFrom']): string {
  switch (from) {
    case 'message':
      return 'read from its message'
    case 'message-latest':
      return 'the latest its message could mean'
    case 'backoff':
      return "its message named no time; the recipe's backoff"
    case 'backoff-unreadable':
      return "its message named a time this build could not read; the recipe's backoff"
    default: {
      const never: never = from
      return never
    }
  }
}

function oneSentence(project: string, lock: Lock, now: Date): string {
  switch (lock.kind) {
    case 'paused':
      return `${project} is paused by ${lock.by} since ${lock.since.toISOString()}`
    case 'ceiling':
      return `daily ceiling reached — today $${money(lock.reportedUsd)} reported + ~$${money(lock.estimatedUsd)} est. of a $${money(lock.ceilingUsd)} ceiling; lingtai ceiling raise <usd> goes on today`
    case 'account':
      return `lingtai waits for ${lock.runtime}'s usage limit until ${whenLabel(lock.until, now)} (${untilFromWords(lock.untilFrom)}) — lingtai account lift ${lock.runtime} once it is over`
    default: {
      const never: never = lock
      return never
    }
  }
}

/** The locks as one sentence for a person, or null when nothing holds the project. */
export function lockSentence(project: string, locks: readonly Lock[], now: Date = new Date()): string | null {
  if (locks.length === 0) return null
  return locks.map((lock) => oneSentence(project, lock, now)).join('; ')
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
