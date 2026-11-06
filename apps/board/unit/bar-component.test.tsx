/**
 * The bar every page uses (#947): Lingtai is the way home, Report is at the
 * right, the page's own items sit between, and nothing says `←`.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar } from '../src/app/bar.tsx'

const bar = (project: string | undefined, here?: 'report') =>
  renderToStaticMarkup(
    <Bar project={project} here={here}>
      <span className="sep" />
      <span>middle</span>
    </Bar>,
  )

describe('Bar', () => {
  it('links Lingtai home, with the project where there is one', () => {
    expect(bar(undefined)).toMatch(/<a class="brand" href="\/">/)
    expect(bar('a b')).toMatch(/<a class="brand" href="\/\?project=a%20b">/)
  })

  it('links Report, carrying the project only when one is in view', () => {
    expect(bar(undefined)).toContain('href="/report"')
    expect(bar('a b')).toContain('href="/report?project=a%20b"')
  })

  it('has no arrow', () => {
    expect(bar('x')).not.toContain('←')
  })

  it("puts the page's items between the brand and Report", () => {
    const html = bar(undefined)
    expect(html.indexOf('Lingtai')).toBeLessThan(html.indexOf('middle'))
    expect(html.indexOf('middle')).toBeLessThan(html.indexOf('class="topnav"'))
  })

  it('marks Report as the current page only on /report', () => {
    expect(bar(undefined, 'report')).toContain('aria-current="page"')
    expect(bar(undefined)).not.toContain('aria-current')
  })
})
