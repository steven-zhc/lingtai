import { STEPS, flakyEntryOf, isFlakyFinding } from '@lingtai/domain'

import type { StepVerdict } from './task'

/** One step of the landing line: `build ✓`, or `review ✓ on f3fa0b6`. */
export interface LandingItem {
  step: string
  ok: boolean
  /** The first action's state that was not `passed`; `passed` when `ok`. */
  state: string
  /** Only when it is not the attempt's head. */
  onSha: string | null
}

/** What the line under base/head says: what landed and on which sha its checks passed. */
export interface LandingLine {
  merge: string
  items: LandingItem[]
  flaky: { count: number; tests: string[] }
}

/** The line's parts from the landing attempt's verdicts, its head and the lifecycle's merge commit. */
export function landingLineOf(input: {
  steps: readonly StepVerdict[]
  headSha: string | null
  mergeCommit: string
}): LandingLine {
  const from = STEPS.indexOf('build')
  const byStep = new Map<string, StepVerdict[]>()
  for (const s of input.steps) {
    if (s.state === 'running') continue
    const at = s.step.indexOf(':')
    const name = at < 0 ? s.step : s.step.slice(0, at)
    const rank = STEPS.indexOf(name as (typeof STEPS)[number])
    if (rank < from) continue
    byStep.set(name, [...(byStep.get(name) ?? []), s])
  }
  const items: LandingItem[] = [...byStep.entries()]
    .sort(([a], [b]) => STEPS.indexOf(a as (typeof STEPS)[number]) - STEPS.indexOf(b as (typeof STEPS)[number]))
    .map(([step, actions]) => {
      const failed = actions.find((a) => a.state !== 'passed')
      const shas = actions.map((a) => a.onSha)
      const differing = shas.every((s) => s !== null) ? shas.find((s) => s !== input.headSha) : undefined
      return {
        step,
        ok: failed === undefined,
        state: failed?.state ?? 'passed',
        onSha: differing ?? null,
      }
    })
  const tests: string[] = []
  for (const [step, actions] of byStep) {
    if (step !== 'build') continue
    for (const a of actions)
      for (const f of a.findings)
        if (isFlakyFinding(f as Parameters<typeof isFlakyFinding>[0])) tests.push(flakyEntryOf(f.claim) ?? f.claim)
  }
  return { merge: input.mergeCommit, items, flaky: { count: tests.length, tests } }
}
