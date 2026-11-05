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
    /** `actions` is null where no plan is known at all, which is not the same as a step with nothing in it. */
    | { kind: 'step'; step: Step; actions: string[] | null }
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
  const anyPlan = run.progress?.planKnown ?? steps.some((p) => p.planned.length > 0)
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
    line = { kind: 'step', step: now.step, actions: anyPlan ? planned(now.step) : null }
  }

  // After the step in flight. With none in flight, after the leading run of
  // steps that are done in spine order: `findLast` would name the furthest step
  // that ever ran, and a refused review from an earlier round sits beyond the
  // implement a fix round just finished.
  let anchor: Step | undefined = now?.step
  if (anchor === undefined) {
    // A verdict made against a head that has since moved is the last round's:
    // that step runs again, so it is not done (`AttemptView.steps[].stale`).
    // Judged by the verdict's own sha, not by whether a refusal still stands,
    // so a step that has passed again on the new head counts.
    const stale = new Set((run.steps ?? []).filter((v) => v.stale).map((v) => v.step.slice(0, v.step.indexOf(':'))))
    for (const p of steps) {
      if ((p.state === 'passed' || p.state === 'skipped' || p.state === 'waived') && !stale.has(p.step)) anchor = p.step
      else break
    }
  }
  const after = anchor === undefined ? -1 : STEPS.indexOf(anchor)
  const left = STEPS.filter((s, i) => i > after && planned(s).length > 0)

  return {
    head: { label: 'Running', step: now?.step ?? null, round: fix ? now!.round : null },
    line,
    ask: 'Nothing is needed from you.',
    then: anyPlan ? left : null,
  }
}
