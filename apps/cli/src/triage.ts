/**
 * `waitTriage`: one held wait, triaged — the `apps/cli` half of `#428`.
 *
 * `packages/conductor/src/triage.ts` is pure (its own header: *"no runtime, no
 * mirror, no store, no clock"*) and stops at `triageBrief`/`parseTriage`. This
 * is the caller that module asks for: it reads the ticket's stream, appends
 * `TriageStarted`, gathers the evidence, dispatches the agent under
 * Discussion's containment, and appends one `WaitTriaged`.
 *
 * **Every port, injected** — the store, the runtime, the mirror reads, the
 * issue fetch, the base branch, the containment and the clock — so the unit
 * test needs none of the real ones. `daemonTriagePorts` wires the production
 * ports for the daemon in this file.
 */
import { createRuntime, runtimeRun, runtimeVersionOf, type Runtime, type RunOutcome } from '@lingtai/agent'
import { runnableEnv } from '@lingtai/agent-env'
import { readingFor } from '@lingtai/conductor/discuss'
import { currentRecipeEffect, loadProjectEffect, loadProjectsEffect } from '@lingtai/conductor/projects'
import { readProjectTicketEffect } from '@lingtai/conductor/read-ticket'
import { recordPrompt } from '@lingtai/conductor/record-prompt'
import { readState } from '@lingtai/conductor/snapshot-state'
import {
  MAX_READ_ROUNDS,
  parseTriage,
  triageBrief,
  type ReadableRef,
  type TriageEvidence,
} from '@lingtai/conductor/triage'
import { TRIAGE_EVENTS } from '@lingtai/daemon'
import {
  parsePayload,
  parseTicketStream,
  attemptReducer,
  reduceTicket,
  ticketStream,
  triageFactsOf,
  triageFactsFromState,
  ticketReducer,
  MERGE_HUNKS_ONE_BY_ONE,
  TRIAGE_TEXT_MAX,
  type Envelope,
  type PayloadOf,
  type WaitId,
  type StoredRoute,
} from '@lingtai/domain'
import {
  TRIAGE_ANSWER_JSON_SCHEMA,
  triageStatus,
  unwrapTriageEnvelope,
  type TriageResult,
  type WaitReason,
} from '@lingtai/domain/wait'
import {
  ConcurrencyError,
  eventStore,
  log as processLog,
  readThroughSnapshot,
  type EventStore,
  type SnapshotReadOptions,
} from '@lingtai/event-store'
import { readTasksEffect, type TaskCard } from '@lingtai/projector'
import { triageCallFor, type DiscussAgent, type Triage } from '@lingtai/recipe'
import { conflictedPathsAt, diffStatAt, listAt, readAt, refSha, refShaEffect, type ConflictedPath } from '@lingtai/repo'
import { Cause, Context, Deferred, Effect, Exit, Semaphore } from 'effect'

import { prepare } from './discuss.ts'
import { lift } from './exit.ts'
import { prepareTriageCheckout } from './triage-checkout.ts'

/** One queue for this daemon process; the key stays present until its worker settles. */
const queued = new Map<string, { done: Deferred.Deferred<unknown, unknown>; settled: Deferred.Deferred<void> }>()
/** One agent at a time, across every key. */
const permit = Semaphore.makeUnsafe(1)
/** What a worker answers when a lock held it back: a scan that joined it must ask again. */
const HELD = Symbol('held')

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * Queue `work` behind the one permit. A new key forks a detached worker, which keeps the
 * caller's context and outlives it; a key already queued hands back the same Deferreds.
 */
function enqueue(
  key: { ticketId: string; waitId: WaitId },
  work: Effect.Effect<unknown, unknown>,
  log: (line: string) => void,
): Effect.Effect<{
  added: boolean
  done: Deferred.Deferred<unknown, unknown>
  settled: Deferred.Deferred<void>
}> {
  return Effect.suspend(
    (): Effect.Effect<{
      added: boolean
      done: Deferred.Deferred<unknown, unknown>
      settled: Deferred.Deferred<void>
    }> => {
      const id = JSON.stringify([key.ticketId, key.waitId])
      const existing = queued.get(id)
      if (existing) return Effect.succeed({ added: false, ...existing })
      const done = Deferred.makeUnsafe<unknown, unknown>()
      const settled = Deferred.makeUnsafe<void>()
      queued.set(id, { done, settled })
      const worker = permit
        .withPermits(1)(work)
        .pipe(
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              yield* Deferred.done(done, exit)
              if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                log(`triage ${key.waitId}: ${messageOf(Cause.squash(exit.cause))}`)
              }
            }),
          ),
          // A worker that dies or is interrupted still frees its key: a later scan must get a new one.
          Effect.ensuring(
            Effect.suspend(() => {
              queued.delete(id)
              return Deferred.succeed(settled, undefined)
            }),
          ),
        )
      return Effect.as(Effect.forkDetach(worker), { added: true, done, settled })
    },
  )
}

export function enqueueTriage(
  key: { ticketId: string; waitId: WaitId },
  run: Effect.Effect<unknown, unknown>,
  log: (line: string) => void = console.error,
): boolean {
  return Effect.runSyncWith(Context.empty())(enqueue(key, run, log)).added
}

export interface TriageTriggerPorts {
  store: Pick<EventStore, 'read'>
  /** Every registered project, for a lift that names none (`DayCeilingLifted`); absent means none. */
  projects?: () => Effect.Effect<readonly string[], unknown>
  triageFor(project: string): Effect.Effect<Triage | null, unknown>
  /** Fails while the start time is unread: nothing is decided from a substituted one (#583). */
  daemonStartedAt: () => Effect.Effect<Date, unknown>
  run(request: WaitTriageRequest): Effect.Effect<{ started?: boolean } | void, unknown>
  log?: (line: string) => void
  /** A sentence while the project is locked (0126 §5); absent means no lock. */
  locked?: (project: string) => Effect.Effect<string | null, unknown>
}

