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
import { readSpend } from '@lingtai/projector'

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

/** Starts a refresh if one is due. Never throws and is not awaited. */
export function startRates(now: Date = new Date()): void {
  if (!ratesDue(now)) return
  void refreshRates(realRatePorts(modelsSeenInSpend)).catch(() => {})
}
