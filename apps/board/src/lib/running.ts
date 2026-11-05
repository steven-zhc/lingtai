import { SEVERITIES, STEPS, type Finding, type Step } from '@lingtai/domain'

import type { AttemptView } from './task.ts'

/** A running ticket's panel, as the page draws it (0118 §2). Pure: events in, words out. */
export interface RunningPanelView {
  /** `Running`, the step, and `fix round N` — in that order. */
  head: { label: string; step: Step | null; round: number | null }
  /** What this step is doing. */
  line:
    | { kind: 'fixing'; text: string; findings: Finding[]; evidence: null }
    | { kind: 'refused'; text: string; findings: Finding[]; evidence: string | null }
    | { kind: 'step'; step: Step; actions: string[] }
    | { kind: 'between' }
  ask: string
  /** The steps left that the recipe puts something at. Null when no plan is recorded. */
  then: Step[] | null
}

const stepOfKey = (key: string): string => key.slice(0, key.indexOf(':') === -1 ? undefined : key.indexOf(':'))

const worstFirst = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))

export function runningPanelOf(run: AttemptView): RunningPanelView {
  const now = run.stepNow
  const steps = run.progress?.steps ?? []
  const fix = now !== null && now.step === 'implement' && now.round > 0
  const planned = (s: Step): string[] => [...(steps.find((p) => p.step === s)?.planned ?? [])]

  let line: RunningPanelView['line']
  if (now === null) {
    line = { kind: 'between' }
  } else if (fix) {
    const r = run.refusal
    const found = r === null ? [] : worstFirst(r.findings)
    if (r === null) line = { kind: 'refused', text: 'Fixing what was sent back', findings: [], evidence: null }
    else if (found.length > 0)
      line = {
        kind: 'fixing',
        text: `Fixing what ${stepOfKey(r.key)} found: ${found[0]!.claim}`,
        findings: found,
        evidence: null,
      }
    else
      line = {
        kind: 'refused',
        text: `Fixing what ${stepOfKey(r.key)} refused`,
        findings: [],
        evidence: r.evidence,
      }
  } else {
    line = { kind: 'step', step: now.step, actions: planned(now.step) }
  }

  // After the step in flight, or after the last one that ran when none is.
  const lastRan = steps.findLast((p) => p.state !== 'pending' && p.state !== 'skipped')
  const anchor = now?.step ?? lastRan?.step
  const after = anchor === undefined ? -1 : STEPS.indexOf(anchor)
  const left = STEPS.filter((s, i) => i > after && planned(s).length > 0)
  const anyPlan = steps.some((p) => p.planned.length > 0)

  return {
    head: { label: 'Running', step: now?.step ?? null, round: fix ? now!.round : null },
    line,
    ask: 'Nothing is needed from you.',
    then: anyPlan ? left : null,
  }
}
