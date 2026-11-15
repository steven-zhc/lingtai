import { SANDBOX_REQUIRED_REFUSAL } from '@lingtai/recipe'
/**
 * The bar every page uses (#947): Lingtai is the way home, Report is at the
 * right, the page's own items sit between, and nothing says `←`.
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar, SandboxIcon } from '../src/app/bar.tsx'
import { sandboxState, worstOf } from '../src/lib/sandbox-state.ts'

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

describe('Bar and the sandbox icon (#1163)', () => {
  const icon = (
    <a className="sbx sbx-sandboxed" href="/recipe/x#sandbox" aria-label="sandbox sandboxed" title="sandbox sandboxed">
      <span className="sbx-mark" aria-hidden="true" />
    </a>
  )
  const withIcon = renderToStaticMarkup(<Bar project="x" registered sandbox={icon} />)
  const nav = withIcon.slice(withIcon.indexOf('class="topnav"'))

  it('draws the icon in .topnav before Report', () => {
    expect(nav.indexOf('class="sbx')).toBeGreaterThan(-1)
    expect(nav.indexOf('class="sbx')).toBeLessThan(nav.indexOf('/report'))
  })

  it('admits exactly that icon: nothing else new in .topnav', () => {
    // Byte-for-byte: the bar with the icon, less the icon's own markup, is the bar without it. Anything else
    // added to `.topnav` (a `/spend` link, a chip) breaks the equality.
    const iconHtml = renderToStaticMarkup(icon)
    expect(withIcon.split(iconHtml)).toHaveLength(2)
    expect(withIcon.replace(iconHtml, '')).toBe(renderToStaticMarkup(<Bar project="x" registered />))
    const bare = renderToStaticMarkup(<Bar project="x" sandbox={icon} />)
    expect(bare.replace(iconHtml, '')).toBe(renderToStaticMarkup(<Bar project="x" />))
    expect(bare.replace(iconHtml, '')).not.toContain('/recipe/')
    expect(bare.replace(iconHtml, '')).not.toContain('vsep')
  })

  it('lists each project of a tie in a details disclosure whose name is the sentence', () => {
    const mark = worstOf(
      new Map([
        ['a', sandboxState({ refused: SANDBOX_REQUIRED_REFUSAL, declared: 'none', observed: null })],
        ['b', sandboxState({ refused: SANDBOX_REQUIRED_REFUSAL, declared: 'none', observed: null })],
      ]),
    )!
    const html = renderToStaticMarkup(<SandboxIcon mark={mark} />)
    expect(html).toContain('<details')
    expect(html).toContain(`<summary class="sbx" aria-label="${mark.sentence}" title="${mark.sentence}">`)
    expect(html.match(/<li>/g)).toHaveLength(2)
    expect(html).toContain('href="/recipe/a#sandbox"')
  })
})
