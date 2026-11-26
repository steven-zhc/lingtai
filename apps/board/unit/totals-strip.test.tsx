import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { TotalsStrip } from '../src/app/totals-strip.tsx'
import { emptyBill } from '../src/lib/spend.ts'
import type { Totals } from '../src/lib/task.ts'

const totals = (over: Partial<Totals> = {}): Totals => ({
  attempts: 2,
  turns: 12,
  durationMs: 95_000,
  fixRounds: 1,
  inFlight: 0,
  discussions: 0,
  byPurpose: {
    Work: { ...emptyBill(), reportedCents: 310, reportedRuns: 1 },
    Answering: { ...emptyBill(), reportedCents: 50, reportedRuns: 1 },
    Judge: emptyBill(),
    Triage: emptyBill(),
    Discussion: emptyBill(),
    PR: emptyBill(),
  },
  ...over,
})
const draw = (t: Totals, over: Partial<Parameters<typeof TotalsStrip>[0]> = {}) =>
  renderToStaticMarkup(
    <TotalsStrip
      totals={t}
      firstClaimAt="2026-11-25T05:03:00Z"
      state="landed"
      since="2026-11-25T05:12:00Z"
      spend={{ current: true, label: '' }}
      now={Date.parse('2026-11-25T06:00:00Z')}
      {...over}
    />,
  )

describe('the totals strip', () => {
  it('draws all four cells for a landed ticket with two attempts and a fix round', () => {
    const out = draw(totals())
    expect(out).toContain('data-cell="spent"')
    expect(out).toContain('$3.60')
    expect(out).toContain('data-cell="answering"')
    expect(out).toMatch(/data-cell="took".*9m.*claim → landed.*agents ran 1m35s/)
    expect(out).toMatch(/data-cell="attempts".*12 turns.*1 fix round/)
  })

  it('says nothing is billed yet, never unpriced, while the first attempt runs', () => {
    const out = draw(
      totals({
        attempts: 1,
        turns: 0,
        durationMs: 0,
        fixRounds: 0,
        inFlight: 1,
        byPurpose: totals().byPurpose && { ...totals().byPurpose, Work: emptyBill(), Answering: emptyBill() },
      }),
      {
        state: 'running',
      },
    )
    expect(out).toContain('nothing billed yet')
    expect(out).not.toContain('unpriced')
    expect(out).toContain('since claim')
    expect(out).not.toContain('agents ran')
    expect(out).not.toContain('0 turns')
  })

  it('leaves Took out when the claim is missing, and everything out for a ticket with no attempts or spend', () => {
    expect(draw(totals(), { firstClaimAt: null })).not.toContain('data-cell="took"')
    expect(
      draw(totals({ attempts: 0, byPurpose: { ...totals().byPurpose, Work: emptyBill(), Answering: emptyBill() } })),
    ).toBe('')
  })
})
