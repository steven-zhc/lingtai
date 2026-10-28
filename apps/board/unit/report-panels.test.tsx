/**
 * `/report`'s panels, one test each, off hand-built slices of `Report` (#689).
 * Asserted on the static markup: a hover is an SVG `<title>`, so the exact
 * figures are in it, and no series wears one of the board's state colours.
 */
import { readFileSync } from 'node:fs'

import type { KindRow, LandedFigures, TopTicket } from '@lingtai/conductor/report'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LandingsPanel, RoundsPanel, SpendPanel, SurvivalPanel } from '../src/app/report/charts.tsx'
import { Filters, KindsPanel, Tiles, TopPanel, WaitsPanel } from '../src/app/report/panels.tsx'
import { reportQuery } from '../src/lib/report.ts'

const NOW = new Date(2026, 9, 28, 12)
const query = reportQuery({}, NOW)
const kinds = ['bug', 'feature']

const spread = { mean: 2, median: 1 }
const figures = (over: Partial<LandedFigures> = {}): LandedFigures => ({
  landed: 4,
  passes: spread,
  fixRounds: { mean: 1.5, median: 1 },
  waits: spread,
  machineMs: { mean: 600_000, median: 3_900_000 },
  cost: { meanReportedCents: 120, meanEstimatedCents: 30, medianCents: 100, medianIncludesEstimate: true, unknown: 1 },
  zeroOrOneShare: 0.5,
  fiveOrMoreShare: 0.25,
  ...over,
})
const money = { reportedCents: 500, estimatedCents: 40, unknown: 2 }

