/** `lingtai report` (0123 §6, #690): each flag, the refusals and `--json`'s shape, through the ports. */
import type { ReportTicketRow } from '@lingtai/conductor/report'
import type { ProjectionLag, TicketReportRow } from '@lingtai/projector'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { COMMANDS } from '../src/commands.ts'
import { describeLags, moneyText, parseReport, runReport, type ReportOptions, type ReportPorts } from '../src/report.ts'

// The reader's row and the aggregation's must stay one shape: a field added to one is a type error here.
const _same: ReportTicketRow = {} as TicketReportRow
const _back: TicketReportRow = {} as ReportTicketRow
void _same
void _back

const NOW = new Date(2026, 9, 28, 15, 0)
const day = (d: number, h = 12) => new Date(2026, 9, d, h)

const row = (over: Partial<TicketReportRow> = {}): TicketReportRow => ({
  ticket: 'ticket-lingtai-1',
  project: 'lingtai',
  kind: 'bug',
  outcome: 'landed',
  outcomeAt: day(27),
  passes: 2,
  fixRounds: 3,
  machineMs: 600_000,
  intervalsEmpty: 0,
  intervalsOpen: 0,
  unknownClaims: 0,
  passTimes: [day(26).toISOString()],
  reviews: [],
  waits: [],
  cost: { Work: { reportedCents: 150, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 } },
  ...over,
})

const caughtUp = (name: string, lag = 0n): ProjectionLag => ({
  name,
  lastSeq: 10n,
  headSeq: 10n + lag,
  lag,
  updatedAt: null,
})

async function run(options: ReportOptions, ports: ReportPorts = {}) {
  let out = ''
  let err = ''
  const seen: { tickets: unknown[]; spend: unknown[] } = { tickets: [], spend: [] }
  const code = await runReport(
    options,
    {
      tickets: async (q) => (seen.tickets.push(q), [row()]),
      spend: async (q) => (seen.spend.push(q), []),
      lags: async () => [caughtUp('ticket_report'), caughtUp('spend')],
      now: () => NOW,
      ...ports,
    },
    { out: { write: (t) => ((out += t), true) }, err: { write: (t) => ((err += t), true) }, columns: undefined },
  )
  return { code, out, err, seen }
}

const saved = process.env['NO_COLOR']
beforeEach(() => {
  process.env['NO_COLOR'] = '1'
})
afterEach(() => {
  if (saved === undefined) delete process.env['NO_COLOR']
  else process.env['NO_COLOR'] = saved
})

describe('lingtai report’s window', () => {
  it('is the last seven days with no flag, and today with --window today', async () => {
    const week = await run({ json: true })
    expect(new Date(JSON.parse(week.out).window.from)).toEqual(new Date(2026, 9, 22))
    expect(new Date(JSON.parse(week.out).window.to)).toEqual(new Date(2026, 9, 29))
    expect(week.seen.spend).toEqual([{ since: new Date(2026, 9, 22) }])

    const today = await run({ window: 'today', json: true })
    expect(new Date(JSON.parse(today.out).window.from)).toEqual(new Date(2026, 9, 28))
    expect(JSON.parse(today.out).query).toMatchObject({ window: 'today', from: null, to: null })
  })

  it('takes --from and --to as local dates, the last day included', async () => {
    const r = await run({ from: '2026-10-01', to: '2026-10-03', json: true })
    const doc = JSON.parse(r.out)
    const from = new Date(doc.window.from)
    const to = new Date(doc.window.to)
    expect([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()]).toEqual([2026, 9, 1, 0])
    expect([to.getFullYear(), to.getMonth(), to.getDate(), to.getHours()]).toEqual([2026, 9, 4, 0])
    expect(doc.query).toMatchObject({ window: 'range', from: '2026-10-01', to: '2026-10-03' })
  })
})

describe('lingtai report’s filters', () => {
  it('--kind narrows to that kind, and absence narrows to none', async () => {
    const tickets = [
      row(),
      row({ ticket: 'ticket-lingtai-2', kind: 'feature' }),
      row({ ticket: 'ticket-lingtai-3', kind: null }),
    ]
    const bug = JSON.parse((await run({ kind: 'bug', json: true }, { tickets: async () => tickets })).out)
    expect(bug.counts.landed).toBe(1)
    expect(bug.kinds.map((k: { kind: string | null }) => k.kind)).toEqual(['bug'])
    expect(bug.query.kind).toBe('bug')

    const every = JSON.parse((await run({ json: true }, { tickets: async () => tickets })).out)
    expect(every.counts.landed).toBe(3)
    expect(every.kinds.map((k: { kind: string | null }) => k.kind)).toEqual(['bug', 'feature', null])
  })

  it('--project is read from the store and filtered, and reaches spend only through report()', async () => {
    const r = await run({ project: 'lingtai', json: true })
    expect(r.seen.tickets).toEqual([{ project: 'lingtai' }])
    expect(r.seen.spend).toEqual([{ since: new Date(2026, 9, 22) }])
    expect(JSON.parse(r.out).query.project).toBe('lingtai')
    expect((await run({ json: true })).seen.tickets).toEqual([{}])
  })
})

