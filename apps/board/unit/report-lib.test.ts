/** The address → the report's inputs, the chip, and the geometry (#689). */
import { describe, expect, it } from 'vitest'

import {
  axisFor,
  donutSegments,
  kindSeries,
  moneyText,
  reportChip,
  reportHref,
  reportQuery,
  stepPath,
} from '../src/lib/report.ts'

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

describe('the handled-for-you address (#1285)', () => {
  it('reads a kind, an answerer and a cursor, and writes them back with the anchor', () => {
    const q = reportQuery({ handled: 'build', by: 'system', before: '2026-10-27T10:00:00.000Z,0,ticket-x-1' }, NOW)
    expect(q.handled).toMatchObject({ kind: 'build', by: 'system', before: { ticket: 'ticket-x-1' } })
    expect(reportHref(q)).toBe(
      '/report?handled=build&by=system&before=2026-10-27T10%3A00%3A00.000Z%2C0%2Cticket-x-1#handled',
    )
    expect(reportHref(q, { handled: null })).toBe('/report')
    expect(reportQuery({ handled: 'all' }, NOW).handled).toEqual({ kind: 'all', by: null, before: null })
  })

  it('drops a kind it does not know and says so, and a cursor that is not one', () => {
    const q = reportQuery({ handled: 'mystery' }, NOW)
    expect(q.handled).toBeNull()
    expect(q.note).toContain('problem kind was not read')
    expect(reportQuery({ handled: 'setup', before: 'nope' }, NOW).handled?.before).toBeNull()
  })

  it('keeps the drill-down when a sort link is followed', () => {
    const q = reportQuery({ handled: 'all', by: 'you' }, NOW)
    expect(reportHref(q, { sort: 'cost' })).toBe('/report?sort=cost&handled=all&by=you#handled')
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
    expect(moneyText({ reportedCents: 0, estimatedCents: 0, unknown: 3 })).toBe('3 unpriced')
    expect(moneyText({ reportedCents: 310, estimatedCents: 25, unknown: 2 })).toBe('$3.10 + ~$0.25 est. + 2 unpriced')
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

describe('donutSegments', () => {
  const row = (key: string, reportedCents: number, estimatedCents: number) => ({
    key,
    colour: 'c',
    reportedCents,
    estimatedCents,
  })

  it('leaves zero-width segments out and keeps reported before estimated', () => {
    const out = donutSegments([row('a', 100, 0), row('b', 50, 50)])
    expect(out.map((s) => `${s.key}${s.estimated ? '~' : ''}`)).toEqual(['a', 'b', 'b~'])
  })

  it('draws a segment that is the whole ring as two half-arcs, never one arc back to its start', () => {
    const [only, ...rest] = donutSegments([row('a', 100, 0)])
    expect(rest).toEqual([])
    expect(only!.d.match(/ A 70 70 /g)).toHaveLength(2)
  })

  it('draws nothing when no cost is known', () => {
    expect(donutSegments([row('a', 0, 0)])).toEqual([])
  })
})
