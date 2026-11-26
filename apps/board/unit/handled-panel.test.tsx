/**
 * *Handled for you* on `/report` (#1285), asserted on the static markup.
 */
import type { Handled, HandledProblem } from '@lingtai/conductor/report'
import { PROBLEM_KINDS } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HandledPanel } from '../src/app/report/panels.tsx'
import { reportQuery } from '../src/lib/report.ts'

const NOW = new Date(2026, 10, 19, 12)
const money = { reportedCents: 5000, estimatedCents: 250, unknown: 1 }
const spend = { reportedCents: 20000, estimatedCents: 0, unknown: 0 }

const zero = () => PROBLEM_KINDS.map((kind) => ({ kind, system: 0, you: 0 }))
const handled = (
  counts: Record<string, [number, number]>,
  latest: HandledProblem[] = [],
  needed?: Handled['needed'],
): Handled => ({
  needed:
    needed ??
    Object.entries(counts)
      .filter(([, c]) => c[1] > 0)
      .map(([kind, c]) => ({ kind, move: 'unknown', count: c[1] })),
  kinds: zero().map((k) => ({ ...k, system: counts[k.kind]?.[0] ?? 0, you: counts[k.kind]?.[1] ?? 0 })),
  days: [
    {
      day: '2026-11-18',
      system: Object.values(counts).reduce((n, c) => n + c[0], 0),
      you: Object.values(counts).reduce((n, c) => n + c[1], 0),
      kinds: Object.entries(counts).map(([kind, c]) => ({ kind, system: c[0], you: c[1] })),
    },
  ],
  latest,
  answeringCost: money,
})
const problem = (over: Partial<HandledProblem> = {}): HandledProblem => ({
  kind: 'review-fixed',
  at: new Date(2026, 10, 18, 18, 40).toISOString(),
  attempt: 1,
  answeredBy: 'system',
  waitId: null,
  ticket: 'ticket-lingtai-1258',
  outcome: 'landed',
  ...over,
})

describe('HandledPanel', () => {
  const q = reportQuery({}, NOW)

  it('a NEEDED YOU row says what you did, and tags with one verb are one row (#1288)', () => {
    const out = renderToStaticMarkup(
      <HandledPanel
        handled={handled(
          { 'review-fixed': [0, 7] },
          [],
          [
            { kind: 'review-fixed', move: 'StartNewAttempt', count: 2 },
            { kind: 'review-fixed', move: 'EditBodyAndStartNewAttempt', count: 1 },
            { kind: 'review-fixed', move: 'Approve', count: 3 },
            { kind: 'review-fixed', move: null, count: 1 },
          ],
        )}
        spend={spend}
        query={q}
        problems={null}
      />,
    )
    expect(out).toContain('you approved')
    expect(out.match(/you started it over/g)).toHaveLength(1)
    expect(out).toMatch(/you started it over<\/span><\/td><td class="n"><a [^>]*>3</)
    expect(out).toContain('waiting on you')
  })

  it('says so in one line when nothing was raised', () => {
    const out = renderToStaticMarkup(<HandledPanel handled={handled({})} spend={spend} query={q} problems={null} />)
    expect(out).toContain('id="handled"')
    expect(out).toContain('rp-empty')
    expect(out).not.toContain('hfr-hero')
  })

  it('draws the hero, the two groups, the cost and a link on every count', () => {
    const out = renderToStaticMarkup(
      <HandledPanel
        handled={handled({ 'review-fixed': [3, 0], build: [2, 0], asked: [0, 1] }, [problem()])}
        spend={spend}
        query={q}
        problems={null}
      />,
    )
    expect(out).toMatch(/<b><a [^>]*>5<\/a><\/b>/)
    expect(out).toContain('83%')
    expect(out).toContain('>6</a> problems')
    expect(out).toContain('AI review found problems')
    expect(out).toContain('auto-fixed')
    expect(out).toContain('the agent asked you a question')
    expect(out).toContain('href="/report?handled=review-fixed&amp;by=system#handled"')
    expect(out).toContain('$50.00 reported · ~$2.50 est.')
    expect(out).toContain('+ 1 unpriced')
    expect(out).toContain('of the week&#x27;s spend')
    const unknownOnly = renderToStaticMarkup(
      <HandledPanel
        handled={{ ...handled({ build: [1, 0] }), answeringCost: { reportedCents: 0, estimatedCents: 0, unknown: 2 } }}
        spend={spend}
        query={q}
        problems={null}
      />,
    )
    expect(unknownOnly).not.toContain('of the week')
    expect(out).toContain('<span class="ok">landed</span>')
    expect(out).toContain('/p/lingtai/ticket/1258')
    // no amber
    expect(out).not.toContain('var(--signal)')
    expect(out).not.toContain('var(--warn)')
  })

  it('shows 0 and no rows when nothing needed you', () => {
    const out = renderToStaticMarkup(
      <HandledPanel handled={handled({ stopped: [4, 0] })} spend={spend} query={q} problems={null} />,
    )
    expect(out).toContain('needed you</td><td class="n">0</td>')
    expect(out).not.toContain('tr class="you"')
    expect(out).toContain('100%')
  })

  it('puts a kind a person answered under needed you, with what you did', () => {
    const out = renderToStaticMarkup(
      <HandledPanel handled={handled({ 'review-fixed': [0, 1] })} spend={spend} query={q} problems={null} />,
    )
    expect(out).toContain('class="you"')
    expect(out).toContain('AI review found problems')
    expect(out).toContain('you decided')
  })

  it('lists the problems behind a count, a page at a time', () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      problem({ at: new Date(2026, 10, 18, 12, 0, 59 - i).toISOString(), ticket: `ticket-lingtai-${1000 + i}` }),
    )
    const dq = reportQuery({ handled: 'review-fixed', by: 'system' }, NOW)
    const out = renderToStaticMarkup(
      <HandledPanel handled={handled({ 'review-fixed': [25, 0] })} spend={spend} query={dq} problems={many} />,
    )
    expect(out).toContain('showing 1–20 of 25')
    expect(out).toContain('earlier →')
    expect(out).toContain('← handled for you')
    expect(out).toContain('href="/report#handled"')
  })
})
