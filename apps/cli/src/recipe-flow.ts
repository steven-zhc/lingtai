/** Presentation of the completed project list. */
import { type RateRow, shipped } from '@lingtai/domain/rate-card'
import { summariseRecipe, type Summary } from '@lingtai/setup'

import type { RecipeChanged } from './project-support.ts'
import type { LeftBehind } from './setup-card.ts'

export { summariseRecipe }

/**
 * The lines that say which chosen models have no price yet (#693). A hint about
 * what this machine knows now, never a verdict: `init` does not fetch (#658).
 */
export function priceHints(models: Summary['models'], snapshot: readonly unknown[] | null): string[] {
  const lines: string[] = []
  const unreadable = snapshot === null
  const priced = (model: string) =>
    (snapshot ?? []).some((r) => typeof r === 'object' && r !== null && (r as Partial<RateRow>).model === model)
  const named = new Set<string>()
  for (const { model } of models) {
    if (model === null || named.has(model)) continue
    named.add(model)
    if (shipped(model) || priced(model)) continue
    lines.push(
      `${model} is not priced yet — the shipped rate card does not list it and no fetched price for it is on this machine${unreadable ? ' (the fetched-price snapshot there could not be read)' : ''}. The conductor fetches prices when it starts; check \`lingtai doctor\` after the first run.`,
    )
  }
  if (models.some((m) => m.model === null)) {
    lines.push('A role with no model is priced by the model its runtime reports on the first run.')
  }
  return lines
}

/**
 * The card's lines for what a GitHub rerun changed (#1474). The commits come from the caller's `commitsOnlyIn`
 * port (a GitHub compare); where that port is absent or could not read, the line gives the command that prints them.
 */
export function changedLeftBehind(changed: RecipeChanged | undefined, slug?: string): LeftBehind[] {
  const out: LeftBehind[] = []
  const listing = (commits: string[] | null | undefined, command: string): string =>
    commits === undefined || commits === null
      ? `the commits could not be read — ${command} lists them`
      : commits.length === 0
        ? 'none'
        : `${commits.length} commit${commits.length === 1 ? '' : 's'}: ${commits.join(' · ')}`
  const m = changed?.mode
  if (m !== undefined && m.from === 'team' && m.to === 'solo' && m.personal !== undefined) {
    // Written only because no draft held a ticket and no PR was open (0130 §1), so nothing is waiting to reach main.
    out.push({ what: `${m.personal} was left as it is — nothing on it is waiting to reach ${m.main ?? 'main'}` })
  }
  const b = changed?.branch
  if (b !== undefined) {
    if (b.made) {
      const from = b.madeFrom ?? b.from
      out.push({
        what:
          from === b.from
            ? `${b.to} was made from origin/${b.from} — ${b.from} is kept and may be deleted`
            : `${b.to} was made from origin/${from} — ${b.from} is not on GitHub, so it could not be the source, and was left as it is`,
      })
    } else {
      const command = `git log --oneline origin/${b.to}..origin/${b.from}`
      out.push({
        what:
          `${b.to} existed and was left as it was — the commits only ${b.from} has: ${listing(b.commits, command)}` +
          (slug === undefined ? '' : ` — https://github.com/${slug}/compare/${b.to}...${b.from}`),
        command,
      })
    }
  }
  return out
}
