import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { landedCount } from '../src/app/footer.tsx'
import { SatisfiedItems } from '../src/app/satisfied-items.tsx'
import { evidenceSource, satisfiedOf } from '../src/lib/task.ts'

describe('the satisfied ending (#1252)', () => {
  it('counts a satisfied card inside the Landed figure', () => {
    expect(landedCount([{ closed: false }, { closed: false }, { closed: true }])).toBe(2)
  })

  it('tags an evidence row with the split child it names, else the base', () => {
    expect(evidenceSource('landed in #1313 as abc', [1313, 1314], 'main')).toBe('#1313')
    expect(evidenceSource('src/a.ts:1', [1313], 'main')).toBe('main')
    expect(evidenceSource('src/a.ts:1', [], null)).toBeNull()
  })

  it('reads the items and the ender off the last TicketSatisfied', () => {
    const e = (actor: string) =>
      [
        {
          type: 'TicketSatisfied',
          actor,
          data: { baseSha: 'abc1234567', bodyVersion: 1, items: [{ item: 'it works', evidence: 'a.ts:1' }] },
        },
      ] as never
    expect(satisfiedOf(e('conductor'))).toMatchObject({ byConductor: true, baseSha: 'abc1234567' })
    expect(satisfiedOf(e('steven'))).toMatchObject({ byConductor: false, actor: 'steven' })
    expect(satisfiedOf([] as never)).toBeNull()
  })

  it('draws each item with its evidence, and says so when there is none', () => {
    const html = renderToStaticMarkup(
      <SatisfiedItems
        items={[
          { item: 'first', evidence: 'a.ts:1' },
          { item: 'second', evidence: '' },
        ]}
        base="main"
      />,
    )
    expect(html).toContain('first')
    expect(html).toContain('a.ts:1')
    expect(html).toContain('no evidence recorded')
    expect(html.match(/>met</g)).toHaveLength(2)
  })
})
