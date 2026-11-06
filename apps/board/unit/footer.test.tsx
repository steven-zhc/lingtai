/**
 * The home footer (#905): two figures on a meter, unknown never `$0`, links that
 * carry `?project=`, and a source that stays free of server imports.
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Footer, landedCount } from '../src/app/footer.tsx'
import { dayReading } from '../src/lib/day-spend.ts'

const run = { reportedRuns: 0, estimatedRuns: 0, fetchedRuns: 0, unknownWhy: [] }
const day = { ...run, reportedRuns: 3, reportedCents: 2615, estimatedCents: 2203, unknown: 2 }
const render = (r: ReturnType<typeof dayReading>, project?: string, landed = 3) =>
  renderToStaticMarkup(<Footer day={r} project={project} landed={landed} />)

describe('Footer', () => {
  it('draws two segments, the two figures and the meter values', () => {
    const r = dayReading(day, 200)
    const html = render(r)
    expect(html).toContain('width:13.075%')
    expect(html).toContain('width:11.015%')
    expect(html).toContain('$26.15 + ~$22.03 of $200 + 2 unknown')
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
    expect(html).toContain('$26.15 + ~$22.03')
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
    expect(html).toContain('$150.00 + ~$62.00 of $200')
    expect(html).toContain('width:75%')
    expect(html).toContain('width:25%')
    expect(html).toContain('aria-valuenow="200"')
  })

  it('carries ?project= on every link, and none when unfiltered', () => {
    const filtered = render(dayReading(day, 200), 'a b')
    for (const path of ['/landed', '/report', '/spend']) expect(filtered).toContain(`href="${path}?project=a%20b"`)
    const plain = render(dayReading(day, 200))
    for (const path of ['/landed', '/report', '/spend']) expect(plain).toContain(`href="${path}"`)
    expect(plain).toContain('3 landed')
  })

  it('counts landed cards and not closed ones', () => {
    expect(landedCount([{ closed: false }, { closed: true }, { closed: false }])).toBe(2)
  })
})

describe('footer source', () => {
  const src = readFileSync(new URL('../src/app/footer.tsx', import.meta.url), 'utf8')

  it('imports only react, next/link and types', () => {
    const imports = src.match(/^import .*$/gm) ?? []
    for (const line of imports) {
      expect(line.startsWith('import type') || /from 'next\/link'|from 'react'/.test(line)).toBe(true)
    }
    expect(src).not.toMatch(/from '@lingtai\//)
  })
})

describe('home page', () => {
  const page = readFileSync(new URL('../src/app/page.tsx', import.meta.url), 'utf8')
  const bar = page.slice(page.indexOf('<div className="bar">'), page.indexOf('<div className="cols">'))

  it('has no reading or /report link in the bar, and mounts Footer after the columns', () => {
    expect(bar).not.toContain('className="reading"')
    expect(bar).not.toContain('/report')
    expect(page.indexOf('<Footer')).toBeGreaterThan(page.indexOf('<div className="cols">'))
  })
})
