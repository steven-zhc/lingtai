/**
 * The four charts of `/report` (0123 §7, #689), as inline SVG drawn on the
 * server. **The hover is the SVG's own `<title>`**: a column or a point is a
 * group with a transparent hit rectangle and a title holding the exact figures,
 * so every chart answers a hover with no client bundle and a test can read the
 * figures from the static markup. Each has an HTML legend above it and one
 * y-axis, never two.
 *
 * Series colours come from `--s1`–`--s4` and `--muted` only (`lib/report.ts`):
 * amber, red and green are the board's states and no series wears them.
 */
import type { LandingDay, Report, RoundBucket, SpendDay, SurvivalStep } from '@lingtai/conductor/report'

import {
  axisFor,
  centsOf,
  kindSeries,
  moneyText,
  PURPOSE_SERIES,
  purposeSeriesOf,
  stepPath,
  type Series,
} from '@/lib/report.ts'

const W = 520
const H = 210
const L = 38
const R = 8
const T = 10
const B = 26

export function Legend({ series }: { series: readonly Series[] }) {
  return (
    <ul className="rp-legend">
      {series.map((s) => (
        <li key={s.key}>
          <i style={{ background: s.colour }} />
          {s.name}
        </li>
      ))}
    </ul>
  )
}

export function Empty({ children }: { children: string }) {
  return <p className="rp-empty">{children}</p>
}

interface Column {
  label: string
  /** The hover: one line each. */
  tip: string[]
  segs: { series: number; value: number }[]
}

/** Stacked columns on one y-axis; a zero segment draws nothing. */
function Stacked({
  columns,
  series,
  label,
  axisText,
}: {
  columns: Column[]
  series: readonly Series[]
  label: string
  axisText: (v: number) => string
}) {
  const totals = columns.map((c) => c.segs.reduce((n, s) => n + s.value, 0))
  const axis = axisFor(Math.max(0, ...totals))
  const y = (v: number) => T + (H - T - B) * (1 - v / axis.top)
  const bw = (W - L - R) / columns.length
  const gap = Math.min(10, bw * 0.28)
  const every = columns.length > 10 ? Math.ceil(columns.length / 8) : 1
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      {axis.ticks.map((v) => (
        <g key={v}>
          <line className="gl" x1={L} x2={W - R} y1={y(v)} y2={y(v)} />
          <text x={L - 6} y={y(v) + 4} textAnchor="end">
            {axisText(v)}
          </text>
        </g>
      ))}
      {columns.map((c, i) => {
        const x = L + i * bw + gap / 2
        let base = 0
        return (
          <g key={c.label} className="col">
            <title>{c.tip.join('\n')}</title>
            <rect className="hit" x={L + i * bw} y={T} width={bw} height={H - T - B} />
            {[...c.segs]
              .sort((a, b) => a.series - b.series)
              .filter((s) => s.value > 0)
              .map((s) => {
                const top = base + s.value
                const seg = (
                  <rect
                    key={s.series}
                    x={x}
                    y={y(top)}
                    width={bw - gap}
                    height={y(base) - y(top)}
                    fill={series[s.series]?.colour ?? 'var(--muted)'}
                  />
                )
                base = top
                return seg
              })}
            {i % every === 0 ? (
              <text x={x + (bw - gap) / 2} y={H - 8} textAnchor="middle">
                {c.label}
              </text>
            ) : null}
          </g>
        )
      })}
      <line className="ax" x1={L} x2={W - R} y1={y(0)} y2={y(0)} />
    </svg>
  )
}

const kindLines = (kinds: { kind: string | null; count: number }[], total: number): string[] => [
  ...kinds.map((k) => `${k.kind ?? 'unclassified'}: ${k.count}`),
  `total: ${total}`,
]

/** The kinds a report's tickets carry, in its order, for one legend across both ticket charts. */
export function kindsOfReport(report: Report): (string | null)[] {
  return [
    ...new Set<string | null>([
      ...report.kinds.map((k) => k.kind),
      ...report.roundBuckets.flatMap((b) => b.kinds.map((k) => k.kind)),
      ...report.landingDays.flatMap((d) => d.kinds.map((k) => k.kind)),
    ]),
  ]
}

function KindStack({
  rows,
  kinds,
  label,
}: {
  rows: { label: string; total: number; kinds: { kind: string | null; count: number }[]; title: string }[]
  kinds: readonly (string | null)[]
  label: string
}) {
  const { series, of } = kindSeries(kinds)
  return (
    <>
      <Legend series={series} />
      <Stacked
        label={label}
        series={series}
        axisText={(v) => String(Math.round(v))}
        columns={rows.map((r) => {
          const bySeries = new Map<number, number>()
          for (const k of r.kinds) bySeries.set(of(k.kind), (bySeries.get(of(k.kind)) ?? 0) + k.count)
          return {
            label: r.label,
            tip: [r.title, ...kindLines(r.kinds, r.total)],
            segs: [...bySeries].map(([series, value]) => ({ series, value })),
          }
        })}
      />
    </>
  )
}

