import type { Step } from './vocabulary.ts'

/**
 * How long each step took, in milliseconds, from an attempt's own events: a
 * `StepStarted` paired with the next `StepEnded` for the same step. The latest
 * completed pair wins — after a fix round an earlier round's review time
 * describes a verdict since replaced. A step with no completed pair (in flight,
 * or `claim`, which writes no step events) has no entry. Read-only: this is not
 * part of the attempt reducer, so the snapshots it versions are untouched.
 */
export function stepDurationsMs(
  events: readonly { type: string; at: Date; data: unknown }[],
): Partial<Record<Step, number>> {
  const started = new Map<string, number>()
  const out: Partial<Record<Step, number>> = {}
  for (const e of events) {
    if (e.type === 'StepStarted') {
      const step = (e.data as { step?: string }).step
      if (step !== undefined) started.set(step, e.at.getTime())
    } else if (e.type === 'StepEnded') {
      const step = (e.data as { outcome?: { step?: string } }).outcome?.step
      const from = step === undefined ? undefined : started.get(step)
      if (step === undefined || from === undefined) continue
      started.delete(step)
      const ms = e.at.getTime() - from
      if (Number.isFinite(ms) && ms >= 0) out[step as Step] = ms
    }
  }
  return out
}
