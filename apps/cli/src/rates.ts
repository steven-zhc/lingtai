/**
 * Starts the daily price fetch (#658) from the two processes that hold the
 * conductor lock, `lingtai start` and `lingtai run`. Nothing else fetches:
 * `lingtai init` only reads the snapshot. Fire and forget — a pass never waits
 * on it — but each conductor awaits `ratesSettled()` before it lets go of the
 * lock, so the one write lands inside the one-writer window.
 */
import { ratesDue, realRatePorts, refreshRates } from '@lingtai/conductor/rate-snapshot'
import { readSpend } from '@lingtai/projector'

/** The `(model, runtime)` pairs of runs that reported no dollars of their own. */
export async function modelsSeenInSpend(): Promise<{ model: string; runtime: string }[]> {
  const seen = new Map<string, { model: string; runtime: string }>()
  for (const row of await readSpend()) {
    if (row.costUsd !== null) continue
    for (const entry of row.usage) {
      if (entry.model !== undefined)
        seen.set(`${row.runtime}\0${entry.model}`, { model: entry.model, runtime: row.runtime })
    }
  }
  return [...seen.values()]
}

/** Starts a refresh if one is due. Never throws and is not awaited. */
export function startRates(now: Date = new Date()): void {
  if (!ratesDue(now)) return
  void refreshRates(realRatePorts(modelsSeenInSpend))
}
