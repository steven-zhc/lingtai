/**
 * What holds a project: one function every gate's guard asks (0126 §2).
 *
 * A stop is a lock and an unlock on the stream of what it stops. Today there
 * is one kind, a person's pause of one project; the day ceiling and the
 * account limit join as further members of `Lock` in later tickets, and
 * `locksOn`'s input is an object so they can add what they read without
 * changing what a caller passes.
 */
import type { ToAppend } from './envelope.ts'
import type { PayloadOf } from './events.ts'
import type { ProjectState } from './project.ts'

export type Lock = { kind: 'paused'; by: string; since: Date }

export function locksOn(input: { project: ProjectState }): readonly Lock[] {
  const { paused } = input.project
  return paused === null ? [] : [{ kind: 'paused', by: paused.by, since: paused.at }]
}

/** The locks as one sentence for a person, or null when nothing holds the project. */
export function lockSentence(project: string, locks: readonly Lock[]): string | null {
  if (locks.length === 0) return null
  return locks.map((lock) => `${project} is paused by ${lock.by} since ${lock.since.toISOString()}`).join('; ')
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