/** Landed tickets by fix rounds, stacked by kind: convergence is the right-hand column. */
export function RoundsPanel({ buckets, kinds }: { buckets: RoundBucket[]; kinds: readonly (string | null)[] }) {
  if (buckets.every((b) => b.total === 0)) return <Empty>no landed tickets in this window</Empty>
  return (
    <KindStack
      label="landed tickets by fix rounds"
      kinds={kinds}
      rows={buckets.map((b) => ({
        label: b.bucket,
        total: b.total,
        kinds: b.kinds,
        title: `${b.bucket} fix round${b.bucket === '1' ? '' : 's'}`,
      }))}
    />
  )
}

/** Landed tickets by the local day they landed. */
export function LandingsPanel({ days, kinds }: { days: LandingDay[]; kinds: readonly (string | null)[] }) {
  if (days.every((d) => d.total === 0)) return <Empty>no landings in this window</Empty>
  return (
    <KindStack
      label="tickets landed per day"
      kinds={kinds}
      rows={days.map((d) => ({ label: d.day.slice(5), total: d.total, kinds: d.kinds, title: d.day }))}
    />
  )
}

/** Spend per day by purpose, in dollars on one axis; unknown runs are in the hover, never a zero. */
export function SpendPanel({ days }: { days: SpendDay[] }) {
  if (days.every((d) => centsOf(d) === 0 && d.unknown === 0)) return <Empty>nothing spent in this window</Empty>
  return (
    <>
      <Legend series={PURPOSE_SERIES} />
      <Stacked
        label="spend per day by purpose"
        series={PURPOSE_SERIES}
        axisText={(v) => (v >= 10 ? `$${Math.round(v)}` : `$${v.toFixed(2)}`)}
        columns={days.map((d) => {
          const bySeries = new Map<number, number>()
          for (const p of d.byPurpose) {
            const i = purposeSeriesOf(p.purpose)
            bySeries.set(i, (bySeries.get(i) ?? 0) + centsOf(p.money) / 100)
          }
          return {
            label: d.day.slice(5),
            tip: [d.day, ...d.byPurpose.map((p) => `${p.purpose}: ${moneyText(p.money)}`), `day: ${moneyText(d)}`],
            segs: [...bySeries].map(([series, value]) => ({ series, value })),
          }
        })}
      />
    </>
  )
}

/**
 * The share of tickets not yet past review after k reviews — a step line from
 * 100%. Falling fast is converging; staying high is not. The count of tickets
 * still being counted at each step is in its hover, not drawn on the chart.
 */
export function SurvivalPanel({ steps }: { steps: SurvivalStep[] }) {
  if (steps.length === 0) return <Empty>no ticket began review in this window</Empty>
  // Room under the ticks for the axis caption.
  const H = 224
  const B = 40
  const K = Math.max(1, steps.length)
  const right = 30
  const x = (k: number) => L + ((W - L - right) * k) / K
  const y = (v: number) => T + 4 + (H - T - 4 - B) * (1 - v)
  const knots = [{ k: 0, survival: 1, atRisk: steps[0]!.atRisk, passed: 0, censored: 0 }, ...steps]
  const line = stepPath(knots.map((p) => ({ x: x(p.k), y: y(p.survival) })))
  return (
    <>
      <Legend series={[{ key: 'survival', name: 'still not passed', colour: 'var(--s1)' }]} />
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="share of tickets still not passed after k reviews">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line className="gl" x1={L} x2={W - right} y1={y(v)} y2={y(v)} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end">
              {v * 100}%
            </text>
          </g>
        ))}
        {knots.map((p) => (
          <text key={p.k} x={x(p.k)} y={H - 22} textAnchor="middle">
            {'plus' in p && p.plus ? `${p.k}+` : p.k}
          </text>
        ))}
        <text x={(L + W - right) / 2} y={H - 6} textAnchor="middle">
          reviews done
        </text>
        <path d={`${line}V${y(0)}H${x(0)}Z`} fill="var(--s1)" opacity={0.1} />
        <path d={line} fill="none" stroke="var(--s1)" strokeWidth={2} />
        <line className="ax" x1={L} x2={W - right} y1={y(0)} y2={y(0)} />
        {knots.map((p) => (
          <g key={p.k} className="col">
            <title>
              {p.k === 0
                ? `start\n${p.atRisk} ticket${p.atRisk === 1 ? '' : 's'}`
                : `after ${'plus' in p && p.plus ? `${p.k} or more reviews` : `${p.k} review${p.k === 1 ? '' : 's'}`}\n${Math.round(p.survival * 100)}% still not passed\n${p.atRisk} still counted at this review\n${p.passed} passed\n${p.censored} ended without passing`}
            </title>
            <rect className="hit" x={x(p.k) - 18} y={T} width={36} height={H - T - B} />
            <circle cx={x(p.k)} cy={y(p.survival)} r={4.5} fill="var(--s1)" stroke="var(--surface)" strokeWidth={2} />
            {p.k > 0 ? (
              <text x={x(p.k) + 7} y={y(p.survival) - 7} className="rp-step">
                {Math.round(p.survival * 100)}%
              </text>
            ) : null}
          </g>
        ))}
      </svg>
    </>
  )
}
