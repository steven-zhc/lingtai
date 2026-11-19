import { inWords } from '@lingtai/conductor/queue'
import { SEVERITIES, stepDurationsMs, type Envelope, type Finding, type Step } from '@lingtai/domain'
import type { SpendRow } from '@lingtai/projector'

import { billOf, billText, spendChip, totalBill, type SpendCurrency } from './spend.ts'
import type { RunningWatch } from './stuck.ts'
import type { AttemptView } from './task.ts'

/** What only the caller that has read `spend` and the recipe can hand in. */
export interface RunningContext {
  rows: readonly SpendRow[]
  currency: SpendCurrency
  /** The recipe's rounds ceiling; null when unreadable. */
  rounds: number | null
}

/**
 * The three meters (#916): words, plus the ISO instants the clocks count from.
 * **The ceilings are for one agent run, never the attempt** (0118 §2).
 */
export interface RunningMeters {
  runId: string
  /** The phase against its wall limit. Null between steps. */
  round: { since: string; budget: string | null } | null
  attempt: { since: string; turns: string; ceiling: string | null; behind: string | null }
  cost: { text: string; ceiling: string | null; behind: string | null }
}

/** A running ticket's panel, as the page draws it (0118 §2). Pure: events in, words out. */
export interface RunningPanelView {
  /** `Running`, the step, and `refusal fix N` — in that order. */
  head: { label: string; step: Step | null; round: number | null }
  /** What this step is doing. */
  line:
    | { kind: 'fixing'; text: string; findings: Finding[]; evidence: null }
    | { kind: 'refused'; text: string; findings: Finding[]; evidence: string | null }
    /** `actions` is null where no plan is known at all, which is not the same as a step with nothing in it. */
    | { kind: 'step'; step: Step; actions: string[] | null }
    | { kind: 'between' }
  /** Null where the caller had no spend or recipe to measure against. */
  meters: RunningMeters | null
  /**
   * The tags the agent's prose is filed under in the phase in flight: null is the
   * implementer's own, untagged. Empty when nothing is in flight or no plan is known.
   * **A judge is not named** — it writes `judge:<when>` at `proposed`, which the plan
   * names by entry and not by `when`, so while one decides nothing is quoted.
   */
  said: readonly (string | null)[]
  /** What `stuckOf` reads (#918). Null where the caller had no stream to take the newest event from. */
  watch: RunningWatch | null
  /** How long each finished step took, in words — the latest completed visit of each. Absent where no steps were read. */
  stepTimes: Partial<Record<Step, string>>
}

/** The time each finished step took, in words (`stepDurationsMs` pairs the events). */
export function stepTimesOf(
  events: readonly { type: string; at: Date; data: unknown }[],
): Partial<Record<Step, string>> {
  const out: Partial<Record<Step, string>> = {}
  for (const [step, ms] of Object.entries(stepDurationsMs(events)) as [Step, number][]) out[step] = inWords(ms)
  return out
}

const stepOfKey = (key: string): string => key.slice(0, key.indexOf(':') === -1 ? undefined : key.indexOf(':'))

const worstFirst = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))

function metersOf(run: AttemptView, ctx: RunningContext): RunningMeters | null {
  const progress = run.progress
  if (progress === null || progress === undefined) return null
  const now = progress.now
  const chip = spendChip(ctx.currency)
  const behind = chip.current ? null : chip.label
  const turns = ctx.rows.reduce((a, r) => a + r.turns, 0)
  const limits = run.limits
  return {
    runId: run.runId,
    round: now === null ? null : { since: now.since, budget: now.budgetMs === null ? null : inWords(now.budgetMs) },
    attempt: {
      since: progress.since,
      turns: `${turns} turn${turns === 1 ? '' : 's'} in agent runs that have ended`,
      ceiling: limits?.turns === undefined ? null : `at most ${limits.turns} turns a run`,
      behind,
    },
    cost: {
      text:
        ctx.rows.length === 0 ? 'nothing billed yet: no agent run has ended' : billText(totalBill(billOf(ctx.rows))),
      ceiling: limits?.usd === undefined ? null : `at most $${limits.usd.toFixed(2)} a run`,
      behind,
    },
  }
}

export function runningPanelOf(
  run: AttemptView,
  ctx: RunningContext | null,
  lastEvent: RunningWatch['lastEvent'] = null,
  events: readonly Pick<Envelope, 'type' | 'at' | 'data'>[] = [],
): RunningPanelView {
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

  return {
    head: { label: 'Running', step: now?.step ?? null, round: fix ? now!.round : null },
    line,
    meters: ctx === null ? null : metersOf(run, ctx),
    said:
      now === null
        ? []
        : fix
          ? [`fix:${now.round}`]
          : now.step === 'implement'
            ? [null]
            : planned(now.step).map((a) => `${now.step}:${a}`),
    stepTimes: stepTimesOf(events),
    watch:
      lastEvent === null
        ? null
        : {
            runId: run.runId,
            lastEvent,
            phase:
              run.progress?.now == null ? null : { since: run.progress.now.since, budgetMs: run.progress.now.budgetMs },
            step: now?.step ?? null,
          },
  }
}
