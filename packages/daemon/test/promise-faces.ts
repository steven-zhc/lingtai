/**
 * The promise faces the daemon's own tests hold, here and not in `src` (#1118).
 *
 * Each is what an exported `Effect.runPromise(<twin>)` in `src` used to be, kept for the tests
 * that read a promise `Daemon` or `WorkLoop` or hand `clientsForProjects` promise seams. No
 * host calls them, so they are not a face in the ratchet's sense and not counted: `test/` is not `src`.
 */
import { clientForSeam, recipeForSeam, ticketsOfSeam, type ClientFor, type RecipeFor } from '@lingtai/conductor/filter'
import { Effect } from 'effect'

import { clientsForProjectsEffect } from '../src/converge.ts'
import { type DaemonOptions, type DaemonStart, startDaemonEffect } from '../src/daemon.ts'
import { type WorkLoop, type WorkLoopOptions, makeWorkLoop } from '../src/work-loop.ts'

/** `startDaemonEffect`, with the promise `Daemon` over its port. */
export function startDaemon(options: DaemonOptions): Promise<DaemonStart> {
  return Effect.runPromise(
    Effect.map(startDaemonEffect(options), (started): DaemonStart => {
      if (!started.ok) return started
      const port = started.daemon
      return {
        ok: true,
        since: started.since,
        daemon: {
          stopped: Effect.runPromise(port.stopped()),
          stop: () => void Effect.runPromise(port.stop()),
          get stoppedProjections() {
            return port.stoppedProjections
          },
        },
      }
    }),
  )
}

/** `makeWorkLoop`, with the promise `WorkLoop` over its port. */
export function createWorkLoop(options: WorkLoopOptions): WorkLoop {
  const port = makeWorkLoop(options)
  return {
    start: () => Effect.runPromise(port.start()),
    stop: () => Effect.runPromise(port.stop()),
    get passes() {
      return port.passes
    },
    get busy() {
      return port.busy
    },
  }
}

/** `clientsForProjectsEffect` over promise seams: each one handed in is lifted, one not handed in is left to the Effect's own default. */
export function clientsForProjects(
  projects: Parameters<typeof clientsForProjectsEffect>[0],
  options: {
    hasAuth?: () => boolean
    clientFor?: ClientFor
    recipeFor?: RecipeFor
    ticketsOf?: Parameters<typeof ticketsOfSeam>[0]
  } = {},
) {
  return Effect.runPromise(
    clientsForProjectsEffect(projects, {
      ...(options.hasAuth === undefined ? {} : { hasAuth: options.hasAuth }),
      ...(options.clientFor === undefined ? {} : { clientFor: clientForSeam(options.clientFor) }),
      ...(options.recipeFor === undefined ? {} : { recipeFor: recipeForSeam(options.recipeFor) }),
      ...(options.ticketsOf === undefined ? {} : { ticketsOf: ticketsOfSeam(options.ticketsOf) }),
    }),
  )
}
