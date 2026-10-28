/**
 * Starts the daily price fetch (#658) from the two processes that hold the
 * conductor lock, `lingtai start` and `lingtai run`. Nothing else fetches:
 * `lingtai init` only reads the snapshot. Fire and forget — a pass never waits
 * on it — but each conductor awaits `ratesSettled()` before it lets go of the
 * lock, so the one write lands inside the one-writer window.
 */
import { currentRecipe, loadProjects } from '@lingtai/conductor'
import { ratesDue, realRatePorts, refreshRates } from '@lingtai/conductor/rate-snapshot'
import { LITELLM_PROVIDER } from '@lingtai/domain/rate-card'
import {
  createProjectionRunner,
  readSpend,
  spendProjection,
  ticketReportProjection,
  type ProjectionLag,
} from '@lingtai/projector'

import { holdLiveSpend } from './projector.ts'

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
export async function modelsSeenInSpend(): Promise<{ model: string; runtime: string }[]> {
  const seen = new Map<string, { model: string; runtime: string }>()
  for (const state of await loadProjects()) {
    try {
      for (const m of modelsInRecipe((await currentRecipe(state)).recipe)) seen.set(`${m.runtime}\0${m.model}`, m)
    } catch {
      // A recipe that will not resolve names no model; the pass says why.
    }
  }
  for (const row of await readSpend()) {
    if (row.costUsd !== null) continue
    for (const entry of row.usage) {
      if (entry.model !== undefined)
        seen.set(`${row.runtime}\0${entry.model}`, { model: entry.model, runtime: row.runtime })
    }
  }
  return [...seen.values()]
}

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

/** Rebuilds what stores estimates through the runner `lingtai projection rebuild` uses. */
export async function rebuildEstimates(priced: string[]): Promise<string> {
  const { log } = await import('@lingtai/event-store')
  const { rebuildProjection } = await import('./projection.ts')
  const lines: string[] = []
  const mine = { settled: false }
  hold = mine
  rebuildsBegun += 1
  // The live `spend` subscriber in this process shares the checkpoint the
  // rebuild rewinds; left running it could commit a new event and carry the
  // checkpoint to the head before the rebuild's replay reads where to start.
  let resume = async () => {}
  try {
    resume = await holdLiveSpend()
    for (const projection of ESTIMATE_PROJECTIONS) {
      await rebuildProjection({
        name: projection.name,
        queries: log.queries,
        runnerFor: () => createProjectionRunner({ projection }),
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      })
    }
  } finally {
    await resume()
    mine.settled = true
  }
  return `priced ${priced.join(', ')}; ${lines.join('; ')}`
}

/** Starts a refresh if one is due. Never throws and is not awaited. */
export function startRates(now: Date = new Date()): void {
  if (!ratesDue(now)) return
  void refreshRates(realRatePorts(modelsSeenInSpend, process.env, rebuildEstimates)).catch(() => {})
}
