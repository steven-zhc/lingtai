/**
 * The promise faces the conductor's own tests hold, here and not in `src` (#1133).
 *
 * Each is what an exported `Effect.runPromise(<twin>)` in `src` used to be, kept for the tests
 * that read a promise `runAttempt`. No host calls them, so they are not a face in the ratchet's
 * sense and not counted: `test/` is not `src`.
 */
import type { EventStore } from '@lingtai/event-store'
import { Effect } from 'effect'

import { requeueHoldingEffect } from '../src/approve.ts'
import { editBodyAndRequeueHoldingEffect } from '../src/edit-body.ts'
import { resolveWaitHoldingEffect, type ResolveWaitOptions, type ResolveWaitResult } from '../src/resolve-wait.ts'
import {
  attemptPortsFrom,
  claimStepEffect,
  runAttemptEffect,
  type AttemptOptions,
  type AttemptOver,
  type StepReached,
} from '../src/run-attempt.ts'

/** `runAttemptEffect` for a caller that holds promise ports. */
export function runAttempt(options: AttemptOptions): Promise<AttemptOver> {
  return Effect.runPromise(runAttemptEffect(attemptPortsFrom(options)))
}

/** `claimStepEffect` for a caller that holds promise ports. */
export function claimStep(options: AttemptOptions): Promise<StepReached> {
  return Effect.runPromise(claimStepEffect(attemptPortsFrom(options)))
}

/** `resolveWaitHoldingEffect` as a promise. */
export function resolveWaitHolding(options: ResolveWaitOptions, ticketId: string): Promise<ResolveWaitResult> {
  return Effect.runPromise(resolveWaitHoldingEffect(options, ticketId))
}

/** `requeueHoldingEffect` as a promise. */
export function requeueHolding(...args: Parameters<typeof requeueHoldingEffect>) {
  return Effect.runPromise(requeueHoldingEffect(...args))
}

/** `editBodyAndRequeueHoldingEffect` as a promise. */
export function editBodyAndRequeueHolding(...args: Parameters<typeof editBodyAndRequeueHoldingEffect>) {
  return Effect.runPromise(editBodyAndRequeueHoldingEffect(...args))
}
