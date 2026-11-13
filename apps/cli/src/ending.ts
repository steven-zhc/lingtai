/**
 * How a command ends (#725): `run` settles, the process's database connection is
 * closed, and only then is the code handed back — so node is not left waiting
 * for an idle connection to time out. Takes `close` as an argument so this file
 * imports nothing from the store and `entry.ts` stays lazy.
 */
import { Cause, Effect, Fiber } from 'effect'

/** A dead network must not hold a finished command: the close is given this long. */
export const CLOSE_BUDGET_MS = 2000

/**
 * True when the close finished; false when it failed or ran out of time.
 *
 * The close is forked on its own and only the *wait* for it is timed. The stores close
 * uninterruptibly (`closable.ts`: "only the waiting is interruptible"), so `Effect.timeout`
 * over the close itself would wait for an interruption that a dead socket never grants, which is
 * the hang #725 bounded.
 */
const closeBounded = (close: Effect.Effect<void, unknown>): Effect.Effect<boolean> =>
  Effect.forkDetach(close).pipe(
    Effect.flatMap((fiber) => Fiber.join(fiber)),
    Effect.timeoutOrElse({
      duration: CLOSE_BUDGET_MS,
      orElse: () => Effect.fail(new Error(`no answer in ${CLOSE_BUDGET_MS} ms`)),
    }),
    Effect.as(true),
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const err = Cause.squash(cause)
        console.error(
          `lingtai: the store's connections did not close (${err instanceof Error && err.message ? err.message : String(err)}); exiting anyway`,
        )
        return false
      }),
    ),
  )

/**
 * Settle `run`, close, then return its code; a failure is re-raised, as the same cause, after the
 * close. Giving up on a close does not stop its socket holding the event loop, so when it did not
 * finish `exit` is called with the code the process will end on (1 for a failure), and is the
 * caller's to make survive a pending write.
 */
export const finishEffect = <E>(
  run: Effect.Effect<number, E>,
  close: Effect.Effect<void, unknown>,
  exit?: (code: number) => void,
): Effect.Effect<number, E> =>
  Effect.gen(function* () {
    const settled = yield* Effect.exit(run)
    const closed = yield* closeBounded(close)
    if (settled._tag === 'Failure') {
      if (!closed) exit?.(1)
      return yield* Effect.failCause(settled.cause)
    }
    if (!closed) exit?.(settled.value)
    return settled.value
  })
