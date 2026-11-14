/**
 * The bar every page uses (#947): Lingtai is the way home, Report is at the
 * right, the page's own items sit between, and nothing says `←`.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar } from '../src/app/bar.tsx'
import type { SandboxMark } from '../src/lib/sandbox-state.ts'

const bar = (project: string | undefined, here?: 'report' | 'recipe', registered?: boolean) =>
  renderToStaticMarkup(
    <Bar project={project} here={here} registered={registered}>
      <span className="sep" />
      <span>middle</span>
    </Bar>,
  )

const mark = (names: string[]): SandboxMark => ({
  state: 'degraded',
  projects: names.map((project) => ({ project, sentence: 'degraded' })),
  sentence: 'sandbox degraded',
})
const withIcon = (names: string[]) => renderToStaticMarkup(<Bar project={undefined} sandbox={mark(names)} />)
/** The one element the 0.14 exception admits into `.topnav` (#1163), whichever form it takes. */
const SANDBOX_ICON = /<(a|details) class="sbx[^"]*"[\s\S]*?<\/\1>/

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
      const nav = html.slice(html.indexOf('class="topnav"')).replace(SANDBOX_ICON, '')
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

  it('draws the sandbox icon as a plain link before Report when one project is worst', () => {
    const html = withIcon(['a b'])
    expect(html).toContain('<a class="sbx sbx-degraded"')
    expect(html).toContain('href="/recipe/a%20b#sandbox"')
    expect(html).toContain('aria-label="sandbox degraded"')
    expect(html.indexOf('class="sbx')).toBeLessThan(html.indexOf('/report'))
    expect(html.replace(SANDBOX_ICON, '')).not.toContain('sbx')
  })

  it('draws a details disclosure listing each project when several tie', () => {
    const html = withIcon(['a', 'b'])
    expect(html).toContain('<details class="sbx-list sbx-degraded">')
    expect(html).toContain('<summary class="sbx" aria-label="sandbox degraded"')
    expect(html).toContain('href="/recipe/a#sandbox"')
    expect(html).toContain('href="/recipe/b#sandbox"')
    expect(html.indexOf('<details')).toBeLessThan(html.indexOf('/report'))
  })

  it('draws nothing without a sandbox prop', () => {
    expect(bar(undefined)).not.toContain('sbx')
  })
})
