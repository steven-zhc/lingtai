import { Effect } from 'effect'

/**
 * The one generic face of this package's promise ports (#1025's `runGitHub`
 * shape): the promise members of the `Tickets` that `dbTickets` builds are each
 * one call of this, until `Tickets` is an Effect port. On Effect 4 the promise
 * rejects with the failure itself, so `instanceof BodyChanged` and `err.message`
 * hold for every caller.
 */
export function runPort<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect)
}

/**
 * The failure channel of a lifted promise: the rejection itself, unchanged, so a
 * caller's `instanceof` and `.message` still hold on the far side of the face.
 */
export const asFailure = (error: unknown): Error => error as Error
