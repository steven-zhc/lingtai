import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Skeleton } from '@/app/skeleton'

// 0111 §15: a placeholder is its shape alone — no label, visible or for a reader of the text.
const text = (html: string) => html.replace(/<[^>]*>/g, '')
const count = (html: string, cls: string) => html.match(new RegExp(`class="${cls}"`, 'g'))?.length ?? 0

describe('Skeleton', () => {
  it('draws card outlines and no words', () => {
    const html = renderToStaticMarkup(<Skeleton shape="card" count={2} />)
    expect(count(html, 'sk-card')).toBe(2)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('aria-label')
    expect(text(html)).toBe('')
  })

  it('draws lines and no words', () => {
    const html = renderToStaticMarkup(<Skeleton shape="lines" count={2} />)
    expect(count(html, 'sk-bar sk-line')).toBe(2)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('aria-label')
    expect(text(html)).toBe('')
  })

  it('draws cells and no words', () => {
    const html = renderToStaticMarkup(<Skeleton shape="cells" count={2} />)
    expect(count(html, 'sk-bar sk-cell')).toBe(2)
    expect(html).toContain('aria-busy="true"')
    expect(html).not.toContain('aria-label')
    expect(text(html)).toBe('')
  })

  it.each(['card', 'lines', 'cells'] as const)('draws an empty container for %s at count 0', (shape) => {
    const html = renderToStaticMarkup(<Skeleton shape={shape} count={0} />)
    expect(html).toContain('class="skeleton"')
    expect(html).not.toMatch(/sk-(card|line|cell)"/)
    expect(text(html)).toBe('')
  })
})
