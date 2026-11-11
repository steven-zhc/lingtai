import { Data } from 'effect'

/**
 * The package's one failure: a reader or a probe that rejected where nothing
 * downstream can say anything useful without it (0101 §6 — the operation is a
 * field on it, not a second class).
 */
export class SetupFailed extends Data.TaggedError('SetupFailed')<{
  operation: 'detect' | 'runtimes'
  message: string
  cause: unknown
}> {}

export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