export interface CatchUpTriagePorts extends SnapshotReadOptions {
  store: Pick<EventStore, 'read' | 'readTypes' | 'append'>
  readTasks(project: string): Effect.Effect<Pick<TaskCard, 'issue' | 'state'>[], unknown>
  baseSha(project: string): Effect.Effect<string | null, unknown>
  /** Fails while the start time is unread: nothing is decided from a substituted one (#583). */
  daemonStartedAt: () => Effect.Effect<Date, unknown>
  run(request: WaitTriageRequest): Effect.Effect<{ started?: boolean } | void, unknown>
  log?: (line: string) => void
  /** A sentence while the project is locked (0126 §5); absent means no lock. */
  locked?: (project: string) => Effect.Effect<string | null, unknown>
}

const notLocked = () => Effect.succeed(null)

/** The events that lift a hold on every project at once; they name none. */
const LIFTS_OF_A_DAY = ['DayCeilingLifted'] as const

/** `catchCause` that lets an interruption through; the squashed failure is what `onError` reads. */
const recoverWith =
  <B, E2 = never>(onError: (err: unknown) => Effect.Effect<B, E2>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A | B, E2, R> =>
    self.pipe(
      Effect.catchCause((cause): Effect.Effect<B, E2> =>
        Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause as Cause.Cause<never>) : onError(Cause.squash(cause)),
      ),
    )

/** Scan the board's waiting candidates, but let each ticket stream decide whether its wait is current. */
export const catchUpTriage = (project: string, triage: Triage | null, deps: CatchUpTriagePorts) =>
  Effect.gen(function* () {
    if (triage === null) return
    // Before any scan, so a start time that cannot be read fails the scan and the
    // recipe hash stays unpinned: the next pass asks again (#583).
    const startedAt = yield* deps.daemonStartedAt()
    for (const card of yield* deps.readTasks(project)) {
      if (card.state !== 'waiting') continue
      // The stream name comes from the domain helper, not the board's row key.
      const stream = ticketStream(project, card.issue)
      yield* catchUpWait(stream, triage, deps, startedAt)
    }
  })

const catchUpWait = (ticketId: string, triage: Triage, deps: CatchUpTriagePorts, startedAt: Date) =>
  Effect.gen(function* () {
    const state = yield* readThroughSnapshot(deps.store, ticketReducer, ticketId, 'all', deps)
    const lifecycle = state.lifecycle
    if (lifecycle.status !== 'blocked') return
    const { waitId, reason } = lifecycle
    const status = triageStatus(reason, triageFactsFromState(state, waitId), {
      declared: true,
      daemonStartedAt: startedAt,
    })
    if (status._tag !== 'Queued' && status._tag !== 'Interrupted') return
    const start = () =>
      enqueue(
        { ticketId, waitId },
        Effect.gen(function* () {
          // A person or the live subscriber may have answered this while it waited in the queue.
          const latest = yield* readThroughSnapshot(deps.store, ticketReducer, ticketId, 'all', deps)
          const current = latest.lifecycle
          if (current.status !== 'blocked' || current.waitId !== waitId) return
          const facts = triageFactsFromState(latest, waitId)
          const next = triageStatus(current.reason, facts, { declared: true, daemonStartedAt: startedAt })
          if (next._tag === 'Queued' || (next._tag === 'Interrupted' && (facts.started?.attempt ?? 0) < 2)) {
            // Held back means nothing is appended: the wait stays `Queued` (or
            // `Interrupted`) until a resume scan or a restart finds it again.
            const why = yield* (deps.locked ?? notLocked)(parseTicketStream(ticketId)?.project ?? '').pipe(
              recoverWith((err) => Effect.succeed(messageOf(err))),
            )
            if (why !== null) {
              deps.log?.(`triage ${waitId} on ${ticketId}: not started — ${why}`)
              return HELD
            }
            const outcome = yield* deps.run({ ticketId, waitId, reason: current.reason, triage })
            if (outcome && outcome.started === false)
              return yield* Effect.fail(new Error(`could not start triage ${waitId}`))
          } else if (next._tag === 'Interrupted') {
            yield* finishInterrupted(ticketId, waitId, deps, startedAt)
          }
        }),
        deps.log ?? console.error,
      )
    const first = yield* start()
    const result = yield* Deferred.await(first.done)
    // This scan joined a worker whose lock read may predate a resume: once that
    // worker has settled, ask again rather than let the resume be consumed.
    if (!first.added && result === HELD) {
      yield* Deferred.await(first.settled)
      const again = yield* start()
      yield* Deferred.await(again.done)
    }
  })

/** Finish the second interrupted attempt only while it is still the latest unfinished attempt. */
const finishInterrupted = (ticketId: string, waitId: WaitId, deps: CatchUpTriagePorts, startedAt: Date) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 5; tries += 1) {
      const reduced = yield* readThroughSnapshot(deps.store, ticketReducer, ticketId, 'all', deps)
      const lifecycle = reduced.lifecycle
      if (lifecycle.status !== 'blocked' || lifecycle.waitId !== waitId) return
      const facts = triageFactsFromState(reduced, waitId)
      if (
        facts.started === null ||
        facts.started.attempt < 2 ||
        triageStatus(lifecycle.reason, facts, { declared: true, daemonStartedAt: startedAt })._tag !== 'Interrupted'
      )
        return
      const started = reduced.waits.findLast((w) => w.waitId === waitId)!.triage.started!
      const runId = 'run' in lifecycle.reason ? lifecycle.reason.run.runId : null
      const headSha =
        runId === null ? null : (yield* readThroughSnapshot(deps.store, attemptReducer, runId, 'all', deps)).headSha
      const baseSha = headSha === null ? yield* deps.baseSha(parseTicketStream(ticketId)!.project) : null
      const attempt = facts.started.attempt
      const appended = yield* lift(() =>
        deps.store.append(ticketId, reduced.version, [
          {
            type: 'WaitTriaged',
            actor: 'conductor',
            data: parsePayload('WaitTriaged', {
              waitId,
              attempt,
              headSha: headSha ?? baseSha ?? '',
              result: { _tag: 'TriageFailed', why: 'interrupted' },
              by: started.by,
            }),
          },
        ]),
      ).pipe(
        Effect.as(true),
        recoverWith((err) => (err instanceof ConcurrencyError ? Effect.succeed(false) : Effect.die(err))),
      )
      if (appended) return
    }
    return yield* Effect.fail(new Error(`could not finish interrupted triage ${waitId} after version conflicts`))
  })

