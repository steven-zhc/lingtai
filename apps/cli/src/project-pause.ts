/**
 * `lingtai pause [project]` / `lingtai resume [project]` and the refusal
 * `lingtai now` makes of a paused project (#992, 0126 §7).
 *
 * Each is an Effect over a store and a `log`, so the suite drives them against a
 * memory store and reads the appends back, rather than through `controlCommand`
 * (whose stub cannot see them). A person's pause carries no reason: it is a lock
 * on one project, and it holds until somebody lifts it.
 */
import { loadProjects } from '@lingtai/conductor'
import {
  type ControlState,
  type Guard,
  pauseProject,
  resumeProject,
  resumeConductor,
  readControl,
} from '@lingtai/daemon'
import { CONTROL_STREAM, type ProjectState, lockSentence } from '@lingtai/domain'
import { ConcurrencyError, type EventStore, eventStore } from '@lingtai/event-store'
import { Context, Effect } from 'effect'

export interface ProjectPauseOptions {
  /** The suite passes a memory store and a collector; nothing else should set them. */
  store?: EventStore
  log?: (line: string) => void
  /** The registered projects. Defaults to `loadProjects`. */
  projects?: () => Promise<readonly ProjectState[]>
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)))

/** Exit code and nothing else: every line the command had to say is already printed. */
export type Outcome = 0 | 1 | 2

const readProjects = (options: ProjectPauseOptions) =>
  Effect.tryPromise({ try: () => (options.projects ?? (() => loadProjects()))(), catch: asError })

/**
 * The projects a command names: the one, or every registered one. A name that is
 * not registered is refused here, before anything is appended — `pauseProject` on
 * a stream that holds no project has nothing to answer with.
 */
function select(
  registered: readonly ProjectState[],
  name: string | undefined,
  log: (line: string) => void,
): ProjectState[] | null {
  const known = registered.filter((p) => p.project !== null)
  if (name === undefined) return known
  const found = known.find((p) => p.project === name)
  if (found) return [found]
  const names = known.map((p) => p.project).join(', ')
  log(`no project named "${name}" — registered: ${names === '' ? '(none)' : names}`)
  return null
}

/** The run the ratchet does not count (see `first-project.ts`'s `runEffect`). */
export const runEffect = Effect.runPromiseWith(Context.empty())

export const IN_FLIGHT_FINISHES = 'an attempt already in flight finishes; nothing new starts'

export const pauseProjects = (name: string | undefined, by: string, options: ProjectPauseOptions = {}) =>
  Effect.gen(function* () {
    const log = options.log ?? console.log
    const registered = yield* readProjects(options).pipe(
      Effect.mapError((e) => new Error(`could not read the registered projects — ${e.message}`)),
    )
    const chosen = select(registered, name, log)
    if (chosen === null) return 2 as Outcome
    if (chosen.length === 0) {
      log('no registered projects — nothing to pause')
      return 0 as Outcome
    }
    for (const p of chosen) {
      const project = p.project!
      const answer = yield* pauseProject(project, by, options.store).pipe(
        Effect.mapError((e) => new Error(`could not pause ${project} — ${e.message}`)),
      )
      if (answer.kind === 'appended') log(`${project}: paused`)
      else if (answer.kind === 'already') {
        log(`${project}: already paused by ${answer.by} since ${answer.since.toISOString()}`)
      }
    }
    log(IN_FLIGHT_FINISHES)
    return 0 as Outcome
  })

export const resumeProjects = (name: string | undefined, by: string, options: ProjectPauseOptions = {}) =>
  Effect.gen(function* () {
    const log = options.log ?? console.log
    const registered = yield* readProjects(options).pipe(
      Effect.mapError((e) => new Error(`could not read the registered projects — ${e.message}`)),
    )
    const chosen = select(registered, name, log)
    if (chosen === null) return 2 as Outcome
    let did = 0

    for (const p of chosen) {
      const project = p.project!
      // Bare resume says nothing of a project that was not paused; a named one says so.
      if (name === undefined && p.paused === null) continue
      const answer = yield* resumeProject(project, by, options.store).pipe(
        Effect.mapError((e) => new Error(`could not resume ${project} — ${e.message}`)),
      )
      if (answer.kind === 'appended') {
        did += 1
        log(`${project}: resumed`)
      } else log(`${project}: not paused`)
    }

    if (name === undefined) {
      // Read and append at the head the read was taken at: a pause that lands in
      // between (the ceiling's, say) fails the append and is read again, so what
      // is printed is what this resume lifted and not what it saw a moment before.
      const store = options.store ?? eventStore
      const lift = (attempt: number): Effect.Effect<ControlState | null, unknown> =>
        Effect.gen(function* () {
          const head = yield* Effect.tryPromise({ try: () => store.head(CONTROL_STREAM), catch: asError })
          const control = yield* Effect.tryPromise({ try: () => readControl(options.store), catch: asError })
          if (!control.paused) return null
          return yield* Effect.tryPromise({
            try: () => resumeConductor(by, options.store, head),
            catch: (e) => e,
          }).pipe(
            Effect.as(control),
            Effect.catchIf(
              (e) => e instanceof ConcurrencyError && attempt < 4,
              () => lift(attempt + 1),
            ),
          )
        })
      const lifted = yield* lift(0).pipe(
        Effect.mapError((e) => new Error(`could not lift the conductor-wide pause — ${asError(e).message}`)),
      )
      if (lifted !== null) {
        const control = lifted
        did += 1
        if (control.paused) log(`lifted the conductor-wide pause (cause ${control.cause ?? 'unknown'})`)
        // A person's resume of the ceiling's pause waives it until that pause's midnight.
        if (control.paused && control.cause === 'day-ceiling') {
          const until = control.until ? ` until ${control.until.toISOString()}` : ' until midnight'
          log(`also lifted today's spend ceiling${until} — it is not checked again today`)
        }
      }
      if (did === 0) log('nothing to resume')
    }
    return 0 as Outcome
  })

/**
 * `lingtai now`'s check, through the guard rather than `locksOn`, so a lock added
 * to the guard later refuses here with no edit. Null is *nothing holds it*.
 */
export const refuseIfLocked = (project: string, guard: Guard) =>
  guard.locksFor(project).pipe(
    Effect.match({
      onFailure: (e): string => `could not read whether ${project} is paused — ${e.message}`,
      onSuccess: (locks): string | null => {
        const sentence = lockSentence(project, locks)
        return sentence === null ? null : `${sentence} — lingtai resume ${project} first`
      },
    }),
  )
