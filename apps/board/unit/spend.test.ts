import type { SpendRow } from '@lingtai/projector'
/**
 * `billOf` and `billText`, the one classifier and one formatter every reader
 * of `spend` goes through (`#498`).
 */
import { describe, expect, it } from 'vitest'

import {
  addBill,
  billHasAny,
  billOf,
  billText,
  emptyBill,
  PURPOSES,
  spendChip,
  totalBill,
  unknownBill,
  withNoSpendFallback,
  type RateCard,
} from '../src/lib/spend.ts'

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    seq: '1',
    at: new Date('2026-09-10T00:00:00Z'),
    streamId: 'pass-1',
    ticket: 'ticket-pin-1',
    project: 'pin',
    pass: 'pass-1',
    purpose: 'Action',
    step: 'proposed',
    action: 'build',
    round: 0,
    runtime: 'claude-code',
    turns: 1,
    durationMs: 1000,
    costUsd: 0.1,
    usage: [],
    ...over,
  }
}

describe('billOf sorts every row into exactly one of five purposes', () => {
  it('puts an Action at round 0 in Work', () => {
    const bills = billOf([row({ round: 0, costUsd: 1.0 })])
    expect(bills.Work.reportedCents).toBe(100)
    expect(bills.Answering.reportedRuns).toBe(0)
  })

  it('puts an Action at round 1 or above in Answering, never in Work', () => {
    const bills = billOf([row({ round: 1, costUsd: 2.0 }), row({ round: 3, costUsd: 0.5 })])
    expect(bills.Work.reportedRuns).toBe(0)
    expect(bills.Answering.reportedCents).toBe(250)
  })

  /**
   * `#506`'s own failure scenario: a pass that buys no fix round at all still
   * writes an `implement` and a `review` `RunSpent` at round 0, and both must
   * sum into Work rather than the second overwriting the first — the bug a
   * `task_view.repair_costs` column (keyed `run#fix0`) had, and `spend` never
   * did, because `billOf` sums rather than assigns.
   */
  it('sums every round-0 Action rather than letting one overwrite another', () => {
    const bills = billOf([
      row({ action: 'write the change', round: 0, costUsd: 0.42 }),
      row({ action: 'reviewer', round: 0, costUsd: 1.25 }),
    ])
    expect(bills.Answering.reportedCents).toBe(0)
    expect(bills.Work.reportedCents).toBe(167)
  })

  it('puts Judge, Triage and Discussion in their own purpose, untouched by round', () => {
    const judge = billOf([row({ purpose: 'Judge', round: null, costUsd: 1.5 })])
    const triage = billOf([row({ purpose: 'Triage', round: null, costUsd: 0.75 })])
    const discussion = billOf([row({ purpose: 'Discussion', round: null, costUsd: 0.25 })])
    expect(judge.Judge.reportedCents).toBe(150)
    expect(triage.Triage.reportedCents).toBe(75)
    expect(discussion.Discussion.reportedCents).toBe(25)
  })

  it('counts every purpose at once, each in its own bucket', () => {
    const bills = billOf([
      row({ purpose: 'Action', round: 0, costUsd: 1 }),
      row({ purpose: 'Action', round: 1, costUsd: 1 }),
      row({ purpose: 'Judge', round: null, costUsd: 1 }),
      row({ purpose: 'Triage', round: null, costUsd: 1 }),
      row({ purpose: 'Discussion', round: null, costUsd: 1 }),
    ])
    for (const p of PURPOSES) expect(bills[p].reportedRuns).toBe(1)
  })
})