/** A successful scan pins the resolved triage section until a later pass sees a different one. */
export const catchUpChangedTriage = (
  project: string,
  triage: Triage | null,
  hashes: Map<string, string>,
  deps: CatchUpTriagePorts,
) =>
  Effect.gen(function* () {
    const hash = JSON.stringify(triage)
    if (hashes.get(project) === hash) return
    yield* catchUpTriage(project, triage, deps)
    hashes.set(project, hash)
  })

/** An unreadable recipe supplies no triage declaration; try it again on a later pass. */
export const catchUpRegisteredTriage = <T extends { project: string | null }>(
  projects: readonly T[],
  resolve: (project: T) => Effect.Effect<Triage | null, unknown>,
  scan: (project: string, triage: Triage | null) => Effect.Effect<void, unknown>,
  log: (line: string) => void,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (const project of projects) {
      if (project.project === null) continue
      const name = project.project
      yield* Effect.gen(function* () {
        yield* scan(name, yield* resolve(project))
      }).pipe(recoverWith((err) => Effect.sync(() => log(`triage catch-up ${name}: ${(err as Error).message}`))))
    }
  })

function currentWait(events: readonly Envelope[], waitId: WaitId): boolean {
  const lifecycle = reduceTicket(events).lifecycle
  return lifecycle.status === 'blocked' && lifecycle.waitId === waitId
}

/** Hand over only a current, queued wait. The effect never waits for its worker. */
export const onWaitStarted = (
  event: Envelope,
  deps: TriageTriggerPorts & CatchUpTriagePorts,
): Effect.Effect<void, unknown> =>
  Effect.gen(function* () {
    if (!(TRIAGE_EVENTS as readonly string[]).includes(event.type)) return
    if (event.type === 'ProjectResumed') {
      // Forked and never awaited: a worker runs an agent, and a handler that has not
      // settled in SUBSCRIBER_TIMEOUT_MS is reported as a failure.
      const { project } = event.data as PayloadOf<'ProjectResumed'>
      yield* Effect.forkDetach(
        catchUpProject(project, deps).pipe(
          recoverWith((err) => Effect.sync(() => deps.log?.(`triage catch-up ${project}: ${messageOf(err)}`))),
        ),
      )
      return
    }
    if ((LIFTS_OF_A_DAY as readonly string[]).includes(event.type)) {
      // A lifted day names no project, so every registered one is caught up. Forked, as above.
      yield* Effect.forkDetach(
        Effect.gen(function* () {
          const names = deps.projects ? yield* deps.projects() : []
          for (const project of names) {
            yield* catchUpProject(project, deps).pipe(
              recoverWith((err) => Effect.sync(() => deps.log?.(`triage catch-up ${project}: ${messageOf(err)}`))),
            )
          }
        }).pipe(recoverWith((err) => Effect.sync(() => deps.log?.(`triage catch-up: ${messageOf(err)}`)))),
      )
      return
    }
    const parsed = parseTicketStream(event.streamId)
    if (parsed === null) return
    const triage = yield* deps.triageFor(parsed.project).pipe(recoverWith(() => Effect.succeed(null)))
    const events = yield* lift(() => deps.store.read(event.streamId))
    const { waitId, reason } = event.data as PayloadOf<'WaitStarted'>
    if (!currentWait(events, waitId)) return
    // A first beat that failed dates `started_at` after attempts this daemon
    // starts, so with no start time read nothing is queued here: the catch-up
    // finds the wait `Queued` on a later pass (#583).
    const daemonStartedAt = yield* deps.daemonStartedAt().pipe(
      recoverWith((err) =>
        Effect.sync(() => {
          deps.log?.(`triage ${waitId}: daemon start time unread, left to catch-up: ${messageOf(err)}`)
          return null
        }),
      ),
    )
    if (daemonStartedAt === null) return
    const context = { declared: triage !== null, daemonStartedAt }
    if (triageStatus(reason, triageFactsOf(events, waitId), context)._tag !== 'Queued' || triage === null) return
    yield* enqueue(
      { ticketId: event.streamId, waitId },
      Effect.gen(function* () {
        const latest = yield* lift(() => deps.store.read(event.streamId))
        if (!currentWait(latest, waitId)) return
        if (triageStatus(reason, triageFactsOf(latest, waitId), context)._tag !== 'Queued') return
        const why = yield* (deps.locked ?? notLocked)(parsed.project).pipe(
          recoverWith((err) => Effect.succeed(messageOf(err))),
        )
        if (why !== null) {
          deps.log?.(`triage ${waitId} on ${event.streamId}: not started — ${why}`)
          return HELD
        }
        const outcome = yield* deps.run({ ticketId: event.streamId, waitId, reason, triage })
        if (outcome && outcome.started === false)
          return yield* Effect.fail(new Error(`could not start triage ${waitId}`))
      }),
      deps.log ?? console.error,
    )
  })

const catchUpProject = (project: string, deps: TriageTriggerPorts & CatchUpTriagePorts) =>
  Effect.flatMap(deps.triageFor(project), (triage) => catchUpTriage(project, triage, deps))

/**
 * This process's start, as the store's clock dates it: `TriageStarted` is dated
 * by the store, and a database ahead of this host would read an attempt a
 * previous conductor cut off as `Running` (#576). The first success is kept;
 * a failed read, or a row that is another pid's because the first beat failed,
 * fails and is read again on the next ask — the host's clock is never put in
 * its place (#583).
 */
export function memoDaemonStartedAt(
  read: () => Promise<{ pid: number; startedAt: Date } | null>,
  pid: number = process.pid,
): () => Effect.Effect<Date, unknown> {
  let resolved: Date | null = null
  return () =>
    Effect.suspend(() => {
      if (resolved !== null) return Effect.succeed(resolved)
      return lift(read).pipe(
        Effect.flatMap((row) => {
          if (row === null || row.pid !== pid)
            return Effect.fail(new Error('the daemon start time has not been recorded yet'))
          resolved = row.startedAt
          return Effect.succeed(row.startedAt)
        }),
      )
    })
}

