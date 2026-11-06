/**
 * `/landed` (#895): the page drawn from fixture rows, and the pure pieces under it.
 * Rendered to static markup, so nothing here reads a database or GitHub.
 */
import type { TicketReportRow } from '@lingtai/projector'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LandedView, type LandedEnv } from '../src/app/landed/view.tsx'
import { ColumnLabel } from '../src/app/page.tsx'
import {
  costText,
  cursorText,
  diffSquares,
  groupDays,
  kindColourOf,
  landedHref,
  landedLink,
  landedQuery,
  parseCursor,
  parseSum,
  sumText,
  totalsOf,
  type LandedData,
} from '../src/lib/landed.ts'
import { projectionChip } from '../src/lib/report.ts'

const row = (over: Partial<TicketReportRow> = {}): TicketReportRow => ({
  ticket: 'ticket-lingtai-101',
  project: 'lingtai',
  kind: 'bug',
  outcome: 'landed',
  outcomeAt: new Date(2026, 10, 5, 14, 7),
  passes: 1,
  fixRounds: 0,
  machineMs: 0,
  intervalsEmpty: 0,
  intervalsOpen: 0,
  unknownClaims: 0,
  passTimes: [],
  reviews: [],
  waits: [],
  cost: { Action: { reportedCents: 150, reportedRuns: 1, estimatedUsd: 0, estimatedRuns: 0, unknown: 0 } },
  title: 'fix(end): the point runs',
  mergeCommit: 'abcdef1234567',
  landingRun: 'pass-101',
  landingAttempt: 2,
  landingFixRounds: 1,
  diffFiles: 3,
  diffInsertions: 40,
  diffDeletions: 10,
  summary: 'The end point now runs on every outcome. It used to skip a close.',
  summaryClipped: null,
  ...over,
})

const env: LandedEnv = {
  kinds: ['bug', 'tech-debt', 'feature', 'documentation'],
  owners: new Map([['lingtai', 'steven-zhc']]),
  sources: new Map([['lingtai', 'github']]),
}
const chip = projectionChip('ticket_report', { lag: 0 })
const query = { project: null, kind: null, before: null }
const data = (rows: TicketReportRow[], over: Partial<LandedData> = {}): LandedData => ({
  rows,
  next: null,
  backlog: new Map(),
  backlogError: null,
  chip,
  ...over,
})
const html = (d: LandedData) => renderToStaticMarkup(<LandedView data={d} query={query} env={env} />)

describe('/landed page', () => {
  it('draws days in order, a card for a summary and a line without, and Earlier carrying the last cursor', () => {
    const rows = [
      row({ ticket: 'ticket-lingtai-103', title: 'third', outcomeAt: new Date(2026, 10, 5, 14, 7) }),
      row({ ticket: 'ticket-lingtai-102', title: 'second', summary: null, outcomeAt: new Date(2026, 10, 5, 9, 30) }),
      row({ ticket: 'ticket-lingtai-101', title: 'first', outcomeAt: new Date(2026, 10, 4, 18, 0) }),
    ]
    const last = rows[2]!
    const out = html(data(rows, { next: { at: last.outcomeAt!, ticket: last.ticket } }))
    expect(out.indexOf('THU')).toBeGreaterThan(-1)
    expect(out.indexOf('Nov 2026')).toBeLessThan(out.lastIndexOf('Nov 2026'))
    expect((out.match(/class="ld-day"/g) ?? []).length).toBe(2)
    expect((out.match(/<article/g) ?? []).length).toBe(2)
    expect(out).toContain('class="ld-line"')
    // headline is the first sentence, the rest follows, the title is the caption
    expect(out).toContain('ld-caption mono">third<')
    expect(out).toContain('The end point now runs on every outcome.')
    expect(out).toContain('It used to skip a close.')
    // facts: attempt, fix rounds, diff, cost, commit and issue links
    expect(out).toContain('Attempt 2 · 1 fix round')
    expect(out).toContain('3 files')
    expect(out).toContain('$1.50')
    expect(out).toContain('https://github.com/steven-zhc/lingtai/commit/abcdef1234567')
    expect(out).toContain('https://github.com/steven-zhc/lingtai/issues/103')
    expect(out).toContain(`href="${landedHref({ before: { at: last.outcomeAt!, ticket: last.ticket } })}"`)
    expect(out).toContain(encodeURIComponent(last.outcomeAt!.toISOString()))
  })

  it('never makes a script in a summary an element: the board renderer shows it as text or drops it', () => {
    for (const summary of ['Hello <script>alert(1)</script> there.', '<script>alert(1)</script>\n\nHello there.']) {
      const out = html(data([row({ summary })]))
      expect(out).not.toContain('<script')
      expect(out).toContain('Hello')
    }
  })

  it('says cost unknown when nothing was priced, and omits the squares for a null diff', () => {
    const unknown = row({ cost: {}, unknownClaims: 1, diffFiles: null, diffInsertions: null, diffDeletions: null })
    const out = html(data([unknown]))
    expect(out).toContain('cost unknown')
    expect(out).not.toContain('$0.00')
    expect(out).not.toContain('ld-sq')
    expect(out).not.toContain(' file')
  })

  it('writes a decision in ink with the move title, the findings, and the clip', () => {
    const r = row({
      waits: [{ waitId: 'w1', at: '', reason: 'x', triage: null, resolution: 'Approve' }],
      summaryClipped: { read: 100, of: 900 },
    })
    const backlog = new Map([
      [r.ticket, [{ key: 'k', claim: 'a minor claim' } as unknown as import('@lingtai/projector').BacklogEntry]],
    ])
    const out = html(data([r], { backlog }))
    expect(out).toContain('A person decided:')
    expect(out).toContain('1 minor finding sent to the backlog')
    expect(out).toContain('a minor claim')
    expect(out).toContain('the reviewer read the first 100 of 900')
    expect(out).not.toMatch(/amber|var\(--signal\)/)
  })

  it('says nothing has landed, or nothing landed for the project, and no Earlier link', () => {
    expect(html(data([]))).toContain('nothing has landed yet')
    const filtered = renderToStaticMarkup(<LandedView data={data([])} query={{ ...query, project: 'p' }} env={env} />)
    expect(filtered).toContain('nothing landed for p')
    expect(filtered).not.toContain('Earlier')
  })

  it('names the backlog failure and still renders the cards', () => {
    const out = html(data([row()], { backlogError: 'boom' }))
    expect(out).toContain('the backlog could not be read')
    expect(out).toContain('<article')
  })
})

