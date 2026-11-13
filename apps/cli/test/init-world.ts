/**
 * An `InitWorld` written the way the tests wrote it before its IO members became Effects: each member returns a
 * promise. `liftInitWorld` turns it into the real shape at the one place a test builds a world, so a fake never
 * changes and no expected string moves. Each member is `Effect.tryPromise` with the rejection kept as its own
 * failure — never `Effect.promise`, which would make it a defect (CLI-01's `lift`).
 */
import { Effect } from 'effect'

import type { InitWorld } from '../src/init.ts'
import { liftPort } from './first-project-world.ts'

type Ported = 'git' | 'runtimes' | 'exists' | 'database' | 'app' | 'ghStatus' | 'boardAt' | 'board' | 'open' | 'runGit'
type Ported2 = 'projects' | 'registerLocal' | 'history' | 'doctor'

type Promised<K extends keyof InitWorld> = InitWorld[K] extends (...args: infer A) => Effect.Effect<infer R, unknown>
  ? (...args: A) => Promise<R>
  : never

export type PromiseInitWorld = Omit<InitWorld, Ported | Ported2 | 'appeared' | 'pressed'> & {
  [K in Ported | Ported2]: Promised<K>
} & {
  appeared: (signal: AbortSignal) => Promise<{ slug: string; owner: string }>
  pressed: (signal: AbortSignal) => Promise<void>
}

/** A promise port that is handed the signal of the fiber it runs in, so an interrupted race aborts it. */
export const signalPort =
  <A>(f: (signal: AbortSignal) => PromiseLike<A>) =>
  (): Effect.Effect<A, unknown> =>
    Effect.tryPromise({ try: (signal) => f(signal), catch: (e) => e })

export function liftInitWorld(w: PromiseInitWorld): InitWorld {
  return {
    ...w,
    git: liftPort(w.git),
    runtimes: liftPort(w.runtimes),
    exists: liftPort(w.exists),
    database: liftPort(w.database),
    app: liftPort(w.app),
    ghStatus: liftPort(w.ghStatus),
    boardAt: liftPort(w.boardAt),
    board: liftPort(w.board),
    open: liftPort(w.open),
    runGit: liftPort(w.runGit),
    projects: liftPort(w.projects),
    registerLocal: liftPort(w.registerLocal),
    history: liftPort(w.history),
    doctor: liftPort(w.doctor),
    appeared: signalPort(w.appeared),
    pressed: signalPort(w.pressed),
  }
}