/**
 * The triage `issue` port: one ticket through the one reader, so a `db`
 * project's brief carries its title and body (#731). A failure is thrown
 * unchanged, and the brief says *"The ticket could not be read"* with it.
 */
export function triageIssue(
  read: typeof readProjectTicketEffect = readProjectTicketEffect,
  load: typeof loadProjectEffect = loadProjectEffect,
): (ticketId: string, signal?: AbortSignal) => Effect.Effect<{ ref: string; title: string; body: string }, Error> {
  return (ticketId, signal) =>
    Effect.gen(function* () {
      const parsed = parseTicketStream(ticketId)
      if (parsed === null) return yield* Effect.fail(new Error(`invalid ticket stream: ${ticketId}`))
      const state = yield* load(parsed.project)
      if (state === null) return yield* Effect.fail(new Error(`${parsed.project} is not registered`))
      const answer = yield* read(state, Number(parsed.issue), { signal })
      if (!answer.ok) return yield* Effect.fail(answer.error as Error)
      return { ref: String(answer.ticket.number), title: answer.ticket.title, body: answer.ticket.body }
    })
}

/** The project's base branch, `main` when it names none. */
const baseOf = (ticketId: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const project = parseTicketStream(ticketId)?.project ?? ''
    return (yield* loadProjectEffect(project))?.base ?? 'main'
  })

/** The daemon's real ports. A recipe that cannot resolve leaves triage undeclared. */
export function daemonTriagePorts(
  daemonStartedAt: () => Effect.Effect<Date, unknown>,
  log: (line: string) => void,
  writer?: SnapshotReadOptions['writer'],
  locked?: (project: string) => Effect.Effect<string | null, unknown>,
): TriageTriggerPorts & CatchUpTriagePorts {
  return {
    locked,
    projects: () =>
      Effect.map(loadProjectsEffect(), (all) =>
        all.flatMap((p: { project: string | null }) => (p.project === null ? [] : [p.project])),
      ),
    store: eventStore,
    snapshots: processLog.snapshots,
    writer,
    daemonStartedAt,
    log,
    readTasks: (project) => readTasksEffect({ project }),
    baseSha: (project) =>
      Effect.gen(function* () {
        const state = yield* loadProjectEffect(project)
        if (state === null) return null
        return yield* refShaEffect({ project, ref: state.base ?? 'main' })
      }),
    triageFor: (project) =>
      Effect.gen(function* () {
        const state = yield* loadProjectEffect(project)
        return state === null ? null : ((yield* currentRecipeEffect(state)).recipe.triage ?? null)
      }),
    run: (request) =>
      Effect.gen(function* () {
        const now = Effect.runPromiseWith(yield* Effect.context<never>())
        return yield* lift(() =>
          waitTriage(
            {
              store: eventStore,
              snapshots: processLog.snapshots,
              writer,
              runtime: createRuntime,
              mirror: { refSha, listAt, readAt, diffStatAt, conflictedPathsAt },
              issue: (ticketId, signal) => now(triageIssue()(ticketId, signal)),
              base: (ticketId) => now(baseOf(ticketId)),
              prepare,
              prepareCheckout: (project, sha, signal) => prepareTriageCheckout(project, sha, undefined, signal),
              now: Date.now,
              log,
            },
            request,
          ),
        )
      }),
  }
}

/** Discussion's own bound (`packages/conductor/src/discuss.ts:116`) — a caller is putting this in a prompt. */
const FILE_BYTES = 24_000