describe('billOf splits a row into reported, estimated or unknown', () => {
  it('counts a row with a reported figure as reported, rounded to the cent once', () => {
    const bills = billOf([row({ costUsd: 0.1 }), row({ costUsd: 0.2 })])
    expect(bills.Work).toEqual({ reportedCents: 30, reportedRuns: 2, estimates: [], unknown: 0 })
  })

  it('counts a row with no reported figure and no rate card as unknown, never as $0', () => {
    const bills = billOf([row({ costUsd: null })])
    expect(bills.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 1 })
  })

  it('prices a row with no reported figure through an injected rate card, never into reportedCents', () => {
    const price: RateCard = (r) => (r.runtime === 'codex' ? 0.42 : null)
    const bills = billOf([row({ costUsd: null, runtime: 'codex' })], price)
    expect(bills.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [0.42], unknown: 0 })
  })

  it('defaults to no rate card, so #208 having not shipped never invents a price', () => {
    const bills = billOf([row({ costUsd: null })])
    expect(bills.Work.estimates).toEqual([])
    expect(bills.Work.unknown).toBe(1)
  })
})

describe('addBill and totalBill', () => {
  it('adds two bills field by field', () => {
    const a = { reportedCents: 100, reportedRuns: 1, estimates: [0.5], unknown: 2 }
    const b = { reportedCents: 50, reportedRuns: 1, estimates: [0.25], unknown: 1 }
    expect(addBill(a, b)).toEqual({ reportedCents: 150, reportedRuns: 2, estimates: [0.5, 0.25], unknown: 3 })
  })

  it('folds every purpose into one bill', () => {
    const bills = billOf([
      row({ round: 0, costUsd: 1 }),
      row({ round: 1, costUsd: 2 }),
      row({ purpose: 'Judge', round: null, costUsd: 3 }),
    ])
    expect(totalBill(bills)).toEqual({ reportedCents: 600, reportedRuns: 3, estimates: [], unknown: 0 })
  })

  it('an empty bill totals to nothing', () => {
    expect(totalBill(billOf([]))).toEqual(emptyBill())
  })
})

describe('billText renders the one table every reader shows', () => {
  it('says "—" for a bill with nothing reported and nothing unknown', () => {
    expect(billText(emptyBill())).toBe('—')
  })

  it('says a zero estimate rather than nothing for a priced row', () => {
    expect(billText({ ...emptyBill(), estimates: [0] })).toBe('~$0.00 est.')
  })

  it('says the dollar figure for a bill with only reported rows', () => {
    expect(billText(billOf([row({ costUsd: 3.1 })]).Work)).toBe('$3.10')
  })

  it('says the figure plus the unknown count, never $0.00, when both are present', () => {
    const bills = billOf([row({ costUsd: 3.1 }), row({ costUsd: null })])
    const text = billText(bills.Work)
    expect(text).toBe('$3.10 + 1 unknown')
    expect(text).not.toContain('$0.00')
  })

  it('says unknown rather than $0.00 when nothing at all was reported', () => {
    const bills = billOf([row({ costUsd: null }), row({ costUsd: null })])
    const text = billText(bills.Work)
    expect(text).toBe('unknown (2 runs)')
    expect(text).not.toContain('$0.00')
  })

  it('adds an estimate after the figure and never into it', () => {
    const price: RateCard = () => 0.5
    const bills = billOf([row({ costUsd: 3.1 }), row({ costUsd: null })], price)
    expect(billText(bills.Work)).toBe('$3.10 ~$0.50 est.')
  })

  /**
   * A row with no reported figure and no unknown count — every row priced by
   * the rate card — used to fall through `billText`'s first two arms and hit
   * the `—` meant for a bill with nothing in it at all, dropping a priced run
   * on the floor: `billHasAny` agreed, since it only asked about `reportedRuns`
   * and `unknown`, so the pill that would have shown it never rendered either.
   */
  it('shows the estimate alone when nothing was reported and nothing is unknown', () => {
    const price: RateCard = () => 0.42
    const bills = billOf([row({ costUsd: null })], price)
    expect(bills.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [0.42], unknown: 0 })
    expect(billText(bills.Work)).toBe('~$0.42 est.')
    expect(billHasAny(bills.Work)).toBe(true)
  })
})

