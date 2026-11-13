import { Cause, Effect } from 'effect'

/**
 * A port's whole cause as a failure. A reader or the trial's worktree can
 * `Effect.die` where a promise used to throw, and `Effect.tryPromise` caught
 * that; `Effect.match`/`Effect.result` see only the failure channel, so a
 * defect is squashed into one here. An interrupt (Ctrl+C) stays an interrupt.
 */
export const portCause = <A, E>(port: Effect.Effect<A, E>): Effect.Effect<A, unknown> =>
  port.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.fail(Cause.squash(cause)),
    ),
  )
