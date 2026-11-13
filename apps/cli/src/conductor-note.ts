/**
 * What a command that only appends says about the board (0100 §13).
 *
 * **One process writes each projection: the one holding the conductor lock.**
 * A command that appends — `requeue`, `close`, `ask`, `end`, … — holds no
 * projector, so what it did reaches the board when a conductor reduces it. With
 * no conductor up that is never, until one starts; this is the one line that
 * says so. It is a note and never a verdict: it goes to `progress`, so `--json`
 * stdout is unchanged, and nothing here can fail the command.
 */
import { conductorLockHolder } from '@lingtai/daemon'
import { Cause, Effect } from 'effect'

/** How long `approve` waits for a conductor to land what it approved, and how long a note waits for the lock's answer. */
export const WAIT_MS = 60_000

export type Bound = <T>(
  op: Promise<T>,
  ms: number,
  signal?: AbortSignal,
) => Promise<{ ok: true; value: T } | { ok: false; why: 'timeout' | 'abort' }>

/** A read that never answers must not outlast the 60 seconds or Ctrl+C. */
export const boundReal: Bound = (op, ms, signal) =>
  new Promise((resolve, reject) => {
    let settled = false
    const end = (r: Parameters<typeof resolve>[0]): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    const onAbort = (): void => end({ ok: false, why: 'abort' })
    const timer = setTimeout(() => end({ ok: false, why: 'timeout' }), Math.max(0, ms))
    // `op` is handled before anything can settle first: a rejection that arrives
    // after a timeout or Ctrl+C is dropped here and never becomes unhandled.
    op.then(
      (value) => end({ ok: true, value }),
      (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        reject(err)
      },
    )
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
  })

export const NO_CONDUCTOR =
  'no conductor is running — the board shows this when one starts: lingtai start, or lingtai run'

/** `Bound` as an Effect: a wait that gives up at `ms`, or — through an injected one — at Ctrl+C. */
export type BoundEffect = <T>(
  op: Effect.Effect<T, unknown>,
  ms: number,
) => Effect.Effect<{ ok: true; value: T } | { ok: false; why: 'timeout' | 'abort' }, unknown>

/** A read that never answers must not outlast the 60 seconds; Ctrl+C interrupts the fiber itself. */
export const boundEffect: BoundEffect = (op, ms) =>
  op.pipe(
    Effect.timeoutOption(Math.max(0, ms)),
    Effect.map((won) =>
      won._tag === 'Some' ? { ok: true as const, value: won.value } : { ok: false as const, why: 'timeout' as const },
    ),
  )

export interface ConductorNoteWorld {
  /** `conductorLockHolder`: who conducts, null for nobody, a throw where the lock could not be asked. */
  holder?: () => Promise<string | null>
  bound?: BoundEffect
}

export type ConductorNote = (world?: ConductorNoteWorld) => Effect.Effect<string | null>

/**
 * The line to print after an append, or null when a conductor holds the lock
 * and so will reduce it. A holder that cannot be read is *could not tell*, never
 * *no conductor*. Never fails.
 */
export const conductorNote: ConductorNote = (world = {}) => {
  const bound = world.bound ?? boundEffect
  const holder = world.holder ?? (() => conductorLockHolder())
  const couldNotTell = (why: string): string =>
    `could not tell whether a conductor is running (${why}); lingtai doctor says`
  return bound(Effect.tryPromise({ try: holder, catch: (err) => err }), WAIT_MS).pipe(
    Effect.map((asked) => {
      if (!asked.ok) {
        return asked.why === 'abort' ? null : couldNotTell(`no answer in ${WAIT_MS / 1000} seconds`)
      }
      return asked.value === null ? NO_CONDUCTOR : null
    }),
    // A failed ask — typed or defect — is a line, never a failure; only an interruption passes.
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.succeed<string | null>(
            couldNotTell(
              (() => {
                const err = Cause.squash(cause)
                return err instanceof Error ? err.message : String(err)
              })(),
            ),
          ),
    ),
  )
}

/** Says the note through `say` when there is one. */
export const noteConductor = (say: (line: string) => void, note: ConductorNote = conductorNote): Effect.Effect<void> =>
  Effect.map(note(), (line) => {
    if (line !== null) say(line)
  })
