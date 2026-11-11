/**
 * The bar every page uses (#947): Lingtai is the way home, Report is at the
 * right, the page's own items sit between, and nothing says `←`.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar } from '../src/app/bar.tsx'

const bar = (project: string | undefined, here?: 'report' | 'recipe', registered?: boolean) =>
  renderToStaticMarkup(
    <Bar project={project} here={here} registered={registered}>
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

  it('holds Recipe, a separator, then Report for a registered project', () => {
    const html = bar('a b', undefined, true)
    const nav = html.slice(html.indexOf('class="topnav"'))
    expect(nav).toContain('href="/recipe/a%20b"')
    expect(nav.indexOf('/recipe/')).toBeLessThan(nav.indexOf('class="vsep"'))
    expect(nav.indexOf('class="vsep"')).toBeLessThan(nav.indexOf('/report'))
  })

  it('holds Report alone with no project, or one that is not registered', () => {
    for (const html of [bar(undefined, undefined, true), bar('a'), bar('a', undefined, false)]) {
      const nav = html.slice(html.indexOf('class="topnav"'))
      expect(nav).toContain('/report')
      expect(nav).not.toContain('/recipe/')
      expect(nav).not.toContain('vsep')
    }
  })

  it('marks Recipe, and not Report, on the recipe page', () => {
    const html = bar('a', 'recipe', true)
    expect(html).toMatch(/<a class="navlink on" aria-current="page" href="\/recipe\/a">Recipe</)
    expect(html).toMatch(/<a class="navlink" href="\/report\?project=a">Report</)
  })
})