describe('lingtai report’s refusals', () => {
  const cases: [string, ReportOptions, RegExp][] = [
    ['both window flags', { window: 'today', from: '2026-10-01', to: '2026-10-02' }, /--window.*--from/],
    ['--window with only --to', { window: '7d', to: '2026-10-02' }, /--window.*--from\/--to/],
    ['a lone --from', { from: '2026-10-01' }, /--to is missing/],
    ['a lone --to', { to: '2026-10-01' }, /--from is missing/],
    ['a bad date', { from: '2026-10-01', to: 'yesterday' }, /--to takes a date/],
    ['a date that rolls over', { from: '2026-02-30', to: '2026-03-02' }, /--from takes a date/],
    ['a range backwards', { from: '2026-10-03', to: '2026-10-01' }, /after --to/],
    ['an unknown window', { window: '30d' }, /today or 7d/],
  ]
  for (const [name, options, message] of cases) {
    it(`${name}: exit 2, in words, reading nothing`, async () => {
      const r = await run(options)
      expect(r.code).toBe(2)
      expect(r.err).toMatch(message)
      expect(r.out).toBe('')
      expect(r.seen.tickets).toEqual([])

      const j = await run({ ...options, json: true })
      expect(j.code).toBe(2)
      expect(j.err).toBe('')
      expect(JSON.parse(j.out)).toMatchObject({ version: 1, command: 'report', error: { code: 'usage' } })
      expect(JSON.parse(j.out).error.message).toMatch(message)
    })
  }

  it('parses to the same refusals without a process', () => {
    expect(parseReport({ window: 'today', from: '2026-10-01' })).toEqual({
      ok: false,
      message: '--window and --from/--to choose the window two ways; give one',
    })
  })
})

describe('lingtai report --json', () => {
  it('is one document: version, command, query, lag, then the report’s own keys', async () => {
    const r = await run({ project: 'lingtai', json: true })
    expect(r.out.trim().split('\n')).toHaveLength(1)
    const doc = JSON.parse(r.out)
    expect(Object.keys(doc).slice(0, 4)).toEqual(['version', 'command', 'query', 'lag'])
    expect(doc).toMatchObject({ version: 1, command: 'report', counts: { landed: 1, closed: 0, open: 0 } })
    expect(doc.lag).toEqual([
      { name: 'ticket_report', lag: '0' },
      { name: 'spend', lag: '0' },
    ])
    for (const key of [
      'window',
      'intervals',
      'landed',
      'roundBuckets',
      'landingDays',
      'spend',
      'kinds',
      'survival',
      'waitCauses',
      'top',
    ]) {
      expect(doc).toHaveProperty(key)
    }
    expect(doc.top[0].cost).toEqual({ reportedCents: 150, estimatedCents: 0, unknown: 0 })
  })

  it('is empty figures and exit 0 when nothing is in the window, never a NaN', async () => {
    const r = await run({ json: true }, { tickets: async () => [] })
    expect(r.code).toBe(0)
    const doc = JSON.parse(r.out)
    expect(doc.counts).toEqual({ landed: 0, closed: 0, open: 0 })
    expect(doc.landed.passes).toEqual({ mean: null, median: null })
    expect(doc.top).toEqual([])
    expect(doc.survival).toEqual([])
    expect(r.out).not.toMatch(/NaN|Infinity/)
  })
})

