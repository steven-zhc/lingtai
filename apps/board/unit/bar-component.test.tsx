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
    expect(bar('a b')).toMatch(/<a class="brand" href="\/p\/a%20b\/ticket">/)
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
    expect(nav).toContain('href="/p/a%20b/recipe"')
    expect(nav.indexOf('/recipe"')).toBeLessThan(nav.indexOf('class="vsep"'))
    expect(nav.indexOf('class="vsep"')).toBeLessThan(nav.indexOf('/report'))
  })

  it('holds Report alone with no project, or one that is not registered', () => {
    for (const html of [bar(undefined, undefined, true), bar('a'), bar('a', undefined, false)]) {
      const nav = html.slice(html.indexOf('class="topnav"'))
      expect(nav).toContain('/report')
      expect(nav).not.toContain('/recipe"')
      expect(nav).not.toContain('vsep')
    }
  })

  it('marks Recipe, and not Report, on the recipe page', () => {
    const html = bar('a', 'recipe', true)
    expect(html).toMatch(/<a class="navlink on" aria-current="page" href="\/p\/a\/recipe">Recipe</)
    expect(html).toMatch(/<a class="navlink" href="\/report\?project=a">Report</)
  })
})

describe('Bar and the sandbox shield (#1183)', () => {
  it('holds no shield in .topnav, on a registered project or on all', () => {
    for (const html of [
      renderToStaticMarkup(<Bar project="x" registered />),
      renderToStaticMarkup(<Bar project={undefined} />),
    ]) {
      expect(html.slice(html.indexOf('class="topnav"'))).not.toContain('sbx')
    }
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
    expect(html).toContain('href="/p/a/recipe#sandbox"')
  })
})