describe('/landed appended pages', () => {
  it('totals the pages already shown with this one, and a carry survives the round trip', () => {
    const carry = totalsOf([row(), row({ ticket: 'ticket-lingtai-2' })])
    expect(parseSum(sumText(carry))).toEqual(carry)
    expect(parseSum('1,2')).toBeNull()
    const out = renderToStaticMarkup(<LandedView data={data([row()])} query={query} env={env} carry={carry} />)
    expect(out).toContain('<dd>3</dd>')
    expect(out).toContain('$4.50')
    expect(out).toContain(`data-landed-sum="${sumText(totalsOf([row(), row(), row()]))}"`)
  })

  it('keeps the backlog failure inside the page fragment that is copied on append', () => {
    const out = html(data([row()], { backlogError: 'boom' }))
    const page = out.slice(out.indexOf('data-landed-page'))
    expect(page).toContain('the backlog could not be read')
  })

  it('does not put the unprefixed card or line class on the rail item', () => {
    const out = html(data([row(), row({ ticket: 'ticket-lingtai-2', summary: null })]))
    expect(out).not.toMatch(/<li[^>]*class="(card|line)"/)
  })
})

describe('/landed address and pieces', () => {
  it('round-trips a cursor and ignores garbage', () => {
    const c = { at: new Date('2026-11-05T14:07:00.000Z'), ticket: 'ticket-a-b-9' }
    expect(parseCursor(cursorText(c))).toEqual(c)
    expect(parseCursor('nonsense')).toBeNull()
    expect(parseCursor('not-a-date,ticket-a-1')).toBeNull()
    expect(parseCursor('2026-11-05T14:07:00.000Z,')).toBeNull()
    expect(parseCursor(undefined)).toBeNull()
  })

  it('uses only a kind the recipe names, and a before that parses', () => {
    expect(landedQuery({ kind: 'bug', project: 'p' }, env.kinds)).toEqual({ project: 'p', kind: 'bug', before: null })
    expect(landedQuery({ kind: 'nope', before: 'x' }, env.kinds)).toEqual({ project: null, kind: null, before: null })
  })

  it('gives each kind the slot /report gives it, and the same one under any filter', () => {
    const colour = kindColourOf(env.kinds)
    expect(colour('bug')).toMatch(/^var\(--s[1-4]\)$/)
    expect(colour(null)).toBe('var(--muted)')
    expect(colour('unheard-of')).toBe('var(--muted)')
    expect(kindColourOf(env.kinds)('feature')).toBe(colour('feature'))
  })

  it('groups by local day, newest first', () => {
    const days = groupDays([row(), row({ ticket: 'ticket-lingtai-2', outcomeAt: new Date(2026, 10, 4, 9) })])
    expect(days.map((d) => d.key)).toEqual(['2026-11-05', '2026-11-04'])
  })

  it('costs in words and squares in proportion', () => {
    expect(costText({ reportedCents: 0, estimatedCents: 0, unknown: 2 })).toBe('cost unknown')
    expect(costText({ reportedCents: 120, estimatedCents: 0, unknown: 0 })).toBe('$1.20')
    expect(diffSquares(0, 0)).toEqual(['none', 'none', 'none', 'none', 'none'])
    expect(diffSquares(10, 0)).toEqual(['add', 'add', 'add', 'add', 'add'])
  })
})

describe('the home page Landed heading', () => {
  it('links to /landed, carrying the project filter', () => {
    expect(renderToStaticMarkup(<ColumnLabel id="landed" label="Landed" only="my repo" />)).toContain(
      'href="/landed?project=my%20repo"',
    )
    expect(landedLink(undefined)).toBe('/landed')
    expect(renderToStaticMarkup(<ColumnLabel id="queued" label="Queued" only="p" />)).not.toContain('<a')
  })
})
