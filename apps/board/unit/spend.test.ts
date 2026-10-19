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
  totalBill,
  unknownBill,
  withNoSpendFallback,
  type RateCard,
} from '../src/lib/spend.ts'

function row(over: Partial<SpendRow> = {}): SpendRow {
  return {
    seq: '1',
    at: new Date('2026-09-10T00:00:00Z'),
    streamId: 'run-1',
    ticket: 'wi-pin-1',
    project: 'pin',
    pass: 'run-1',
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
   * A ticket like `wi-lingtai-89` whose runs predate `RunSpent`: `billOf`
   * folds its (empty) rows to five empty bills, which reads as nothing spent
   * rather than as unknown. `withNoSpendFallback` is the one place every
   * reader (the card, `/spend`'s ledger) takes that fallback, credited to
   * Work since neither carries a per-attempt repair flag to split it by.
   */
  it('credits Work with one unknown run per attempt when spend has nothing at all', () => {
    const bills = withNoSpendFallback(billOf([]), 2)
    expect(bills.Work).toEqual({ reportedCents: 0, reportedRuns: 0, estimates: [], unknown: 2 })
    expect(bills.Answering).toEqual(emptyBill())
  })

  it('does nothing for a ticket that never ran', () => {
    expect(withNoSpendFallback(billOf([]), 0)).toEqual(billOf([]))
  })

  it('does nothing when any purpose already has reported or unknown data', () => {
    const bills = billOf([row({ purpose: 'Judge', round: null, costUsd: 1 })])
    expect(withNoSpendFallback(bills, 3)).toBe(bills)
  })
})
