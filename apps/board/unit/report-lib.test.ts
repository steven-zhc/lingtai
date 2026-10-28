/** The address → the report's inputs, the chip, and the geometry (#689). */
import { describe, expect, it } from 'vitest'

import { axisFor, kindSeries, moneyText, reportChip, reportHref, reportQuery, stepPath } from '../src/lib/report.ts'

const NOW = new Date(2026, 9, 28, 12)
const ymd = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`

describe('reportQuery', () => {
  it('defaults to the last seven local days, every kind, by rounds', () => {
    const q = reportQuery({}, NOW)
    expect(q).toMatchObject({ which: '7d', project: null, kinds: null, sort: 'rounds', note: null })
    expect(ymd(q.window.from)).toBe('2026-10-22')
    expect(ymd(q.window.to)).toBe('2026-10-29')
  })

  it('reads today, a range (which wins over window=), and the project and sort', () => {
    expect(reportQuery({ window: 'today' }, NOW).which).toBe('today')
    const q = reportQuery(
      { window: 'today', from: '2026-10-01', to: '2026-10-03', project: 'lingtai', sort: 'cost' },
      NOW,
    )
    expect(q).toMatchObject({ which: 'custom', project: 'lingtai', sort: 'cost' })
    expect(ymd(q.window.from)).toBe('2026-10-1')
    expect(ymd(q.window.to)).toBe('2026-10-4')
  })

  it('falls back to seven days and says so for a date that is not one', () => {
    for (const p of [
      { from: '2026-02-31', to: '2026-03-01' },
      { from: 'x' },
      { from: '2026-10-05', to: '2026-10-01' },
    ]) {
      const q = reportQuery(p, NOW)
      expect(q.which).toBe('7d')
      expect(q.note).not.toBeNull()
    }
  })

  it('reads an empty kind as unclassified and no kind as every kind', () => {
    expect(reportQuery({ kind: ['bug', ''] }, NOW).kinds).toEqual(['bug', null])
    expect(reportQuery({ kind: '' }, NOW).kinds).toEqual([null])
    expect(reportQuery({}, NOW).kinds).toBeNull()
  })

  it('reads every box unchecked as no kind, not every kind', () => {
    expect(reportQuery({ kinds: '1' }, NOW).kinds).toEqual([])
    expect(reportQuery({ kinds: '1', kind: 'bug' }, NOW).kinds).toEqual(['bug'])
    expect(reportHref(reportQuery({ kinds: '1' }, NOW))).toBe('/report?kinds=1')
  })

  it('lets a selector moved off the drawn window win over the dates left in the form', () => {
    const dates = { from: '2026-10-01', to: '2026-10-03' }
    expect(reportQuery({ ...dates, was: 'custom', window: 'today' }, NOW).which).toBe('today')
    expect(reportQuery({ ...dates, was: 'custom', window: 'custom' }, NOW).which).toBe('custom')
    expect(reportQuery({ ...dates, was: '7d', window: '7d' }, NOW).which).toBe('custom')
  })

  it('writes the same query back as an address', () => {
    const q = reportQuery({ project: 'a b', kind: ['bug', ''], from: '2026-10-01', to: '2026-10-03' }, NOW)
    expect(reportHref(q, { sort: 'cost' })).toBe(
      '/report?project=a+b&from=2026-10-01&to=2026-10-03&kind=bug&kind=&sort=cost',
    )
    expect(reportHref(reportQuery({}, NOW))).toBe('/report')
  })
})

describe('reportChip', () => {
  const ok = { lag: 0 }
  it('is current when both are at the head', () => {
    expect(reportChip({ ticketReport: ok, spend: ok })).toMatchObject({ current: true, label: 'current' })
  })
  it('names the projection that is behind, and the command that repairs a failed one', () => {
    expect(reportChip({ ticketReport: { lag: 3 }, spend: ok })).toMatchObject({
      current: false,
      label: 'ticket_report behind 3',
      tone: 'idle',
    })
    const c = reportChip({ ticketReport: ok, spend: { lag: null, error: 'boom' } })
    expect(c).toMatchObject({ label: 'spend not current', tone: 'warn' })
    expect(c.title).toContain('lingtai projection rebuild spend')
  })
})

describe('the numbers', () => {
  it('words money as three parts and never prints zero over an unknown run', () => {
    expect(moneyText({ reportedCents: 0, estimatedCents: 0, unknown: 0 })).toBe('$0.00')
    expect(moneyText({ reportedCents: 0, estimatedCents: 0, unknown: 3 })).toBe('3 unknown')
    expect(moneyText({ reportedCents: 310, estimatedCents: 25, unknown: 2 })).toBe('$3.10 + ~$0.25 est. + 2 unknown')
  })

  it('gives kinds four colours and the rest one grey, unclassified among them', () => {
    const { series, of } = kindSeries(['a', 'b', 'c', 'd', 'e', null])
    expect(series.map((s) => s.colour)).toEqual(['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--muted)'])
    expect(of('a')).toBe(0)
    expect(of('e')).toBe(4)
    expect(of(null)).toBe(4)
    expect(kindSeries(['bug', 'feature']).series).toHaveLength(2)
  })

  it('finds an axis that tops out above the largest value', () => {
    expect(axisFor(7)).toEqual({ top: 8, ticks: [0, 2, 4, 6, 8] })
    expect(axisFor(0).top).toBeGreaterThan(0)
  })

  it('steps along and then down', () => {
    expect(
      stepPath([
        { x: 0, y: 0 },
        { x: 10, y: 5 },
        { x: 20, y: 8 },
      ]),
    ).toBe('M0,0H10V5H20V8')
  })
})
