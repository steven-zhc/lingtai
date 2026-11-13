/**
 * What a process opens once and closes once, when its command has finished (#725).
 *
 * A Postgres client left open holds the event loop until its idle connection
 * times out — about 30 s after the last line of output — so the entry closes
 * the process log after `runCli` settles. This is the seam: `choose.ts` hands it
 * the opener, and a test hands it a fake with a counted `close`.
 */

import { Deferred, Effect } from 'effect'

/** Raised by anything that asks for the process log after it was closed. */
export class ProcessLogClosedError extends Error {
  constructor() {
    super('the process log was closed when the command finished; nothing may read it after')
    this.name = 'ProcessLogClosedError'
  }
}

/** The Effect form: `get` and `close` are methods that return Effects, run when asked. */
export interface ClosableOnceEffect<T> {
  /** Open on first use, memoised in a `Deferred` so racing first callers open once. */
  get(): Effect.Effect<T>
  /** Close what was opened, once; with nothing opened, only refuse from now on. */
  close(): Effect.Effect<void>
}

/**
 * Nothing is allocated or run when this is called — it is built at module scope.
 * The memo cells are made inside the first `get`/`close` to run, in the same
 * synchronous step as the check, so two first callers cannot both open. Both
 * methods are masked from the start: the first caller's open always fills the
 * cell, and only the waiting is interruptible. A failed open is remembered.
 */
export function closableOnceEffect<T>(
  open: Effect.Effect<T>,
  close: (t: T) => Effect.Effect<void>,
  /** The refusal a `get` after `close` gets; the process log's own by default. */
  refuse: () => Error = () => new ProcessLogClosedError(),
): ClosableOnceEffect<T> {
  let opening: Deferred.Deferred<T> | null = null
  let closing: Deferred.Deferred<void> | null = null
  let closed = false
  return {
    get: () =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          if (closed) return Effect.die(refuse())
          if (opening) return restore(Deferred.await(opening))
          const cell = (opening = Deferred.makeUnsafe<T>())
          return Effect.exit(open).pipe(
            Effect.flatMap((exit) => Deferred.done(cell, exit)),
            Effect.andThen(restore(Deferred.await(cell))),
          )
        }),
      ),
    close: () =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          closed = true
          if (closing) return restore(Deferred.await(closing))
          const cell = (closing = Deferred.makeUnsafe<void>())
          const opened = opening
          // An open that failed left nothing to close, and its error was already
          // reported by the command that asked.
          const work: Effect.Effect<void> = opened
            ? Effect.flatMap(Effect.exit(Deferred.await(opened)), (opened) =>
                opened._tag === 'Success' ? close(opened.value) : Effect.void,
              )
            : Effect.void
          return Effect.exit(work).pipe(
            Effect.flatMap((exit) => Deferred.done(cell, exit)),
            Effect.andThen(restore(Deferred.await(cell))),
          )
        }),
      ),
  }
}