describe('the report page', () => {
  it('draws the fix rounds by bucket, stacked by kind, with the figures in the hover', () => {
    const out = renderToStaticMarkup(
      <RoundsPanel
        kinds={[...kinds, null]}
        buckets={[
          {
            bucket: '0',
            total: 3,
            kinds: [
              { kind: 'bug', count: 2 },
              { kind: 'feature', count: 1 },
            ],
          },
          { bucket: '1', total: 0, kinds: [] },
          { bucket: '2', total: 0, kinds: [] },
          { bucket: '3', total: 0, kinds: [] },
          { bucket: '4', total: 0, kinds: [] },
          { bucket: '5+', total: 1, kinds: [{ kind: null, count: 1 }] },
        ]}
      />,
    )
    expect(out).toContain('<title>0 fix rounds\nbug: 2\nfeature: 1\ntotal: 3</title>')
    expect(out).toContain('unclassified: 1')
    expect(out).toContain('rp-legend')
    expect(out).toContain('fill="var(--s1)"')
    expect(out).toContain('fill="var(--muted)"')
  })

  it('says so when nothing landed', () => {
    expect(renderToStaticMarkup(<RoundsPanel kinds={[]} buckets={[{ bucket: '0', total: 0, kinds: [] }]} />)).toContain(
      'no landed tickets in this window',
    )
    expect(
      renderToStaticMarkup(<LandingsPanel kinds={[]} days={[{ day: '2026-10-28', total: 0, kinds: [] }]} />),
    ).toContain('no landings in this window')
  })

  it('draws the landings per day, every day of the window', () => {
    const out = renderToStaticMarkup(
      <LandingsPanel
        kinds={kinds}
        days={[
          { day: '2026-10-27', total: 0, kinds: [] },
          { day: '2026-10-28', total: 2, kinds: [{ kind: 'bug', count: 2 }] },
        ]}
      />,
    )
    expect(out).toContain('<title>2026-10-28\nbug: 2\ntotal: 2</title>')
    expect(out).toContain('<title>2026-10-27\ntotal: 0</title>')
  })

  it('draws the survival curve as a step line with each step counted', () => {
    const out = renderToStaticMarkup(
      <SurvivalPanel
        steps={[
          { k: 1, atRisk: 10, passed: 5, censored: 0, survival: 0.5 },
          { k: 2, atRisk: 5, passed: 3, censored: 1, survival: 0.2 },
        ]}
      />,
    )
    expect(out).toContain('n=10')
    expect(out).toContain('n=5')
    expect(out).toContain('50%')
    expect(out).toContain(
      'after 2 reviews\n20% not yet past review\n5 still counted at this review\n3 passed\n1 ended without passing',
    )
    expect(out).toMatch(/<path d="M[\d.]+,[\d.]+H[\d.]+V[\d.]+H/)
    expect(renderToStaticMarkup(<SurvivalPanel steps={[]} />)).toContain('no ticket began review')
  })

  it('draws the spend per day by purpose and keeps unknown runs out of "nothing"', () => {
    const day = (d: string, over = {}) => ({
      day: d,
      reportedCents: 0,
      estimatedCents: 0,
      unknown: 0,
      byPurpose: [],
      ...over,
    })
    const out = renderToStaticMarkup(
      <SpendPanel
        days={[
          day('2026-10-27', { unknown: 2 }),
          day('2026-10-28', {
            reportedCents: 300,
            estimatedCents: 50,
            byPurpose: [
              { purpose: 'Work', money: { reportedCents: 300, estimatedCents: 0, unknown: 0 } },
              { purpose: 'Triage', money: { reportedCents: 0, estimatedCents: 50, unknown: 0 } },
            ],
          }),
        ]}
      />,
    )
    expect(out).toContain('Work: $3.00')
    expect(out).toContain('Triage: ~$0.50 est.')
    expect(out).toContain('day: $3.00 + ~$0.50 est.')
    expect(out).toContain('2 unknown')
    expect(out).toContain('triage and discussion')
    const onlyUnknown = renderToStaticMarkup(<SpendPanel days={[day('2026-10-27', { unknown: 1 })]} />)
    expect(onlyUnknown).not.toContain('nothing spent')
    expect(renderToStaticMarkup(<SpendPanel days={[day('2026-10-27')]} />)).toContain('nothing spent in this window')
  })

  it('shades the wait × cause table and heads the null column "no triage cause"', () => {
    const out = renderToStaticMarkup(
      <WaitsPanel
        cells={[
          { reason: 'ReviewFindings', cause: 'FixableLines', count: 4 },
          { reason: 'ReviewFindings', cause: null, count: 1 },
          { reason: 'BuildRed', cause: null, count: 2 },
        ]}
      />,
    )
    expect(out).toContain('no triage cause')
    expect(out).toContain('color-mix(in oklab, var(--accent)')
    expect(out.indexOf('ReviewFindings')).toBeLessThan(out.indexOf('BuildRed'))
    expect(renderToStaticMarkup(<WaitsPanel cells={[]} />)).toContain('no ticket stopped to wait')
  })

  it('shows the figure tiles, and a dash with a reason where there is no landed ticket', () => {
    const counts = { landed: 4, closed: 1, open: 2 }
    const intervals = { empty: 1, open: 0 }
    const out = renderToStaticMarkup(
      <Tiles report={{ counts, intervals, landed: figures(), spend: { total: money, days: [] } }} />,
    )
    expect(out).toContain('25%')
    expect(out).toContain('1h 05m')
    expect(out).toContain('$5.40')
    expect(out).toContain('2 unknown')
    const none = renderToStaticMarkup(
      <Tiles
        report={{
          counts: { landed: 0, closed: 0, open: 0 },
          intervals,
          landed: figures({
            landed: 0,
            fixRounds: { mean: null, median: null },
            machineMs: { mean: null, median: null },
            zeroOrOneShare: null,
            fiveOrMoreShare: null,
          }),
          spend: { total: { reportedCents: 0, estimatedCents: 0, unknown: 0 }, days: [] },
        }}
      />,
    )
    expect(none).toContain('title="no landed tickets in this window"')
    expect(none).toContain('—')
  })

  it('tabulates the kinds, unclassified included, each with its spend as three parts', () => {
    const row = (kind: string | null): KindRow => ({ ...figures(), kind, spend: money })
    const out = renderToStaticMarkup(<KindsPanel kinds={[row('bug'), row(null)]} />)
    expect(out).toContain('unclassified')
    expect(out).toContain('$5.00 + ~$0.40 est. + 2 unknown')
    expect(out).toContain('$1.20 + ~$0.30 est. + 1 unknown')
  })

  it('lists the top tickets, each a link to its task page, with the sentence unchanged', () => {
    const t: TopTicket = {
      ticket: 'ticket-lingtai-612',
      kind: 'bug',
      outcome: 'landed',
      passes: 3,
      fixRounds: 6,
      cost: money,
      purposeShares: [],
      waits: [],
      sentence: '60% work over 6 fix rounds · 3 passes',
    }
    const out = renderToStaticMarkup(<TopPanel top={[t]} query={query} />)
    expect(out).toContain('href="/task/ticket-lingtai-612"')
    expect(out).toContain('>#612<')
    expect(out).toContain('60% work over 6 fix rounds · 3 passes')
    expect(out).toContain('href="/report?sort=cost"')
    expect(renderToStaticMarkup(<TopPanel top={[]} query={query} />)).toContain('no ticket in this window')
  })

  it('has filters that are a plain GET form carrying the project, with unclassified as an empty kind', () => {
    const out = renderToStaticMarkup(
      <Filters query={reportQuery({ project: 'lingtai', kind: ['bug', ''] }, NOW)} kinds={['bug', 'feature', null]} />,
    )
    expect(out).toContain('method="get"')
    expect(out).toContain('name="project" value="lingtai"')
    expect(out).toMatch(/name="kind"[^>]*value=""/)
    expect(out).toMatch(/checked=""[^>]*value="bug"/)
    expect(out).not.toMatch(/checked=""[^>]*value="feature"/)
  })

  it('draws no series in a state colour', () => {
    const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
    const rules = css.slice(css.indexOf('/* /report (#689)'))
    const sources = ['charts.tsx', 'panels.tsx', 'page.tsx'].map((f) =>
      readFileSync(new URL(`../src/app/report/${f}`, import.meta.url), 'utf8'),
    )
    const lib = readFileSync(new URL('../src/lib/report.ts', import.meta.url), 'utf8')
    for (const text of [
      rules,
      lib.replace(/\/\*[\s\S]*?\*\//g, ''),
      ...sources.map((s) => s.replace(/\/\*[\s\S]*?\*\//g, '')),
    ]) {
      expect(text).not.toMatch(/--(signal|pass|fail)\b/)
    }
    expect(lib).not.toContain("from './kind-colour")
  })
})
