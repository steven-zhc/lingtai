import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { landedCount } from '../src/app/footer.tsx'
import { SatisfiedItems } from '../src/app/satisfied-items.tsx'
import { evidenceSource, satisfiedOf, withSatisfiedContext } from '../src/lib/task.ts'

describe('the satisfied ending (#1252)', () => {
  it('counts a satisfied card inside the Landed figure, and a closed one out of it', () => {
    expect(landedCount([{ closed: false }, { closed: false }, { closed: true }])).toBe(2)
  })

  it('tags an evidence row with the split child it names, else the base', () => {
    expect(evidenceSource('landed in #1313 as abc', [1313, 1314], 'main')).toBe('#1313')
    expect(evidenceSource('src/a.ts:1', [1313], 'main')).toBe('main')
    expect(evidenceSource('src/a.ts:1', [], null)).toBeNull()
  })

  it('reads the items and the ender off the last TicketSatisfied', () => {
    const one = (actor: string, sha: string, item: string) => ({
      type: 'TicketSatisfied',
      actor,
      data: { baseSha: sha, bodyVersion: 1, items: [{ item, evidence: `${item}.ts:1` }] },
    })
    const e = (...events: ReturnType<typeof one>[]) => events as never
    expect(satisfiedOf(e(one('conductor', 'abc1234567', 'it works')))).toEqual({
      baseSha: 'abc1234567',
      items: [{ item: 'it works', evidence: 'it works.ts:1' }],
      actor: 'conductor',
      byConductor: true,
    })
    expect(satisfiedOf(e(one('steven', 'abc1234567', 'it works')))).toMatchObject({
      byConductor: false,
      actor: 'steven',
    })
    // The last one wins, with its own items.
    expect(satisfiedOf(e(one('conductor', 'aaa1111', 'first'), one('steven', 'bbb2222', 'second')))).toEqual({
      baseSha: 'bbb2222',
      items: [{ item: 'second', evidence: 'second.ts:1' }],
      actor: 'steven',
      byConductor: false,
    })
    expect(satisfiedOf([] as never)).toBeNull()
  })

  it('names the base in the standing sentence, and says nothing of it when unknown', () => {
    const life = { status: 'satisfied', baseSha: 'abcdef1234567', bodyVersion: 1 } as const
    const standing = { who: 'x', reason: null } as never
    expect(withSatisfiedContext(standing, life, 'release', [1313]).who).toBe('found already done on release at abcdef1')
    expect(withSatisfiedContext(standing, life, null, []).who).toBe('found already done at abcdef1')
    expect(withSatisfiedContext(standing, life, 'release', [1313]).satisfiedContext).toEqual({
      base: 'release',
      children: [1313],
    })
  })

  it('draws the source tag the context names', () => {
    const html = renderToStaticMarkup(
      <SatisfiedItems items={[{ item: 'one', evidence: 'landed in #1313 as abc' }]} children={[1313]} base="release" />,
    )
    expect(html).toContain('<span class="ssatisfied-source"> #1313</span>')
    const none = renderToStaticMarkup(<SatisfiedItems items={[{ item: 'one', evidence: 'x' }]} />)
    expect(none).not.toContain('ssatisfied-source')
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
