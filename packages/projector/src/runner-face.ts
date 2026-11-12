/**
 * The promise `ProjectionRunner` as a face over `makeRunner` (0101 §7, #1051).
 *
 * Each face is one `Effect.runPromise` over one runner method and nothing else,
 * the shape `effect-ratchet.faces.json` lists. `runPromise` rejects with the
 * squashed cause, so `start` rejects with the very `ProjectionShapeError` the
 * daemon tests for with `instanceof`. The `runner` prefix keeps these apart
 * from `store-face.ts`'s `closeFace` and `lagFace`.
 *
 * **A moved caller holds the `ProjectionRunnerPort` and never one of these.**
 */
import { Effect } from 'effect'

import type { ProjectionRunnerPort } from './projection.ts'

export function runnerCloseFace(r: ProjectionRunnerPort<never>) {
  return Effect.runPromise(r.close())
}

export function runnerLagFace(r: ProjectionRunnerPort<never>) {
  return Effect.runPromise(r.lag())
}

export function runnerRebuildFace(r: ProjectionRunnerPort<never>) {
  return Effect.runPromise(r.rebuild())
}

export function runnerShapeFace(r: ProjectionRunnerPort<never>) {
  return Effect.runPromise(r.shape())
}

export function runnerStartFace(r: ProjectionRunnerPort<never>) {
  return Effect.runPromise(r.start())
}

export function runnerStopFace(r: ProjectionRunnerPort<never>) {
  return Effect.runPromise(r.stop())
}
