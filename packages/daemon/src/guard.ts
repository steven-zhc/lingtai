import { type Lock, lockSentence, locksOn, projectStream, reduceProject } from '@lingtai/domain'
import type { EventStore, SnapshotStore } from '@lingtai/event-store'
import { Context, Effect } from 'effect'

/**
 * The one entry every gate asks before it starts work (0126 §4).
 *
 * A gate never reads `prj-` and never calls `locksOn`: it is handed `locked`
 * (`lockedBy`, below), built from a guard. That is what lets the day ceiling and
 * the account limit arrive later as **checks run inside `locksFor`** — each
 * appends its own lock and unlock on a transition before it answers — without
 * one gate being touched. A check is one function added to `CHECKS`, not a branch
 * in a gate.
 *
 * Asked at the moment a gate would start work, every time, never cached across a
 * look: the answer is a fact about the moment it is asked (#861).
 */
export interface Guard {
  /** Rejects as the read does: unknown is not *unlocked*. */
  locksFor(project: string): Effect.Effect<readonly Lock[], Error>
}

export interface GuardOptions {
  store: EventStore
  /** Accepted for the checks that will fold a snapshotted stream; the Project aggregate is not one. */
  snapshots?: SnapshotStore
}

type Check = (options: GuardOptions, project: string) => Effect.Effect<readonly Lock[], Error>

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** A person's pause of this project: `prj-{project}`, read whole, fresh. */
const projectPause: Check = ({ store }, project) =>
  Effect.tryPromise({ try: () => store.read(projectStream(project)), catch: asError }).pipe(
    Effect.map((events) => locksOn({ project: reduceProject(events) })),
  )

const CHECKS: readonly Check[] = [projectPause]

export function makeGuard(options: GuardOptions): Guard {
  return {
    locksFor: (project) =>
      Effect.forEach(CHECKS, (check) => check(options, project)).pipe(Effect.map((all) => all.flat())),
  }
}

/** The run the ratchet does not count (see `first-project.ts`'s `runEffect`). */
const run = Effect.runPromiseWith(Context.empty())

/**
 * A gate's `locked` callback: the sentence that stops a start, or null.
 *
 * It never rejects. A read that fails answers a sentence — *could not read
 * whether <project> is paused* — so the project is not started and the next look
 * asks again (unknown is not *unpaused*).
 */
export const lockedBy =
  (guard: Guard): ((project: string) => Promise<string | null>) =>
  (project) =>
    run(
      guard.locksFor(project).pipe(
        Effect.map((locks) => lockSentence(project, locks)),
        Effect.catch((err) =>
          Effect.succeed<string | null>(`could not read whether ${project} is paused — ${err.message}`),
        ),
      ),
    )