/** `triage-<waitId>`, with anything outside `[A-Za-z0-9_-]` replaced so a `/` in a `waitId` cannot leave `chats/`. */
function containmentId(waitId: WaitId): string {
  return `triage-${waitId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** A `why` clipped to `TriageFailed.why`'s own bound — never the append that was meant to record the failure. */
function clip(text: string): string {
  return text.length > TRIAGE_TEXT_MAX ? text.slice(0, TRIAGE_TEXT_MAX) : text
}

export interface TriagePorts extends SnapshotReadOptions {
  store: EventStore
  runtime(agent: DiscussAgent, options: { tools: 'none' | 'full' }): Runtime
  mirror: {
    refSha(input: { project: string; ref: string; signal?: AbortSignal }): Promise<string | null>
    listAt(input: {
      project: string
      ref: string
      signal?: AbortSignal
    }): Promise<{ paths: string[]; truncated: boolean }>
    readAt(input: {
      project: string
      ref: string
      path: string
      limitBytes?: number
      signal?: AbortSignal
    }): Promise<string | null>
    diffStatAt(input: { project: string; base: string; head: string; signal?: AbortSignal }): Promise<string | null>
    conflictedPathsAt(input: {
      project: string
      baseSha: string
      headSha: string
      signal?: AbortSignal
    }): Promise<ConflictedPath[]>
  }
  /** The ticket, as GitHub has it now. Throws, or rejects, to say why it could not be read. */
  issue(ticketId: string, signal?: AbortSignal): Promise<{ ref: string; title: string; body: string }>
  /** The project's base branch. */
  base(ticketId: string): Promise<string>
  /** `apps/cli/src/discuss.ts`'s `prepare` in production — an empty directory and a settings file that denies every tool. */
  prepare(id: string): Promise<{ cwd: string; settingsPath: string }>
  prepareCheckout?(
    project: string,
    sha: string,
    signal?: AbortSignal,
  ): Promise<{
    cwd: string
    settingsPath: string
    env: Record<string, string>
    cleanup(): Promise<void>
  }>
  now(): number
  log?(line: string): void
}

export interface WaitTriageRequest {
  ticketId: string
  waitId: WaitId
  reason: WaitReason
  triage: Triage
  signal?: AbortSignal
}

/**
 * The evidence `triageBrief` is handed, gathered through the ports alone —
 * never `@lingtai/conductor/discuss`'s `gatherEvidence`, which reads the
 * global event store and returns the wrong shape (the design note's own
 * reason). A mirror or GitHub failure becomes `null`/`ticketProblem` here,
 * never an exception.
 */
async function gatherEvidence(
  deps: TriagePorts,
  request: WaitTriageRequest,
  before: readonly Envelope[],
  guard: <T>(work: Promise<T>) => Promise<T>,
  signal: AbortSignal,
): Promise<{ evidence: TriageEvidence; baseSha: string | null; headSha: string | null; recordedHead: string | null }> {
  const project = parseTicketStream(request.ticketId)?.project ?? ''

  let ticket: TriageEvidence['ticket'] = null
  let ticketProblem: string | null = null
  try {
    ticket = await guard(deps.issue(request.ticketId, signal))
  } catch (err) {
    ticketProblem = (err as Error).message
  }

  const base = await guard(deps.base(request.ticketId)).catch(() => 'main')

  // `'run' in reason` is `wait.ts`'s own test (`allowedResolutions`) —
  // `OwnQuestion` is the one `WaitReason` with no run, and this is not the
  // place to refuse it: whether to triage is `triageStatus`'s call (#444).
  const runId = 'run' in request.reason ? request.reason.run.runId : null

  // 1-based, in the ticket's own claim order (`item.runs`) — the same
  // numbering the detail page and Discussion's `attempt-<n>` ref use. Falls
  // back to 1 rather than null when the run is not found there, so a mirror
  // read never gets suppressed over a numbering gap.
  const runIndex = runId === null ? -1 : reduceTicket(before).runs.indexOf(runId)
  const runAttempt = runId === null ? null : runIndex >= 0 ? runIndex + 1 : 1

  let routed: StoredRoute | null = null
  let published: PayloadOf<'RunRefsPublished'> | null = null
  let head: string | null = null
  if (runId !== null) {
    // An unreadable run stream is not evidence that the attempt has no head.
    const run = await readState(deps.store, attemptReducer, runId, 'all', deps)
    routed = run.route
    published = run.published
    head = run.headSha
  }

  const baseSha = await guard(deps.mirror.refSha({ project, ref: base, signal })).catch(() => null)
  const refs: ReadableRef[] = []
  if (baseSha !== null) {
    const listed = await guard(deps.mirror.listAt({ project, ref: base, signal })).catch(() => ({
      paths: [],
      truncated: false,
    }))
    refs.push({ ref: base, sha: baseSha, paths: listed.paths, truncated: listed.truncated })
  }
  let headSha: string | null = null
  if (head !== null) {
    headSha = await guard(deps.mirror.refSha({ project, ref: head, signal })).catch(() => null)
    if (headSha !== null) {
      const listed = await guard(deps.mirror.listAt({ project, ref: headSha, signal })).catch(() => ({
        paths: [],
        truncated: false,
      }))
      refs.push({ ref: `attempt-${runAttempt ?? 1}`, sha: headSha, paths: listed.paths, truncated: listed.truncated })
    }
  }

  const diffStat =
    baseSha !== null && headSha !== null
      ? await guard(deps.mirror.diffStatAt({ project, base: baseSha, head: headSha, signal })).catch(() => null)
      : null

  return {
    evidence: {
      ticketId: request.ticketId,
      ticket,
      ticketProblem,
      reason: request.reason,
      routed,
      published,
      diffStat,
      // `head`, the log's own claim (`AttemptState.headSha`) —
      // never `headSha`, the mirror's resolution of it. A mirror that cannot
      // resolve a head the attempt did produce (a pruned worktree, a re-cloned
      // mirror) must not read as "the attempt committed nothing": the log is
      // what settles whether the attempt produced a commit, the mirror only
      // whether a file can be served for it. `discuss.ts:226`'s own
      // `gatherEvidence` follows the same rule.
      reading: readingFor({ base, baseSha, attempt: runAttempt, head }),
      refs,
    },
    baseSha,
    headSha,
    recordedHead: head,
  }
}

/**
 * One wait, triaged. Appends `TriageStarted`, dispatches the agent under
 * Discussion's containment, and ends with exactly one `WaitTriaged` carrying
 * the same `attempt`. Every failure up to and including the agent's own run
 * is caught and turned into a `TriageFailed` `WaitTriaged` rather than
 * thrown — except the `WaitTriaged` append itself, which throws if it still
 * cannot be made to land after retrying, rather than reporting a result that
 * was never recorded.
 */
export async function waitTriage(
  deps: TriagePorts,
  request: WaitTriageRequest,
): Promise<{ attempt: number; result: TriageResult; started?: boolean }> {
  // The recipe's wall starts here, before the first read, and bounds the whole
  // attempt — reads included. A timer we clear rather than `AbortSignal.timeout`,
  // so a finished attempt leaves nothing keeping the event loop alive.
  const wallMs = triageCallFor(request.triage).wallMs
  const wall = new AbortController()
  const timer = setTimeout(() => wall.abort(), wallMs)
  timer.unref?.()
  const startedAt = deps.now()
  try {
    return await waitTriageWithin(deps, request, wall.signal, startedAt + wallMs)
  } finally {
    clearTimeout(timer)
  }
}

/** Rejects with this when the wall fires while a read is outstanding. */
class WallReached extends Error {
  constructor() {
    super('timeout')
  }
}

async function waitTriageWithin(
  deps: TriagePorts,
  request: WaitTriageRequest,
  wallSignal: AbortSignal,
  wallDeadline: number,
): Promise<{ attempt: number; result: TriageResult; started?: boolean }> {
  const log = deps.log ?? (() => {})
  const callerSignal = request.signal
  const signal = callerSignal === undefined ? wallSignal : AbortSignal.any([wallSignal, callerSignal])
  // A read that ignores its signal never settles; racing it is what makes the
  // wall a bound rather than a request. A port that did settle late is dropped.
  const guard = <T>(work: Promise<T>): Promise<T> => {
    if (signal.aborted) {
      work.catch(() => {})
      return Promise.reject(new WallReached())
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        work.catch(() => {})
        reject(new WallReached())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      work.then(
        (v) => {
          signal.removeEventListener('abort', onAbort)
          resolve(v)
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(e)
        },
      )
    })
  }
  const abortedWhy = (): string => (callerSignal?.aborted ? 'aborted' : 'timeout')
  const stream = request.ticketId

  let before: Envelope[]
  try {
    before = await deps.store.read(stream)
  } catch (err) {
    log(`triage ${request.waitId}: could not read ${stream} — ${(err as Error).message}`)
    return {
      // 0, not 1 — no `TriageStarted` was ever appended, so there is no
      // attempt for this result to share a number with.
      attempt: 0,
      result: { _tag: 'TriageFailed', why: clip(`could not read the ticket: ${(err as Error).message}`) },
      started: false,
    }
  }
  const waitIsCurrent = (events: readonly Envelope[]): boolean =>
    !reduceTicket(events).waits.some((w) => w.waitId === request.waitId) || currentWait(events, request.waitId)
  if (!waitIsCurrent(before)) {
    return { attempt: 0, result: { _tag: 'TriageFailed', why: 'wait no longer current' }, started: false }
  }
  const attempt =
    (reduceTicket(before).waits.findLast((w) => w.waitId === request.waitId)?.triage.started?.attempt ?? 0) + 1

  const proposal = request.reason._tag === 'ProposedEscalated' ? request.reason.proposal : null
  const conflict = proposal?._tag === 'MergeConflict' && proposal.baseSha !== null && proposal.headSha !== null
  let conflictPaths: ConflictedPath[] | null = null
  let mechanical: TriageResult | null = null
  if (conflict) {
    try {
      const project = parseTicketStream(request.ticketId)?.project ?? ''
      conflictPaths = await guard(
        deps.mirror.conflictedPathsAt({
          project,
          baseSha: proposal.baseSha!,
          headSha: proposal.headSha!,
          signal,
        }),
      )
      const total = conflictPaths.reduce((sum, path) => sum + path.hunks, 0)
      if (total > MERGE_HUNKS_ONE_BY_ONE) {
        mechanical = {
          _tag: 'TriageAdvised',
          cause: { _tag: 'ConflictingHunks', hunks: [], total },
          resolution: 'Requeue',
          summary: `${total} merge hunks need a fresh attempt from the new base`,
          want: null,
        }
      }
    } catch (err) {
      mechanical = {
        _tag: 'TriageFailed',
        why: err instanceof WallReached ? abortedWhy() : clip((err as Error).message),
      }
    }
  }
  const by =
    mechanical === null
      ? { _tag: 'Agent' as const, runtime: request.triage.agent, model: request.triage.model ?? '' }
      : { _tag: 'Mechanical' as const }

  // A version conflict can be a person's WaitResolved or another triage.
  // Re-read the lifecycle before retrying the paid attempt's append.
  let started = false
  let startedErr: unknown = null
  for (let i = 0; i < 5 && !started; i += 1) {
    try {
      await deps.store.append(stream, before.length, [
        {
          type: 'TriageStarted',
          actor: 'conductor',
          data: parsePayload('TriageStarted', { waitId: request.waitId, attempt, by }),
        },
      ])
      started = true
    } catch (err) {
      if (err instanceof ConcurrencyError) {
        const since = before.length
        before = await deps.store.read(stream)
        if (!waitIsCurrent(before)) {
          return { attempt, result: { _tag: 'TriageFailed', why: 'wait no longer current' }, started: false }
        }
        const racedByOther = before
          .slice(since)
          .some((e) => e.type === 'TriageStarted' && (e.data as { waitId?: unknown }).waitId === request.waitId)
        if (racedByOther) {
          log(`triage ${request.waitId}: lost the race to start attempt ${attempt} — nothing dispatched`)
          return {
            attempt,
            result: { _tag: 'TriageFailed', why: clip('another attempt was already starting') },
            started: false,
          }
        }
        startedErr = err
        continue
      }
      log(`triage ${request.waitId}: TriageStarted append failed — ${(err as Error).message}`)
      return {
        attempt,
        result: { _tag: 'TriageFailed', why: clip(`could not start: ${(err as Error).message}`) },
        started: false,
      }
    }
  }
  if (!started) {
    const message = startedErr instanceof Error ? startedErr.message : String(startedErr)
    log(`triage ${request.waitId}: TriageStarted append failed — ${message}`)
    return { attempt, result: { _tag: 'TriageFailed', why: clip(`could not start: ${message}`) }, started: false }
  }

  let baseSha: string | null = null
  let headSha: string | null = mechanical === null || proposal?._tag !== 'MergeConflict' ? null : proposal.headSha
  let final: TriageResult

  if (mechanical !== null) {
    final = mechanical
  } else
    try {
      const gathered = await gatherEvidence(deps, request, before, guard, signal)
      if (signal.aborted) throw new WallReached()
      const evidence = gathered.evidence
      evidence.conflicts = conflictPaths
      baseSha = gathered.baseSha
      headSha = gathered.headSha

      const chatId = containmentId(request.waitId)
      const full = request.triage.agent === 'codex' && request.triage.tools === 'full'
      if (request.triage.tools === 'full' && !full) throw new Error('full triage tools require codex')
      const selectedSha = gathered.recordedHead === null ? baseSha : headSha
      if (full && selectedSha === null) {
        throw new Error(
          gathered.recordedHead === null ? 'base commit unavailable' : 'recorded attempt head unavailable',
        )
      }
      const checkout = full
        ? await guard(
            (deps.prepareCheckout ?? ((p, sha, sig) => prepareTriageCheckout(p, sha, undefined, sig)))(
              parseTicketStream(request.ticketId)?.project ?? '',
              selectedSha!,
              signal,
            ).then((c) => {
              // A checkout that lands after the wall must not be left behind.
              if (signal.aborted) void c.cleanup().catch(() => {})
              return c
            }),
          )
        : null
      // A run whose process scan did not finish may have a tool still alive in
      // the checkout; leaving the directory is safer than deleting it underneath.
      let toolsMayRemain = false
      try {
        const { cwd, settingsPath } = checkout ?? (await guard(deps.prepare(chatId)))
        const runtime = deps.runtime(request.triage.agent, { tools: full ? 'full' : 'none' })
        const call = triageCallFor(request.triage)
        const usdBudget = call.usd ?? 0.5
        const deadline = wallDeadline

        const project = parseTicketStream(request.ticketId)?.project ?? ''
        const shas = new Map(evidence.refs.map((r) => [r.ref, r.sha]))
        const serve = (ref: string, path: string): Promise<string | null> => {
          const sha = shas.get(ref)
          if (sha === undefined) return Promise.resolve(null)
          return guard(deps.mirror.readAt({ project, ref: sha, path, limitBytes: FILE_BYTES, signal })).catch(
            () => null,
          )
        }

        // `RunSpent`, retried on any error up to five attempts — the same bound
        // and reasoning `resolve-wait.ts`'s `requestContinuation` uses: a dropped
        // connection is as transient as a lost version race, and the version read
        // above the append is re-taken on every attempt so a concurrent writer
        // (another appender on the same ticket) is not mistaken for one. **A
        // retry is not always "nothing was written" though** — a dropped
        // connection can reject the promise after the transaction already
        // committed, and a blind retry would then append a second, identical
        // `RunSpent` for the one call. So before every attempt (including the
        // first retry), check whether the stream already carries one matching
        // this exact outcome since this `spend()` call started, and treat that as
        // landed rather than writing it again. `null` once it has landed, one way
        // or the other; otherwise the last error's message, which ends the
        // triage rather than leaving a paid call unrecorded.
        const spend = async (outcome: RunOutcome): Promise<string | null> => {
          // `since` is captured from the first read that succeeds, not a read taken
          // before the loop — a transient failure on that very first read (the
          // scenario this retry exists for) must not propagate past this function
          // uncaught, discarding both the ledger row and the advice the call
          // already produced.
          let since: number | null = null
          let lastError: unknown = null
          for (let i = 0; i < 5; i += 1) {
            try {
              const current = await deps.store.read(stream)
              if (since === null) since = current.length
              const alreadyLanded = current.slice(since).some((e) => {
                if (e.type !== 'RunSpent') return false
                const data = e.data as PayloadOf<'RunSpent'>
                return (
                  data.for._tag === 'Triage' &&
                  data.for.waitId === request.waitId &&
                  data.turns === outcome.turns &&
                  data.durationMs === outcome.durationMs &&
                  data.costUsd === outcome.costUsd
                )
              })
              if (alreadyLanded) return null
              await deps.store.append(stream, current.length, [
                {
                  type: 'RunSpent',
                  actor: 'conductor',
                  data: parsePayload('RunSpent', {
                    for: { _tag: 'Triage', waitId: request.waitId },
                    runtime: request.triage.agent,
                    turns: outcome.turns,
                    durationMs: outcome.durationMs,
                    usage: outcome.usage ?? [],
                    costUsd: outcome.costUsd,
                  }),
                },
              ])
              return null
            } catch (err) {
              lastError = err
            }
          }
          const message = lastError instanceof Error ? lastError.message : String(lastError)
          log(`triage ${request.waitId}: RunSpent append failed — ${message}`)
          return message
        }

        const served: { at: string; text: string | null }[] = []
        let costSpent = 0
        let turnsSpent = 0
        let result: TriageResult | null = null

        for (let round = 0; round <= (full ? 0 : MAX_READ_ROUNDS); round += 1) {
          // An abort during `serve`, between rounds, must not buy another one.
          if (signal.aborted) {
            result = { _tag: 'TriageFailed', why: abortedWhy() }
            break
          }

          const wallLeft = deadline - deps.now()
          if (wallLeft <= 0) {
            result = { _tag: 'TriageFailed', why: 'timeout' }
            break
          }

          const usdLeft = usdBudget - costSpent
          if (usdLeft <= 0) {
            result = { _tag: 'TriageFailed', why: 'out of usd' }
            break
          }

          // `call.turns` bounds the whole triage, not one call — `holdDiscussion`
          // hands every round the full budget, but a triage can run
          // `MAX_READ_ROUNDS + 1` rounds, and the recipe's `limits` is documented
          // as what one triage run may spend in total.
          const turnsLeft = call.turns - turnsSpent
          if (turnsLeft <= 0) {
            result = { _tag: 'TriageFailed', why: 'out of turns' }
            break
          }

          const prompt =
            triageBrief({
              evidence,
              served,
              roundsLeft: full ? 0 : MAX_READ_ROUNDS - round,
              ...(request.triage.prompt === undefined ? {} : { prompt: request.triage.prompt }),
            }) +
            (full
              ? '\n\nInspect the checked-out files directly with your CLI tools before answering. This checkout is disposable; give one final triage answer without requesting mirror-served files.'
              : '')

          // Before the call, so a crash or a kill still leaves the prompt on the log
          // (#923). Tagged as the round's `RunSpent` is.
          const triageEnv = checkout?.env ?? runnableEnv({})
          await recordPrompt(
            deps.store,
            stream,
            {
              for: { _tag: 'Triage', waitId: request.waitId },
              promptVersion: `triage@${prompt.length}`,
              runtimeVersion: await runtimeVersionOf(runtime, triageEnv, cwd),
              prompt,
            },
            log,
          )
          let threw = false
          const outcome = await runtimeRun(runtime, {
            runId: `${containmentId(request.waitId)}:${attempt}:${round}`,
            cwd,
            prompt,
            ...(call.model === undefined ? {} : { model: call.model }),
            settingsPath,
            env: triageEnv,
            limits: { turns: turnsLeft, wallMs: wallLeft, usd: usdLeft },
            // The runtime enforces the bounds before it answers; `parseTriage`
            // below stays the last check, and the route that cannot carry a
            // schema keeps the brief's own sentence (#582).
            ...(runtime.capabilities.acceptsOutputSchema === true ? { outputSchema: TRIAGE_ANSWER_JSON_SCHEMA } : {}),
            signal,
          }).catch((err: unknown): RunOutcome => {
            threw = true
            return {
              exitCode: null,
              turns: 0,
              durationMs: 0,
              costUsd: null,
              failure: { kind: 'crash', detail: (err as Error).message },
              text: null,
              sessionId: '',
            }
          })

          if (outcome.failure?.detail.includes('process cleanup incomplete')) toolsMayRemain = true

          if (!threw) {
            // A call that was billed and cannot be recorded ends the triage —
            // never silently continues to spend more against an under-reporting
            // ledger (`/spend`, 0110 §2).
            const spendProblem = await spend(outcome)
            if (spendProblem !== null) {
              result = { _tag: 'TriageFailed', why: clip(`could not record spend: ${spendProblem}`) }
              break
            }
            // The Responses route reports tokens but no dollars. Reserve its
            // conservative preflight bound before a later read round can run.
            if (outcome.spendBoundUsd !== undefined) costSpent += outcome.spendBoundUsd
            else if (outcome.costUsd !== null) costSpent += outcome.costUsd
            turnsSpent += outcome.turns
          }

          if (outcome.failure) {
            const kind = outcome.failure.kind
            // The runtimes call any incoming signal's abort `aborted`; only the
            // caller's own abort is that, and the recipe's wall is a `timeout`.
            const why =
              kind === 'timeout' || kind === 'aborted'
                ? kind === 'aborted' && !callerSignal?.aborted
                  ? 'timeout'
                  : kind
                : `${kind}: ${outcome.failure.detail}`
            result = { _tag: 'TriageFailed', why: clip(why) }
            break
          }

          const reply = parseTriage(
            outcome.structured === undefined ? outcome.text : JSON.stringify(unwrapTriageEnvelope(outcome.structured)),
          )

          if (reply.kind === 'read' && !full && round < MAX_READ_ROUNDS) {
            for (const at of reply.paths) {
              const cut = at.indexOf(':')
              const ref = at.slice(0, cut)
              const path = at.slice(cut + 1)
              served.push({ at, text: await serve(ref, path) })
            }
            log(`triage ${request.waitId}: served ${reply.paths.length} file(s)`)
            continue
          }

          if (reply.kind === 'advised') {
            if (conflictPaths !== null) {
              const cause = reply.result.cause
              const counted = new Set(
                conflictPaths.flatMap((path) => path.hunkLines.map((line) => JSON.stringify([path.path, line]))),
              )
              const classified = new Set<string>()
              if (cause._tag === 'ConflictingHunks') {
                for (const hunk of cause.hunks) {
                  classified.add(JSON.stringify([hunk.path, hunk.line]))
                }
              }
              const complete =
                cause._tag === 'ConflictingHunks' &&
                cause.total === conflictPaths.reduce((sum, path) => sum + path.hunks, 0) &&
                classified.size === cause.hunks.length &&
                classified.size === counted.size &&
                [...counted].every((identity) => classified.has(identity))
              result = complete
                ? reply.result
                : { _tag: 'TriageFailed', why: 'agent advice did not classify every counted merge hunk' }
            } else {
              result = reply.result
            }
            break
          }

          // `refused`, or a `read` past the last round — both end the triage.
          result = {
            _tag: 'TriageFailed',
            why: clip(
              reply.kind === 'refused'
                ? reply.why
                : `the agent asked for files after ${MAX_READ_ROUNDS} rounds of reading`,
            ),
          }
          break
        }

        // Unreachable: the loop above always sets `result` before it exits.
        final = result ?? { _tag: 'TriageFailed', why: 'triage did not run' }
      } finally {
        if (checkout && toolsMayRemain) {
          log(`triage ${request.waitId}: checkout kept — a tool process may still be running in it`)
        } else if (checkout)
          await checkout.cleanup().catch((error: unknown) => {
            log(`triage ${request.waitId}: cleanup failed — ${(error as Error).message}`)
            final = { _tag: 'TriageFailed', why: clip(`cleanup failed: ${(error as Error).message}`) }
          })
      }
    } catch (err) {
      if (err instanceof WallReached) {
        final = { _tag: 'TriageFailed', why: abortedWhy() }
      } else {
        log(`triage ${request.waitId}: attempt ${attempt} crashed — ${(err as Error).message}`)
        final = { _tag: 'TriageFailed', why: clip(`crashed: ${(err as Error).message}`) }
      }
    }

  // The one append this function's contract is about, so unlike `TriageStarted`
  // above it is neither swallowed nor left to a single attempt. Retried on any
  // error up to five attempts, the version re-read each time, the same bound
  // `spend` and `resolve-wait.ts`'s `requestContinuation` use — a `WaitTriaged`
  // for this `attempt` landing twice is harmless (a reader takes the latest
  // attempt's result, and a retry sends the same one), so unlike `spend` this
  // needs no check for whether an earlier attempt already landed. If it still
  // will not land after five attempts, this throws rather than returning
  // `final` as though it had: `holdDiscussion`'s own terminal append
  // (`discuss.ts:500-508`) is never wrapped in a `try`, for the same reason —
  // a caller told this succeeded when the log carries no `WaitTriaged` would
  // let `triageStatus` read `Interrupted` and buy a second triage of a wait
  // this one already answered. The caller is a daemon subscriber, which logs
  // and drops a thrown error (0015) rather than acting on a false success.
  let lastError: unknown = null
  for (let i = 0; i < 5; i += 1) {
    try {
      const current = await deps.store.read(stream)
      if (!waitIsCurrent(current)) {
        return { attempt, result: { _tag: 'TriageFailed', why: 'wait no longer current' } }
      }
      if (callerSignal?.aborted) final = { _tag: 'TriageFailed', why: 'aborted' }
      const version = current.length
      await deps.store.append(stream, version, [
        {
          type: 'WaitTriaged',
          actor: 'conductor',
          data: parsePayload('WaitTriaged', {
            waitId: request.waitId,
            attempt,
            // `AttemptState.headSha ?? baseSha ?? ''` — the empty string is for a mirror
            // with no base either, where `reading` already says no file can be
            // read.
            headSha: headSha ?? baseSha ?? '',
            result: final,
            by,
          }),
        },
      ])
      return { attempt, result: final }
    } catch (err) {
      lastError = err
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError)
  log(`triage ${request.waitId}: WaitTriaged append failed — ${message}`)
  throw lastError
}
