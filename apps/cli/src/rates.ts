/**
 * Starts the daily price fetch (#658) from the two processes that hold the
 * conductor lock, `lingtai start` and `lingtai run`. Nothing else fetches:
 * `lingtai init` only reads the snapshot. Fire and forget — a pass never waits
 * on it — but each conductor yields `ratesSettled` before it lets go of the
 * lock, so the one write lands inside the one-writer window.
 */
import { currentRecipeEffect, loadProjectsEffect } from '@lingtai/conductor/projects'
import { ratesDue, realRatePorts, refreshRates } from '@lingtai/conductor/rate-snapshot'
import { LITELLM_PROVIDER } from '@lingtai/domain/rate-card'
import {
  makeRunner,
  readSpendEffect,
  spendProjection,
  ticketReportProjection,
  type ProjectionLag,
} from '@lingtai/projector'
import { Effect, type Scope } from 'effect'

import { recovering } from './exit.ts'
import { holdLiveSpend } from './live-spend.ts'

/** Every `model:` a recipe names, with the runtime beside it (its own `agent:`, else `runtime.agent`). */
export function modelsInRecipe(recipe: unknown): { model: string; runtime: string }[] {
  const found: { model: string; runtime: string }[] = []
  const fallback = (recipe as { runtime?: { agent?: string } } | null)?.runtime?.agent ?? 'claude-code'
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return
    if (Array.isArray(node)) return node.forEach(walk)
    const o = node as Record<string, unknown>
    if (typeof o['model'] === 'string') {
      // A block names its runtime by `agent:`, or by `judge:` when the judge is a runtime.
      const named = [o['agent'], o['judge']].find((v): v is string => typeof v === 'string' && v in LITELLM_PROVIDER)
      const agent = named ?? fallback
      found.push({ model: o['model'], runtime: agent })
    }
    Object.values(o).forEach(walk)
  }
  walk(recipe)
  return found
}

/** The `(model, runtime)` pairs of runs that reported no dollars of their own, and of every project's recipe. */
export const modelsSeenInSpend = (): Effect.Effect<{ model: string; runtime: string }[], unknown> =>
  Effect.gen(function* () {
    const seen = new Map<string, { model: string; runtime: string }>()
    for (const state of yield* loadProjectsEffect()) {
      yield* currentRecipeEffect(state).pipe(
        Effect.map((resolved) => {
          for (const m of modelsInRecipe(resolved.recipe)) seen.set(`${m.runtime}\0${m.model}`, m)
        }),
        // A recipe that will not resolve names no model; the pass says why.
        recovering(() => Effect.void),
      )
    }
    for (const row of yield* readSpendEffect()) {
      if (row.costUsd !== null) continue
      for (const entry of row.usage) {
        if (entry.model !== undefined)
          seen.set(`${row.runtime}\0${entry.model}`, { model: entry.model, runtime: row.runtime })
      }
    }
    return [...seen.values()]
  })

/**
 * The projections that store an estimate (0110 §5): `spend` and `ticket_report` (0123).
 */
const ESTIMATE_PROJECTIONS = [spendProjection, ticketReportProjection] as const

/**
 * Set while `spend` is being rebuilt, and lifted only by a reading of no lag
 * after the rebuild settled, not by the rebuild promise: a rebuild that threw
 * partway leaves a partial table under a recent checkpoint. In-process on
 * purpose: only the conductor-lock holder refreshes and it is also the one that
 * asks the ceiling. A `lingtai status` elsewhere may briefly print a low figure;
 * it takes no work.
 */
let hold: { settled: boolean } | null = null
let rebuildsBegun = 0

/** Counts the rebuilds begun, so a check that spans an `await` can tell one began under it. */
export function spendRebuilds(): number {
  return rebuildsBegun
}

export function spendRebuildHold(lags: readonly ProjectionLag[]): string | null {
  if (hold === null) return null
  if (hold.settled && lags.find((l) => l.name === 'spend')?.lag === 0n) {
    hold = null
    return null
  }
  return hold.settled
    ? 'the spend projection is not caught up after a rebuild — run `lingtai projection rebuild spend`'
    : 'the spend projection is being rebuilt after a model was priced'
}

/**
 * Rebuilds what stores estimates through the runner `lingtai projection rebuild` uses.
 *
 * **Every runner is detached** (`makeRunner`'s `detached`): this runs in a refresh's fiber, which
 * ends when the refresh does, and `resume` restarts the live `spend` runners from inside it. A
 * runner that fiber owned would be closed with it and `spend` would stop following after every
 * price change.
 */
export const rebuildEstimates = (priced: string[]): Effect.Effect<string, unknown> =>
  Effect.gen(function* () {
    // Not loaded in the daemon until a price changes.
    const { processQueries } = yield* Effect.promise(() => import('@lingtai/event-store'))
    const { rebuildProjection } = yield* Effect.promise(() => import('./projection.ts'))
    const queries = yield* processQueries
    const lines: string[] = []
    const mine = { settled: false }
    hold = mine
    rebuildsBegun += 1
    // The live `spend` subscriber in this process shares the checkpoint the
    // rebuild rewinds; left running it could commit a new event and carry the
    // checkpoint to the head before the rebuild's replay reads where to start.
    yield* Effect.acquireUseRelease(
      holdLiveSpend(),
      () =>
        Effect.forEach(
          ESTIMATE_PROJECTIONS,
          (projection) =>
            rebuildProjection({
              name: projection.name,
              queries,
              runnerFor: () => makeRunner({ projection }, { detached: true }),
              log: (line) => lines.push(line),
              error: (line) => lines.push(line),
            }),
          { discard: true },
        ),
      (resume) => resume,
    ).pipe(
      // After `resume`, and on every exit including one before anything was held.
      Effect.ensuring(
        Effect.sync(() => {
          mine.settled = true
        }),
      ),
    )
    return `priced ${priced.join(', ')}; ${lines.join('; ')}`
  })

/**
 * Starts a refresh if one is due. Never fails and is not awaited. The refresh is a fiber of the caller's
 * `Scope`: it outlives the pass that asked, `ratesSettled` is what waits for it, and closing the scope — or
 * interrupting whoever owns it — interrupts it.
 */
export const startRates = (now: Date = new Date()): Effect.Effect<void, never, Scope.Scope> =>
  ratesDue(now)
    ? Effect.forkScoped(refreshRates(realRatePorts(modelsSeenInSpend, process.env, rebuildEstimates)), {
        startImmediately: true,
      }).pipe(Effect.asVoid)
    : Effect.void
