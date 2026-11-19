import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HandledCard } from '../src/app/handled-card'
import { handledToday } from '../src/lib/handled-today'

const kinds = (rows: [string, number, number][]) =>
  ({ kinds: rows.map(([kind, system, you]) => ({ kind, system, you })) }) as never

describe('handledToday', () => {
  it('is null with no problem today', () => {
    expect(handledToday(kinds([['a', 0, 0]]))).toBeNull()
  })
  it('keeps four kinds, most first, and folds the rest', () => {
    const t = handledToday(
      kinds([
        ['a', 1, 0],
        ['b', 5, 0],
        ['c', 3, 1],
        ['d', 0, 0],
        ['e', 2, 0],
        ['f', 1, 0],
        ['g', 4, 0],
      ]),
    )!
    expect(t.kinds.map((k) => k.kind)).toEqual(['b', 'g', 'c', 'e'])
    expect(t.more).toMatchObject({ kinds: 2, problems: 2 })
    expect(t.solved).toBe(16)
    expect(t.needed).toBe(1)
    expect(t.percent).toBe(94)
  })
  it('is 100% when nothing needed the person, and shows a card when only needs exist', () => {
    expect(handledToday(kinds([['a', 2, 0]]))!.percent).toBe(100)
    const t = handledToday(kinds([['a', 0, 3]]))!
    expect(t.percent).toBe(0)
    expect(t.kinds).toEqual([])
  })
})

describe('HandledCard', () => {
  it('renders the footer and links', () => {
    const t = handledToday(kinds([['a', 2, 1]]))!
    const html = renderToStaticMarkup(<HandledCard today={t} todayHref="/report?window=today" weekHref="/report" />)
    expect(html).toContain('Nothing needs you')
    expect(html).toContain('<b>67%</b> without you · 1 needed you')
    expect(html).toContain('href="/report#handled"')
  })
  it('explains each kind and draws one mark per problem, hollow for the ones that needed you', () => {
    const t = handledToday(
      kinds([
        ['review-fixed', 2, 1],
        ['base-moved', 1, 0],
      ]),
    )!
    const html = renderToStaticMarkup(<HandledCard today={t} todayHref="/report?window=today" weekHref="/report" />)
    expect(html).toContain('AI review found problems')
    expect(html).toContain('newer changes landed first')
    expect(html).toContain('auto-merged, re-tested')
    expect(html).not.toContain('review-fixed')
    expect((html.match(/<i /g) ?? []).length).toBe(4 + 2)
    expect((html.match(/class="you"/g) ?? []).length).toBe(1)
  })
})
