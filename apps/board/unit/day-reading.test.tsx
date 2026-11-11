/**
 * `dayReading`, the pure half of the board's day reading: the fetched-prices
 * note is never in `text` (#677) nor the footer's figures.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

import { Live } from '../src/app/live.tsx'
import { dayReading, nearCeiling } from '../src/lib/day-spend.ts'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))

const day = {
  reportedCents: 2224,
  reportedRuns: 3,
  estimatedCents: 1656,
  estimatedRuns: 18,
  fetchedRuns: 18,
  unknown: 0,
  unknownWhy: [],
}

describe('dayReading', () => {
  it('leaves the fetched-prices note out of text', () => {
    expect(dayReading(day, 200).text).not.toContain('LiteLLM')
  })

  it('hands the footer structured figures, not a string', () => {
    const r = dayReading(day, 200)
    expect(r.day).toBe(day)
    expect(r.figure).toBe('$22.24')
    expect(r.ceilingUsd).toBe(200)
    expect(dayReading(day, undefined).ceilingUsd).toBeUndefined()
  })
})

describe('nearCeiling', () => {
  const at = (reportedCents: number, estimatedCents: number, unknown = 0) => ({
    ...day,
    reportedCents,
    estimatedCents,
    unknown,
  })

  it('is null below 80 %', () => {
    expect(nearCeiling(at(10000, 5900), 200)).toBeNull()
  })

  it('shows at exactly 80 % and over the ceiling, as two figures', () => {
    expect(nearCeiling(at(12000, 4000), 200)).toBe('today $120.00 + ~$40.00 of $200.00')
    const over = nearCeiling(at(15000, 6200), 200)
    expect(over).toBe('today $150.00 + ~$62.00 of $200.00')
    expect(over).not.toContain('$212.00')
  })

  it('names unknown runs only when there are some', () => {
    expect(nearCeiling(at(17000, 0, 2), 200)).toMatch(/ \+ 2 unknown$/)
    expect(nearCeiling(at(17000, 0, 0), 200)).not.toContain('unknown')
  })

  it('is null with no ceiling or no reading', () => {
    expect(nearCeiling(at(99999, 0), undefined)).toBeNull()
    expect(nearCeiling(null, 200)).toBeNull()
  })
})

describe('Live', () => {
  const html = (near: string | null) =>
    renderToStaticMarkup(<Live code={null} near={near} runnable={Promise.resolve(null)} />)

  it('draws the sentence after the dot, in .near, without changing the dot', () => {
    const withNear = html('today $150.00 + ~$0.00 of $200.00')
    expect(withNear).toContain('<span class="near">today $150.00 + ~$0.00 of $200.00</span>')
    expect(withNear.indexOf('class="dot')).toBeLessThan(withNear.indexOf('class="near"'))
    expect(withNear.replace(/<span class="near">.*<\/span>/, '')).toBe(html(null))
  })

  it('says nothing extra without one', () => {
    expect(html(null)).not.toContain('near')
  })
})
