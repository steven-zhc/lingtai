/**
 * The one failure every recipe IO path ends in (0101 §6, #1052), and the plain-call helpers around it.
 * The disk itself is `@lingtai/project`'s (0128 §8).
 *
 * Parsing and validation stay plain functions (0101 §7); `plainWhen` is how an
 * Effect calls one that throws.
 */
import { Data, Effect } from 'effect'

/**
 * The package's one tagged failure: a port or the disk rejected where nothing
 * downstream can say anything useful without it (0101 §6 — the operation is a
 * field on it, not a second class). `message` is the underlying error's own.
 */
export class RecipeFailed extends Data.TaggedError('RecipeFailed')<{
  operation: 'read' | 'replace' | 'signed-in' | 'read-at-ref'
  message: string
  cause: unknown
}> {}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export const failed =
  (operation: RecipeFailed['operation']) =>
  (cause: unknown): RecipeFailed =>
    new RecipeFailed({ operation, message: messageOf(cause), cause })

/** Whether a rejection from `readFile` means the file is not there. */
export function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

/**
 * A plain call that throws, as an Effect: a throw `refusal` recognises is the
 * failure; any other throw is a bug, and a defect.
 */
export const plainWhen = <A, E>(f: () => A, refusal: (e: unknown) => e is E): Effect.Effect<A, E> =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(f())
    } catch (e) {
      return refusal(e) ? Effect.fail(e) : Effect.die(e)
    }
  })