describe('unknownBill and withNoSpendFallback', () => {
  it('unknownBill credits unknown runs and nothing else', () => {
    expect(unknownBill(2)).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 2 })
  })

  /**
   * A ticket like `ticket-lingtai-89` whose runs predate `RunSpent`: `billOf`
   * folds its (empty) rows to five empty bills, which reads as nothing spent
   * rather than as unknown. `withNoSpendFallback` is the one place every
   * reader (the card, `/spend`'s ledger) takes that fallback, credited to
   * Work since neither carries a per-attempt repair flag to split it by.
   */
  it('credits Work with one unknown run per attempt when spend has nothing at all', () => {
    const bills = withNoSpendFallback(billOf([]), 2, [])
    expect(bills.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 2 })
    expect(bills.Answering).toEqual(emptyBill())
  })

  it('does nothing for a ticket that never ran', () => {
    expect(withNoSpendFallback(billOf([]), 0, [])).toEqual(billOf([]))
  })

  /**
   * The old test here asserted the opposite — that a `Judge` row with no
   * `Action` row beside it made the fallback a no-op — which was the bug
   * (`#498`'s review): a ticket with 3 attempts and only a `Judge` row has
   * contributed *no* `Action` row for *any* attempt, so all three are still
   * unaccounted, regardless of Judge having data of its own.
   */
  it('still credits every unaccounted attempt when another purpose already has data', () => {
    const rows = [row({ purpose: 'Judge', pass: null, round: null, costUsd: 1 })]
    const bills = withNoSpendFallback(billOf(rows), 3, rows)
    expect(bills.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 3 })
    expect(bills.Judge.reportedCents).toBe(100)
  })

  /**
   * One attempt (`pass-1`) reported an `Action` row; the other (`pass-2`) did
   * not. The straddling case the review named: a ticket whose later attempt
   * appended `RunSpent` and whose earlier one did not must still show the
   * earlier one as unknown, not silently accounted for by the later one.
   */
  it('credits only the attempts with no Action row of their own, when some attempts do have one', () => {
    const rows = [row({ pass: 'pass-1', round: 0, costUsd: 1 })]
    const bills = withNoSpendFallback(billOf(rows), 2, rows)
    expect(bills.Work).toEqual({ reportedCents: 100, reportedRuns: 1, estimates: [], unknown: 1 })
  })

  it('does nothing when every attempt already has its own Action row', () => {
    const rows = [row({ pass: 'pass-1', round: 0, costUsd: 1 }), row({ pass: 'pass-2', round: 1, costUsd: 0.5 })]
    const bills = billOf(rows)
    expect(withNoSpendFallback(bills, 2, rows)).toEqual(bills)
  })

  /**
   * `#509`'s own arithmetic: a continuation's `Action` rows carry the same
   * `pass` as the attempt they continue, so `accounted` stays 1 across both
   * approvals. The bug was `task_view.attempts` reading 2 for this ticket —
   * fixed in the fold, not here — so this pins that the fallback would have
   * added a phantom unknown run had the count stayed wrong.
   */
  it('adds no unknown run when attempts agrees with the one pass that reported, but does once attempts over-counts', () => {
    const rows = [row({ pass: 'pass-A', round: 0, costUsd: 4.21 })]
    const bills = billOf(rows)
    expect(withNoSpendFallback(bills, 1, rows)).toEqual(bills)
    expect(withNoSpendFallback(bills, 2, rows).Work).toEqual({
      reportedCents: 421,
      reportedRuns: 1,
      estimates: [],
      unknown: 1,
    })
  })
})

describe('spendChip', () => {
  /**
   * `loadBoard`'s empty-tasks path never attempts the fold, so it has no lag
   * to report — a fact that used to be indistinguishable from a fold that ran
   * and could not read its lag, which sent an operator to rebuild a
   * projection nothing had asked anything of (`#498`'s review).
   */
  it('reads a skipped fold as nothing spent, never as a failure', () => {
    const chip = spendChip({ lag: null, skipped: true })
    expect(chip).toMatchObject({ current: true, tone: 'idle', label: 'nothing spent' })
    expect(chip.title).not.toContain('rebuild')
  })

  it('still reads a bare null lag as a failure, when the fold was not skipped', () => {
    const chip = spendChip({ lag: null })
    expect(chip).toMatchObject({ current: false, tone: 'warn', label: 'unknown' })
  })
})
