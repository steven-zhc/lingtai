/**
 * The project menu: a row per repository, one link each (#993).
 *
 * The menu used to be the projects as tabs, one `recipe` for the project in
 * view, and *add a repository*. It is `all projects` (with two or more), then
 * a row each: the name, which filters, and at the right its own `recipe`, then
 * *add a repository* again (#972). The board with no project configured keeps
 * its link to setup (#169), which is how a first run reaches the wizard.
 *
 * Claims about markup rather than a reducer, since a reducer alone cannot catch
 * a row that renders without its link. `bar.test.ts` reads `projects.tsx` so a
 * class added here is one the bar's amber guard has seen.
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Projects } from '../src/app/projects.tsx'

const html = (filters: string[], app: boolean, only?: string, registered: string[] = filters) =>
  renderToStaticMarkup(<Projects filters={filters} only={only} app={app} registered={registered} locks={new Map()} />)

describe('a paused project (#995)', () => {
  const locks = new Map([['b', [{ kind: 'paused' as const, by: 'x', since: new Date(0) }]]])
  const out = renderToStaticMarkup(
    <Projects filters={['a', 'b']} only={undefined} app registered={['a', 'b']} locks={locks} />,
  )

  it('carries the tag and the resume hint; an unpaused row the pause hint and no tag', () => {
    expect(out.match(/pause-tag/g)).toHaveLength(1)
    expect(out).toContain('recipe · resume')
    expect(out).toContain('recipe · pause')
    expect(out.indexOf('pause-tag')).toBeGreaterThan(out.indexOf('recipe · pause'))
  })
})

/** The menu alone: what sits inside `<details>`. */
const menu = (out: string) => out.slice(out.indexOf('<details'), out.indexOf('</details>'))

describe('the empty board', () => {
  /** #169's slot, unchanged: the sentence is the link, and there is no second one. */
  it("keeps the empty board's one object, and does not add a second beside it", () => {
    const out = html([], false)

    expect(out).toContain('no project configured')
    expect(out).toContain('href="/setup/github-app"')
    expect(out.match(/href=/g)).toHaveLength(1)
  })
})

describe('a row per repository', () => {
  it('is one link to the project, with a recipe hint on a registered one', () => {
    const out = menu(html(['lingtai'], true))

    expect(out.match(/href=/g)).toHaveLength(1)
    expect(out).toContain('href="/?project=lingtai"')
    expect(out).toContain('<span class="phint">recipe · pause</span>')
    expect(out).not.toContain('/recipe/')
  })

  it('draws no hint on a project that is not registered', () => {
    const out = menu(html(['a', 'gone'], true, undefined, ['a']))

    expect(out.match(/class="phint"/g)).toHaveLength(1)
    expect(out.match(/href=/g)).toHaveLength(3)
  })

  it('escapes a name a URL must', () => {
    expect(html(['a b'], true)).toContain('href="/?project=a%20b"')
  })

  it('has no add a repository row inside the menu', () => {
    expect(menu(html(['a', 'b'], true))).not.toContain('add a repository')
  })

  it('adds nothing to the empty board', () => {
    expect(html([], true)).not.toContain('/recipe/')
  })
})

describe('where it lands', () => {
  /**
   * The App is the test, not the register. A board that created the App and
   * has not installed it anywhere yet has nothing registered and wants the
   * picker — `filters.length === 0` would have sent it back to step 0.
   */
  it('sends an empty board to the picker when the App already answers', () => {
    const out = html([], true)

    expect(out).toContain('href="/setup/repository"')
    expect(out).not.toContain('/setup/github-app')
  })

  /** The `+` follows the menu, outside it, and follows the App like the empty slot's link. */
  it('puts the + after the menu, to where the App says', () => {
    for (const [app, where] of [
      [true, '/setup/repository'],
      [false, '/setup/github-app'],
    ] as const) {
      for (const out of [html(['lingtai'], app), html(['lingtai', 'esctest'], app)]) {
        const plus = out.slice(out.indexOf('</details>'))
        expect(plus).toContain(`href="${where}"`)
        expect(plus).toContain('aria-label=')
        expect(plus).toContain('>+</a>')
        expect(menu(out)).not.toContain(where)
      }
    }
  })

  it('has no + on the empty board', () => {
    expect(html([], true)).not.toContain('>+<')
  })
})

