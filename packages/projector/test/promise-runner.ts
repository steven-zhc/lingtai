/**
 * The promise `ProjectionRunner` a test awaits, over `makeRunner`'s Effect ones.
 *
 * It lives under `test/` and not `src/`: no host holds a promise runner, so the
 * run belongs to the test that wants one (0101 §7), and the ratchet counts
 * `src/` only. `Effect.runPromise` rejects with the squashed cause, so `start`
 * rejects with the very `ProjectionShapeError` a test checks with `instanceof`.
 */
import { Effect } from 'effect'

import { makeRunner, type ProjectionRunner, type ProjectionRunnerOptions } from '../src/projection.ts'

export function createProjectionRunner(options: ProjectionRunnerOptions): ProjectionRunner {
  const r = makeRunner(options, { detached: true })
  return {
    name: r.name,
    get failure() {
      return r.failure
    },
    get running() {
      return r.running
    },
    start: () => Effect.runPromise(r.start()),
    stop: () => Effect.runPromise(r.stop()),
    rebuild: () => Effect.runPromise(r.rebuild()),
    lag: () => Effect.runPromise(r.lag()),
    shape: () => Effect.runPromise(r.shape()),
    close: () => Effect.runPromise(r.close()),
  }
}
