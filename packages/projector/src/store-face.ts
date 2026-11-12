/**
 * The promise `ProjectionStore` as a face over `Projections` (0101 §7, #1046).
 *
 * Each face is one `Effect.runPromise` over one port method and nothing else —
 * the shape `effect-ratchet.faces.json` lists, so a run that is only a face goes
 * uncounted. `runPromise` rejects with the squashed cause: the `Fail`'s error
 * itself, else the `Die`'s defect itself. A fenced `advance` therefore rejects
 * with the very `CheckpointRewoundError`, and a driver error with the driver's.
 *
 * **A moved caller is never handed a face.** That is Effect → face → Effect, and
 * the face's run starts a root fiber that drops the caller's span and
 * interruption. This file names neither twin: `choose.ts` is the only file that
 * does (`unit/one-store.test.ts`).
 */
import { Effect } from 'effect'

import type {
  BacklogQuery,
  ProjectionContext,
  ProjectionContextPort,
  ProjectionRow,
  ProjectionsPort,
  ProjectionStore,
  SpendQuery,
  TaskQuery,
  TicketReportLandedQuery,
  TicketReportQuery,
} from './store.ts'

export function queryFace<T>(ctx: ProjectionContextPort, text: string, values?: readonly unknown[]) {
  return Effect.runPromise(ctx.query<T>(text, values))
}

export function transactFace<A>(p: ProjectionsPort, fn: (ctx: ProjectionContext) => Promise<A>) {
  return Effect.runPromise(p.transact((ctx) => Effect.promise(() => fn(promiseContext(ctx)))))
}

export function checkpointFace(p: ProjectionsPort, name: string) {
  return Effect.runPromise(p.checkpoint(name))
}

export function advanceFace(p: ProjectionsPort, ctx: ProjectionContext, name: string, seq: bigint, from?: bigint) {
  return Effect.runPromise(p.advance(fromPromiseContext(ctx), name, seq, from))
}

export function registerFace(p: ProjectionsPort, ctx: ProjectionContext, name: string) {
  return Effect.runPromise(p.register(fromPromiseContext(ctx), name))
}

export function rewindFace(p: ProjectionsPort, ctx: ProjectionContext, name: string) {
  return Effect.runPromise(p.rewind(fromPromiseContext(ctx), name))
}

export function columnsOfFace(p: ProjectionsPort, tables: readonly string[]) {
  return Effect.runPromise(p.columnsOf(tables))
}

export function lagFace(p: ProjectionsPort, name: string) {
  return Effect.runPromise(p.lag(name))
}

export function lagsFace(p: ProjectionsPort) {
  return Effect.runPromise(p.lags())
}

export function tasksFace(p: ProjectionsPort, query: TaskQuery) {
  return Effect.runPromise(p.tasks(query))
}

export function taskProjectsFace(p: ProjectionsPort, query: Pick<TaskQuery, 'retentionDays'>) {
  return Effect.runPromise(p.taskProjects(query))
}

export function backlogFace(p: ProjectionsPort, query: BacklogQuery) {
  return Effect.runPromise(p.backlog(query))
}

export function spendFace(p: ProjectionsPort, query: SpendQuery) {
  return Effect.runPromise(p.spend(query))
}

export function ticketReportFace(p: ProjectionsPort, query: TicketReportQuery) {
  return Effect.runPromise(p.ticketReport(query))
}

export function landedFace(p: ProjectionsPort, query: TicketReportLandedQuery) {
  return Effect.runPromise(p.landed(query))
}

export function closeFace(p: ProjectionsPort) {
  return Effect.runPromise(p.close())
}

/** The promise `ProjectionContext` a reducer holds, over the port's. */
export function promiseContext(ctx: ProjectionContextPort): ProjectionContext {
  return {
    query: <T = ProjectionRow>(text: string, values?: readonly unknown[]) => queryFace<T>(ctx, text, values),
  }
}

/** A promise context as the port's: a rejection is a defect. For `advance`, `register` and `rewind`. */
export function fromPromiseContext(ctx: ProjectionContext): ProjectionContextPort {
  return {
    query: <T = ProjectionRow>(text: string, values?: readonly unknown[]) =>
      Effect.promise(() => ctx.query<T>(text, values)),
  }
}

/** The promise `ProjectionStore` every caller and test holds, over `Projections`. */
export function promiseProjectionStore(p: ProjectionsPort): ProjectionStore {
  return {
    transact: (fn) => transactFace(p, fn),
    checkpoint: (name) => checkpointFace(p, name),
    advance: (ctx, name, seq, from) => advanceFace(p, ctx, name, seq, from),
    register: (ctx, name) => registerFace(p, ctx, name),
    rewind: (ctx, name) => rewindFace(p, ctx, name),
    columnsOf: (tables) => columnsOfFace(p, tables),
    lag: (name) => lagFace(p, name),
    lags: () => lagsFace(p),
    tasks: (query) => tasksFace(p, query),
    taskProjects: (query) => taskProjectsFace(p, query),
    backlog: (query) => backlogFace(p, query),
    spend: (query) => spendFace(p, query),
    ticketReport: (query) => ticketReportFace(p, query),
    landed: (query) => landedFace(p, query),
    close: () => closeFace(p),
  }
}