describe('which object on the row this is', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')

  it('is handed any GitHub auth, so a gh machine is not sent to create an App (#713)', () => {
    const src = read('../src/app/page.tsx')
    expect(src).toContain('app={hasGitHubAuth()}')
    expect(src).not.toContain('hasGitHubApp')
  })

  const page = read('../src/app/page.tsx')
  const bar = page.slice(page.indexOf('<Bar project={only}'), page.indexOf('<div className="cols">'))
  expect(bar.length).toBeGreaterThan(0)

  /**
   * the-bar.md's rule counts three objects on the row, and the filter is one of
   * them — so what this has to show is not that it escaped the count but that
   * it did not add to it. Nothing new opens inside `.rail`, and the `+` is a
   * tab in a list that was already a list of tabs.
   */
  it('is mounted left of the rail, which keeps the objects it was cut to', () => {
    expect(bar.indexOf('<Projects')).toBeGreaterThan(-1)
    expect(bar.indexOf('<Projects')).toBeLessThan(bar.indexOf('className="rail"'))
    // Nothing new inside the rail: the health dot, the
    // paused/draining chip and the headline, as #134 left them.
    const rail = bar.slice(bar.indexOf('className="rail"'))
    for (const object of ['<Projects', '/setup/repository', '/setup/github-app']) {
      expect(rail).not.toContain(object)
    }
  })

  /**
   * **The objects are named in three files, and the way to get this wrong is to
   * make the `+` fit by redefining them.** `page.tsx` says it twice — once in
   * the module's docstring and once in the rule itself, at the end of `.bar` —
   * and the-bar.md is where a later ticket goes to read what it must argue
   * against. If one of them counted the rail instead, the `+` would look like
   * an object outside the rule rather than an affordance of an object inside
   * it, and the next person would get two answers from one render.
   *
   * Line breaks and comment stars are not the claim, so they are collapsed
   * before the membership is read.
   */
  it('names the objects the bar actually renders, in the code', () => {
    const said = (src: string) => src.replace(/[\s*]+/g, ' ')
    const bar = page.slice(page.indexOf('<Bar project={only}'), page.indexOf('<div className="cols">'))
    expect(bar.length).toBeGreaterThan(0)
    // What the bar draws, read off its markup rather than off its comments.
    const rendered = [
      ['filter', bar.includes('<Projects')],
      ['health', bar.includes('<Health')],
      ['headline', bar.includes('className="head sig"')],
    ]
      .filter(([, present]) => present)
      .map(([name]) => name)
    const named = rendered.join(', ')

    expect(rendered).toEqual(['filter', 'health', 'headline'])
    // Twice in `page.tsx`, and once in `projects.tsx`: each says exactly what is rendered.
    expect(said(page).split(named)).toHaveLength(3)
    expect(said(read('../src/app/projects.tsx'))).toContain(named)
    expect(said(page)).not.toContain('Three objects')
  })

  /** It is a control in the list, and `.reading` is text for the opposite reason. */
  it('is a tab and not a reading', () => {
    const out = html(['lingtai'], true)

    expect(out).toContain('class="tab prj"')
    expect(out).not.toContain('reading')
  })
})

describe('the filter is one menu', () => {
  const order = (out: string, hrefs: string[]) => hrefs.map((h) => out.indexOf(`href="${h}"`))
  const ascending = (xs: number[]) => xs.every((x, i) => x >= 0 && (i === 0 || x > xs[i - 1]!))

  it('draws no menu for the empty board', () => {
    const out = html([], true)

    expect(out).not.toContain('<details')
    expect(out.match(/href=/g)).toHaveLength(1)
  })

  it('names the one project and lists its row, with no all-projects row', () => {
    const out = html(['lingtai'], true, 'lingtai')

    expect(out).toMatch(/<summary>lingtai <span aria-hidden="true">▾<\/span><\/summary>/)
    expect(out).not.toContain('all projects</a>')
  })

  it('names all projects on all, and marks all current', () => {
    const out = html(['a', 'b'], true)

    expect(out).toContain('<summary>all projects ')
    expect(ascending(order(out, ['/', '/?project=a', '/?project=b']))).toBe(true)
    expect(out.match(/aria-current="page"/g)).toHaveLength(1)
    expect(out).toMatch(/aria-current="page"[^>]*>all projects</)
  })

  it('names the project in view, highlights its row and marks its name current', () => {
    const out = html(['a', 'b'], true, 'b')

    expect(out).toContain('<summary>b ')
    expect(out.match(/aria-current="page"/g)).toHaveLength(1)
    expect(out).toMatch(/<a class="tab prj on" aria-current="page" href="\/\?project=b">b</)
  })
})
