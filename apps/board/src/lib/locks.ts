/**
 * What holds a project, read for the board (#994, 0126 §8).
 *
 * One read of the registered projects per render, shared by every caller that
 * asks (`cache`, as `readConductor` does in `task.ts`), and the locks taken
 * through `locksOn` — **no reduce here**: `ProjectState.paused` is the domain's.
 *
 * **A failed read is said.** `readProjectLocks` answers `{ ok: false }` and
 * never `[]` for a failure: a banner fed an empty list would say "nothing is
 * paused", which is the silence #77 was about.
 */
import { loadProjects } from '@lingtai/conductor/projects'
import { pauseProject, resumeProject } from '@lingtai/daemon/control'
import {
  isRegistered,
  lockSentence,
  locksOn,
  projectStream,
  reduceProject,
  type Envelope,
  type Lock,
} from '@lingtai/domain'
import type { EventStore } from '@lingtai/event-store'
import { Effect } from 'effect'
import { cache } from 'react'

import type { ActionResult } from './diff.ts'

/** The registered projects, read once however many places of one render ask. */
export const readRegistered = cache(() => loadProjects())

export type HeldProject = { project: string; locks: readonly Lock[] }
export type ProjectLocks = { ok: true; held: readonly HeldProject[] } | { ok: false; problem: string }

/** Every registered project that something holds, ordered by name. Never `[]` for a failure. */
export const readProjectLocks = cache(async (): Promise<ProjectLocks> => {
  try {
    const projects = await readRegistered()
    const held: HeldProject[] = []
    for (const state of projects) {
      const locks = locksOn({ project: state })
      if (state.project !== null && locks.length > 0) held.push({ project: state.project, locks })
    }
    held.sort((a, b) => (a.project < b.project ? -1 : a.project > b.project ? 1 : 0))
    return { ok: true, held }
  } catch (err) {
    return { ok: false, problem: err instanceof Error ? err.message : String(err) }
  }
})

/** All of them for *all projects*, and only that project's row for one. */
export function inScope(held: readonly HeldProject[], project: string | undefined): readonly HeldProject[] {
  return project === undefined ? held : held.filter((h) => h.project === project)
}

const two = (n: number): string => String(n).padStart(2, '0')

/** `HH:MM` when `since` is on `now`'s local day, otherwise the date and the time. */
export function sinceLabel(since: Date, now: Date): string {
  const time = `${two(since.getHours())}:${two(since.getMinutes())}`
  const sameDay =
    since.getFullYear() === now.getFullYear() &&
    since.getMonth() === now.getMonth() &&
    since.getDate() === now.getDate()
  return sameDay ? time : `${since.getFullYear()}-${two(since.getMonth() + 1)}-${two(since.getDate())} ${time}`
}

/**
 * Pause or resume one project, for the board's two actions.
 *
 * A name that is not a registered project is refused by name before the
 * appender is asked: `pauseProject` on a stream that does not exist has no
 * `paused` to name in its `already` answer. Read from the store the appender
 * writes to, so the check and the write cannot disagree about which log.
 */
export const setProjectPaused = (
  store: EventStore,
  verb: 'pause' | 'resume',
  project: string,
  by: string,
  now: Date = new Date(),
) =>
  Effect.gen(function* () {
    const read = () => Effect.tryPromise(() => store.read(projectStream(project))).pipe(Effect.map(reduceProject))
    const state = yield* read()
    if (!isRegistered(state)) {
      return { ok: false, detail: `"${project}" is not a registered project` } satisfies ActionResult
    }
    const answer = yield* verb === 'pause' ? pauseProject(project, by, store) : resumeProject(project, by, store)
    switch (answer.kind) {
      case 'appended':
        return {
          ok: true,
          detail: verb === 'pause' ? `${project} paused` : `${project} resumed`,
        } satisfies ActionResult
      case 'already': {
        const paused = (yield* read()).paused
        const who = paused === null ? '' : ` by ${paused.by}`
        return {
          ok: true,
          detail: `${project} is already paused${who} since ${sinceLabel(answer.since, now)}`,
        } satisfies ActionResult
      }
      case 'not-paused':
        return { ok: true, detail: `${project} is not paused` } satisfies ActionResult
    }
  })

/**
 * Why a new question may not be asked of this project, or null (#996).
 *
 * A reader's refusal (0126 §5), not the gate: the board does not hold the
 * conductor lock, and the daemon's `locked` still decides whether a turn
 * starts. `read` is the project's stream, or the error reading it failed with —
 * unknown is not unlocked.
 */
export function askRefusal(project: string, read: readonly Envelope[] | Error): string | null {
  if (read instanceof Error) return `could not read whether ${project} is paused — ${read.message}`
  const sentence = lockSentence(project, locksOn({ project: reduceProject(read) }))
  return sentence === null ? null : `${sentence} — resume it, then ask`
}
