import { Cause, Data, Effect, Option } from 'effect'

import { printJsonError } from './output.ts'

/** How a handler ends non-zero: `runCli` turns it into the exit code (#1088). */
export class CommandExit extends Data.TaggedError('CommandExit')<{ readonly code: number }> {}

/** `Effect.void` on 0, a `CommandExit` otherwise. */
export const exitWith = (code: number): Effect.Effect<void, CommandExit> =>
  code === 0 ? Effect.void : Effect.fail(new CommandExit({ code }))

/**
 * A promise, lifted with its error kept as it was: the bare `Effect.tryPromise(() => …)` rejects with an
 * `UnknownError` whose message is not the one a person should read.
 */
export const lift = <A>(f: () => PromiseLike<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: f, catch: (e) => e })

/** A handler that could not produce its report: the error document under `--json`, the message otherwise. Returns the exit code. */
export function failed(command: string, asJson: boolean, err: unknown): number {
  const message = (err as Error).message || String(err)
  if (asJson) return printJsonError(command, 'unavailable', message)
  console.error(message)
  if (process.env['LINGTAI_DEBUG']) console.error((err as Error).stack)
  else console.error('(LINGTAI_DEBUG=1 for the stack)')
  return 1
}

/** A wizard that threw: the message, as the hand-rolled entry printed it, and exit 1. */
export function wizardFailed(err: unknown): number {
  const error = err as Error
  console.error(error.message || String(err))
  if (process.env['LINGTAI_DEBUG']) console.error(error.stack)
  return 1
}

const printedBy =
  (print: (err: unknown) => number) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, CommandExit, R> =>
    Effect.catchCause(self, (cause): Effect.Effect<A, CommandExit> => {
      const typed = Cause.findErrorOption(cause)
      if (Option.isSome(typed) && typed.value instanceof CommandExit) return Effect.fail(typed.value)
      // An interruption is not a failure: nothing is printed for it.
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause as Cause.Cause<never>)
      const err = Option.isSome(typed) ? typed.value : Cause.squash(cause)
      return Effect.fail(new CommandExit({ code: print(err) }))
    })

/** Wraps a handler's body: whatever fails is printed as `failed()` prints it and becomes `CommandExit` 1. */
export const orFailed = (command: string, asJson: boolean) => printedBy((err) => failed(command, asJson, err))

/** As `orFailed`, for the wizards. */
export const orWizardFailed = () => printedBy(wizardFailed)
