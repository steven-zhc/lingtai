import { inWords } from '@lingtai/conductor/queue'
import { SEVERITIES, STEPS, type Finding, type Step } from '@lingtai/domain'
import type { SpendRow } from '@lingtai/projector'

import { billOf, billText, grantedOf, spendChip, totalBill, type SpendCurrency } from './spend.ts'
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
  round: { since: string; budget: string | null; of: string | null } | null
  attempt: { since: string; turns: string; ceiling: string | null; behind: string | null }
  cost: { text: string; ceiling: string | null; behind: string | null }
}

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
  /** Null where the caller had no spend or recipe to measure against. */
  meters: RunningMeters | null
  /**
   * The tags the agent's prose is filed under in the phase in flight: null is the
   * implementer's own, untagged. Empty when nothing is in flight or no plan is known.
   * **A judge is not named** — it writes `judge:<when>` at `proposed`, which the plan
   * names by entry and not by `when`, so while one decides nothing is quoted.
   */
  said: readonly (string | null)[]
}

const stepOfKey = (key: string): string => key.slice(0, key.indexOf(':') === -1 ? undefined : key.indexOf(':'))

const worstFirst = (findings: readonly Finding[]): Finding[] =>
  [...findings].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))

function metersOf(run: AttemptView, ctx: RunningContext): RunningMeters | null {
  const progress = run.progress
  if (progress === null || progress === undefined) return null
  const now = progress.now
  const stepNow = run.stepNow

  let of: string | null = null
  if (stepNow !== null && stepNow.step === 'implement' && stepNow.round > 0) {
    const n = stepNow.round
    of = grantedOf(ctx.rows).some((g) => g.round === n)
      ? `round ${n}, granted`
      : ctx.rounds === null || ctx.rounds <= 0
        ? `round ${n}`
        : `round ${n} of ${ctx.rounds}`
  }

  const chip = spendChip(ctx.currency)
  const behind = chip.current ? null : chip.label
  const turns = ctx.rows.reduce((a, r) => a + r.turns, 0)
  const limits = run.limits
  return {
    runId: run.runId,
    round: now === null ? null : { since: now.since, budget: now.budgetMs === null ? null : inWords(now.budgetMs), of },
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

export function runningPanelOf(run: AttemptView, ctx: RunningContext | null): RunningPanelView {
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
    meters: ctx === null ? null : metersOf(run, ctx),
    said:
      now === null
        ? []
        : fix
          ? [`fix:${now.round}`]
          : now.step === 'implement'
            ? [null]
            : planned(now.step).map((a) => `${now.step}:${a}`),
  }
}
