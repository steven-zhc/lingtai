/**
 * The place line on the pages that were neither the home page nor a view (#1499): the project pages' bar (`RecipeBar`
 * with `tail`), and the global pages' (`SetupBar`, `ReportBar`). Asserts structure — class names, `aria-current`,
 * `data-go` — and not exact copy.
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ReportBar, SetupBar } from '../src/app/global-bars.tsx'
import { RecipeBar } from '../src/app/p/[project]/recipe/recipe-bar.tsx'

const common = { filters: ['a', 'b'], registered: ['a', 'b'], app: true, locks: new Map() }
const topnav = (html: string) => html.slice(html.indexOf('class="topnav"'))
const crumbs = (html: string) => [...html.matchAll(/<span class="crumb">([^<]*)<\/span>/g)].map((m) => m[1])

const noChipNoCurrent = (html: string) => {
  expect(html).not.toMatch(/class="chip/)
  // `aria-current` is the attribute, not the label the chips used to carry.
  expect(html.replace(/aria-current="page"/g, '')).not.toContain('current')
  expect(topnav(html)).not.toContain('>Recipe<')
  expect(topnav(html)).not.toContain('Setup')
}

describe('a project page: Landed', () => {
  const html = renderToStaticMarkup(
    <RecipeBar project="a" here="tickets" tail="Landed" pause={<button>Pause</button>} {...common} />,
  )
  it('is Lingtai / project / views / Landed, with Tickets selected', () => {
    expect(html).toContain('class="filter"')
    expect(html).toMatch(/<a class="view on" aria-current="page"[^>]*>Tickets</)
    expect(crumbs(html)).toEqual(['Landed'])
    expect(html).toContain('data-go="t"')
  })
  it('has Pause for a registered project, no chip, no current, no Recipe in .topnav', () => {
    expect(html).toContain('Pause')
    noChipNoCurrent(html)
  })
})

describe('a project page: an unregistered project', () => {
  const html = renderToStaticMarkup(<RecipeBar project="z" here="tickets" tail="Landed" {...common} />)
  it('has no Pause and no pacts', () => {
    expect(html).not.toContain('Pause')
    expect(html).not.toContain('pacts')
    expect(html).not.toContain('vsep')
    noChipNoCurrent(html)
  })
})

describe('a project page: all projects', () => {
  const html = renderToStaticMarkup(<RecipeBar project={undefined} here="tickets" tail="Landed" {...common} />)
  it('names all projects, with Tickets alone and no project actions', () => {
    expect(html).toContain('all projects')
    expect(html).not.toContain('>PRs<')
    expect(html).not.toContain('>Recipe<')
    expect(html).not.toContain('pacts')
    noChipNoCurrent(html)
  })
})

describe('a project page: all projects with nothing listed', () => {
  const html = renderToStaticMarkup(
    <RecipeBar project={undefined} here="tickets" tail="Landed" {...common} filters={[]} registered={[]} />,
  )
  it('still draws the all projects menu, so G S has something to open', () => {
    expect(html).toContain('class="filter"')
    expect(html).toContain('all projects')
  })
})

describe('a project page: Backlog', () => {
  const html = renderToStaticMarkup(<RecipeBar project="a" here={null} tail="Backlog" {...common} />)
  it('selects no view', () => {
    // The project menu marks its selected row `on`; the views are what must select nothing.
    const views = html.slice(html.indexOf('class="views"'), html.indexOf('class="topnav"'))
    expect(views).toContain('>Tickets<')
    expect(views).not.toContain('view on')
    expect(views).not.toContain('aria-current')
    expect(crumbs(html)).toEqual(['Backlog'])
    noChipNoCurrent(html)
  })
})

describe('Report', () => {
  const html = renderToStaticMarkup(<ReportBar project="a" registered pause={<button>Pause</button>} />)
  it('is Lingtai / Report with no menu, views or keys', () => {
    expect(crumbs(html)).toEqual(['Report'])
    expect(html).not.toContain('details')
    expect(html).not.toContain('data-go')
    expect(html).not.toContain('class="views"')
    noChipNoCurrent(html)
  })
  it('marks its own link current, and keeps Pause for a registered project', () => {
    expect(html).toMatch(/<a class="navlink on"[^>]*aria-current="page"[^>]*>Report</)
    expect(html).toContain('Pause')
  })
  it('has no Pause for an unregistered one', () => {
    expect(renderToStaticMarkup(<ReportBar project="z" registered={false} />)).not.toContain('pacts')
  })
})

describe('Setup', () => {
  it.each(['Repository', 'GitHub App', 'Claude token'])('%s is Lingtai / Setup / step', (step) => {
    const html = renderToStaticMarkup(<SetupBar step={step} />)
    expect(crumbs(html)).toEqual(['Setup', step])
    expect(html).not.toContain('data-go')
    expect(html).not.toContain('class="filter"')
    noChipNoCurrent(html)
  })
  it('is Lingtai / Setup alone with no step', () => {
    expect(crumbs(renderToStaticMarkup(<SetupBar />))).toEqual(['Setup'])
  })
})

describe('the bars stay out of the server graph', () => {
  it('global-bars.tsx imports no @/lib', () => {
    const src = readFileSync(new URL('../src/app/global-bars.tsx', import.meta.url), 'utf8')
    expect(src).not.toMatch(/from ['"]@\/lib/)
    expect(src).not.toMatch(/^['"]use client['"]/m)
  })
})
