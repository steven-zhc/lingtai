/**
 * The home footer (#905): two figures on a meter, unknown never `$0`, no links (#950), and a source that stays free of server imports.
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Footer, landedCount } from '../src/app/footer.tsx'
import { dayReading } from '../src/lib/day-spend.ts'
import type { FooterLag } from '../src/lib/footer.ts'

const HOME = { path: '/Users/x/.lingtai', shown: '~/.lingtai' }
const run = { reportedRuns: 0, estimatedRuns: 0, fetchedRuns: 0, unknownWhy: [] }
const day = { ...run, reportedRuns: 3, reportedCents: 2615, estimatedCents: 2203, unknown: 2 }
const current = ['task_view', 'finding_backlog', 'spend', 'ticket_report'].map((name) => ({ name, lag: 0 }))
const text = (html: string): string => html.replace(/<[^>]+>/g, '')
const render = (r: ReturnType<typeof dayReading>, landed: number | undefined = 3, lags: FooterLag[] | null = current) =>
  renderToStaticMarkup(<Footer day={r} landed={landed} lags={lags} home={HOME} />)

describe('Footer', () => {
  it('ends with the home, titled with the full path', () => {
    const html = render(dayReading(day, 200))
    expect(html).toContain('home <b>~/.lingtai</b>')
    expect(html).toContain('title="/Users/x/.lingtai — the Lingtai home this board reads"')
    expect(html.indexOf('home-at')).toBeGreaterThan(html.indexOf('projections current'))
    expect(html.endsWith('</span></footer>')).toBe(true)
  })

  it('draws two segments, the two figures and the meter values', () => {
    const r = dayReading(day, 200)
    const html = render(r)
    expect(html).toContain('width:13.075%')
    expect(html).toContain('width:11.015%')
    expect(text(html)).toContain('$26.15 + ~$22.03 of $200 + 2 unknown')
    expect(html).toContain('role="meter"')
    expect(html).toContain('aria-valuemin="0"')
    expect(html).toContain('aria-valuemax="200"')
    expect(html).toContain('aria-valuenow="48.18"')
    expect(html).toContain(`title="${r.text.replace(/&/g, '&amp;')}"`)
  })

  it('says no reported cost over unknown-only days, never $0.00', () => {
    const html = render(dayReading({ ...run, reportedCents: 0, estimatedCents: 0, unknown: 4 }, 200))
    expect(html).toContain('no reported cost')
    expect(html).not.toContain('$0.00 +')
    expect(html).toContain('4 unknown')
  })

  it('draws no meter without a ceiling', () => {
    const html = render(dayReading(day, undefined))
    expect(html).not.toContain('role="meter"')
    expect(text(html)).toContain('$26.15 + ~$22.03')
  })

  it('says a failed read and draws no meter', () => {
    const html = render({
      text: "today's spend could not be read: boom",
      day: null,
      figure: null,
      ceilingUsd: undefined,
    })
    expect(html).toContain('today&#x27;s spend could not be read')
    expect(html).not.toContain('role="meter"')
    expect(html).toContain('boom')
  })

  it('fills the meter and prints the real figures over the ceiling', () => {
    const html = render(dayReading({ ...run, reportedCents: 15000, estimatedCents: 6200, unknown: 0 }, 200))
    expect(text(html)).toContain('$150.00 + ~$62.00 of $200')
    expect(html).toContain('width:75%')
    expect(html).toContain('width:25%')
    expect(html).toContain('aria-valuenow="200"')
  })

  it('draws the landed count on /', () => {
    expect(text(render(dayReading(day, 200)))).toContain('3 landed')
  })

  it('counts landed cards and not closed ones', () => {
    expect(landedCount([{ closed: false }, { closed: true }, { closed: false }])).toBe(2)
  })
})

describe('Footer currency line', () => {
  const r = dayReading(day, 200)

  it('reads current when every lag is 0', () => {
    expect(render(r)).toContain('projections current')
  })

  it('names what is behind, with its rebuild command', () => {
    const html = render(r, 3, [
      { name: 'task_view', lag: 0 },
      { name: 'spend', lag: 3 },
    ])
    expect(html).toContain('spend behind 3')
    expect(html).toContain('title="lingtai projection rebuild spend"')
    expect(html).not.toContain('projections current')
  })

  it('says a projection that was never built', () => {
    const html = render(r, 3, [{ name: 'ticket_report', lag: null }])
    expect(html).toContain('ticket_report not built')
    expect(html).toContain('lingtai projection rebuild ticket_report')
  })

  it('reads unreadable, never current, when the lag could not be read', () => {
    const html = render(r, 3, null)
    expect(html).toContain('projections unreadable')
    expect(html).not.toContain('projections current')
  })

  it('draws no landed count off /, and no link anywhere', () => {
    const off = renderToStaticMarkup(<Footer day={r} lags={current} home={HOME} />)
    expect(off).not.toContain('</b> landed')
    for (const html of [off, render(r)]) {
      expect(html).not.toContain('<a ')
      expect(html).not.toContain('href=')
    }
  })

  it('draws the amounts and the count in <b>, the count as text, and no links', () => {
    const html = render(r)
    expect(html).toContain('<b>$26.15</b> + ~<b>$22.03</b> of $200 + 2 unknown')
    expect(html).toContain('<b>3</b> landed</span>')
  })
})

describe('footer source', () => {
  const src = readFileSync(new URL('../src/app/footer.tsx', import.meta.url), 'utf8')

  it('imports only react and types', () => {
    const imports = src.match(/^import .*$/gm) ?? []
    for (const line of imports) {
      expect(line.startsWith('import type') || /from 'react'/.test(line)).toBe(true)
    }
    expect(src).not.toMatch(/from '@lingtai\//)
  })
})

describe('home page', () => {
  const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8')
  const bar = page.slice(page.indexOf('<Bar project={only}'), page.indexOf('<div className="cols">'))
  expect(bar.length).toBeGreaterThan(0)

  it('has no reading or /report link in the bar, and hands Footer to the frame', () => {
    expect(bar).not.toContain('className="reading"')
    expect(bar).not.toContain('/report')
    expect(bar).not.toContain('spendChip')
    // The frame (#939) renders it after `</main>`; the page only hands it over.
    expect(page).toMatch(/<HomeFrame\s+footer=\{\s*<Footer/)
  })
})