describe('lingtai report’s text', () => {
  it('says so in one line when nothing is in the window', async () => {
    const r = await run({ window: 'today' }, { tickets: async () => [] })
    expect(r.code).toBe(0)
    expect(r.out).toBe('no tickets and no spend in 2026-10-28\n')
  })

  it('prints the sections, the money apart and the sentence as report() built it', async () => {
    const r = await run(
      {},
      {
        tickets: async () => [
          row({
            cost: { Work: { reportedCents: 150, reportedRuns: 1, estimatedUsd: 0.25, estimatedRuns: 1, unknown: 1 } },
          }),
        ],
      },
    )
    expect(r.code).toBe(0)
    expect(r.out).toContain('report for 2026-10-22 to 2026-10-28')
    expect(r.out).toContain('landed tickets (1)')
    expect(r.out).toContain('by kind')
    expect(r.out).toContain('mean $1.50 reported + $0.25 estimated')
    expect(r.out).toContain('1 unknown')
    expect(r.out).toContain('ticket-lingtai-1  bug  landed')
    expect(r.out).toContain('over 3 fix rounds · 2 passes · 1 run unknown')
  })

  it('prints — for a figure with nothing behind it, and unclassified as its own row', async () => {
    const r = await run({}, { tickets: async () => [row({ outcome: 'closed', kind: null })] })
    expect(r.out).toContain('(unclassified)')
    expect(r.out).toContain('mean —')
    expect(r.out).not.toMatch(/NaN/)
  })

  it('prints a kind’s median, both shares and mean cost, not the mean of rounds', async () => {
    const rounds = [0, 0, 12]
    const r = await run(
      {},
      { tickets: async () => rounds.map((fixRounds, i) => row({ ticket: `ticket-lingtai-${i + 1}`, fixRounds })) },
    )
    const line = r.out.split('\n').find((l) => /^\s*bug\s/.test(l))
    expect(r.out).toContain('median fix rounds')
    expect(line).toMatch(/bug\s+3\s+0\s+67%\s+33%\s+mean \$1\.50 reported/)
  })

  it('prints a top ticket’s cost, purpose shares and each wait’s cause and resolution', async () => {
    const wait = {
      waitId: 'w1',
      at: day(26).toISOString(),
      reason: 'CheckRefused',
      triage: { attempt: 1, result: 'advice', cause: 'ConflictingHunks' },
      resolution: 'AnswerQuestion',
    }
    const cost = {
      Work: { reportedCents: 100, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 },
      Answering: { reportedCents: 300, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 },
    }
    const r = await run({}, { tickets: async () => [row({ waits: [wait], cost, fixRounds: 2 })] })
    expect(r.out).toContain('ticket-lingtai-1  bug  landed  $4.00 reported')
    expect(r.out).toContain('spent on: answering refusals 75% · work 25%')
    expect(r.out).toContain('waited for a decision on a refused check · triage: merge by hand · answered')
    expect(r.out).not.toMatch(/CheckRefused|ConflictingHunks|AnswerQuestion|censored|cause —/)
  })

  it('lists "most fix rounds" only for tickets with a fix round, and not at all when none had one', async () => {
    const none = await run({}, { tickets: async () => [row({ fixRounds: 0 })] })
    expect(none.out).not.toContain('most fix rounds')
    const some = await run(
      {},
      {
        tickets: async () => [
          row({ ticket: 'ticket-lingtai-1', fixRounds: 2 }),
          row({ ticket: 'ticket-lingtai-2', fixRounds: 0 }),
        ],
      },
    )
    const top = some.out.slice(some.out.indexOf('most fix rounds'))
    expect(top).toContain('ticket-lingtai-1')
    expect(top).not.toContain('ticket-lingtai-2')
  })

  it('prints survival when the window has no placed ticket and no spend', async () => {
    const review = { seq: '1', at: day(28, 9).toISOString(), round: 0, blocking: 1, cleared: false }
    const r = await run(
      { window: 'today' },
      { tickets: async () => [row({ outcomeAt: day(29), reviews: [review], passTimes: [day(27).toISOString()] })] },
    )
    expect(r.out).not.toContain('no tickets and no spend')
    expect(r.out).toContain('getting past review')
  })

  it('says how many passes the machine time skipped', async () => {
    const r = await run({}, { tickets: async () => [row({ intervalsEmpty: 2, intervalsOpen: 1 })] })
    expect(r.out).toContain('3 passes left out of machine time: 2 with no sign of life, 1 still open')
  })
})

describe('lingtai report with a projection behind', () => {
  it('says so on stderr and still prints the figures', async () => {
    const r = await run({}, { lags: async () => [caughtUp('ticket_report'), caughtUp('spend', 5n)] })
    expect(r.code).toBe(0)
    expect(r.err).toBe('spend is 5 events behind the log — figures may be older than it\n')
    expect(r.out).toContain('landed tickets (1)')
  })

  it('carries the lag in the document too, and a missing checkpoint is null', async () => {
    const r = await run({ json: true }, { lags: async () => [caughtUp('spend', 5n)] })
    expect(JSON.parse(r.out).lag).toEqual([
      { name: 'ticket_report', lag: null },
      { name: 'spend', lag: '5' },
    ])
    expect(r.err).toContain('ticket_report has no checkpoint yet')
    expect(r.err).toContain('spend is 5 events behind')
  })

  it('does not take a lag it could not read for a current projection', async () => {
    const r = await run({ json: true }, { lags: async () => Promise.reject(new Error('no database')) })
    expect(r.code).toBe(0)
    expect(r.err).toContain('could not read how far the projections are behind: no database')
    expect(JSON.parse(r.out).lag).toEqual([])
  })

  it('describes none for projections that are caught up', () => {
    expect(describeLags([caughtUp('ticket_report'), caughtUp('spend')]).notes).toEqual([])
  })
})

describe('moneyText', () => {
  it('keeps reported, estimated and unknown apart, reported first, and never sums them', () => {
    expect(moneyText({ reportedCents: 150, estimatedCents: 25, unknown: 1 })).toBe(
      '$1.50 reported · $0.25 estimated · 1 unknown',
    )
    expect(moneyText({ reportedCents: 0, estimatedCents: 25, unknown: 0 })).toBe('$0.25 estimated')
    expect(moneyText({ reportedCents: 0, estimatedCents: 0, unknown: 2 })).toBe('2 unknown')
    expect(moneyText({ reportedCents: 0, estimatedCents: 0, unknown: 0 })).toBe('$0.00 reported')
  })
})

describe('lingtai report’s definition', () => {
  it('is an everyday command that only reads, and says so', () => {
    const def = COMMANDS.find((c) => c.name === 'report')
    expect(def?.group).toBe('everyday')
    expect(def?.effect).toBe('reads')
    expect(def?.usage.join('\n')).toMatch(/Only reads: it changes nothing/)
  })
})
