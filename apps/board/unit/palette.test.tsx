import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PaletteView } from '../src/app/palette'
import { PAGES, buildIndex, isOpenKey, paletteKey, search, type Entry, type Index } from '../src/lib/search'

const card = (issue: string, title: string, project = 'lingtai', state = 'running') =>
  ({ taskId: `ticket-${project}-${issue}`, project, issue, title, state }) as never

const index: Index = buildIndex({
  tasks: [card('874', 'the shape of the bar'), card('12', 'lingtai docs'), card('900', 'empty', 'other', 'waiting')],
  projects: ['lingtai'],
  app: true,
})

describe('search', () => {
  it.each(['#874', '874'])('ranks the ticket for %s first', (q) => {
    expect(search(index, q)[0]?.href).toBe('/task/ticket-lingtai-874')
  })
  it('finds a ticket by a title word', () => {
    expect(search(index, 'shape').map((e) => e.group)).toEqual(['Tickets'])
  })
  it('lists project, recipe and tickets in group order for a project name', () => {
    const groups = search(index, 'lingtai').map((e) => e.group)
    expect(groups).toContain('Projects')
    expect(groups.indexOf('Projects')).toBeLessThan(groups.indexOf('Recipes'))
    expect(groups.indexOf('Recipes')).toBeLessThan(groups.indexOf('Tickets'))
  })
  it('lists pages and projects and no tickets for an empty query', () => {
    const groups = new Set(search(index, '').map((e) => e.group))
    expect(groups).toEqual(new Set(['Pages', 'Projects']))
  })
  it('caps each group at 8', () => {
    const many = buildIndex({
      tasks: Array.from({ length: 30 }, (_, i) => card(String(100 + i), 'same')),
      projects: [],
      app: true,
    })
    expect(search(many, 'same')).toHaveLength(8)
  })
  it('points add-a-repository by whether the App answers', () => {
    const href = (app: boolean) =>
      buildIndex({ tasks: [], projects: [], app }).entries.find((e) => e.label === 'add a repository')?.href
    expect(href(true)).toBe('/setup/repository')
    expect(href(false)).toBe('/setup/github-app')
  })
  it('says a failed read in problems and leaves its group out', () => {
    const i = buildIndex({ tasks: new Error('boom'), projects: ['lingtai'], app: true })
    expect(i.problems[0]).toContain('tickets could not be read: boom')
    expect(i.entries.some((e) => e.group === 'Tickets')).toBe(false)
  })
  it('shows an empty title as the number alone', () => {
    expect(index.entries.find((e) => e.href.endsWith('-900'))?.label).toBe('#900 empty')
    const i = buildIndex({ tasks: [card('5', '')], projects: [], app: true })
    expect(i.entries.find((e) => e.group === 'Tickets')?.label).toBe('#5')
  })
})

describe('paletteKey', () => {
  const rs: Entry[] = ['/a', '/b', '/c'].map((href) => ({ group: 'Pages', label: href, href, keys: [] }))
  const k = (key: string, more = {}) => paletteKey({ selected: 0 }, rs, { key, ...more })
  it('wraps and jumps', () => {
    expect(paletteKey({ selected: 2 }, rs, { key: 'ArrowDown' }).state.selected).toBe(0)
    expect(k('ArrowUp').state.selected).toBe(2)
    expect(k('End').state.selected).toBe(2)
    expect(paletteKey({ selected: 2 }, rs, { key: 'Home' }).state.selected).toBe(0)
  })
  it('Enter goes, with Ctrl/Meta in a new tab; Escape closes', () => {
    expect(paletteKey({ selected: 1 }, rs, { key: 'Enter' }).effect).toEqual({ go: '/b', newTab: false })
    expect(paletteKey({ selected: 1 }, rs, { key: 'Enter', metaKey: true }).effect).toEqual({ go: '/b', newTab: true })
    expect(k('Escape').effect).toEqual({ close: true })
  })
  it('changes nothing while composing', () => {
    for (const c of [{ isComposing: true }, { keyCode: 229 }]) {
      expect(paletteKey({ selected: 0 }, rs, { key: 'Enter', ...c })).toEqual({ state: { selected: 0 }, effect: null })
      expect(paletteKey({ selected: 0 }, rs, { key: 'ArrowDown', ...c }).state.selected).toBe(0)
    }
  })
  it('opens on ⌘K on macOS and Ctrl+K elsewhere, never while composing', () => {
    expect(isOpenKey({ key: 'k', metaKey: true }, true)).toBe(true)
    expect(isOpenKey({ key: 'K', metaKey: true }, true)).toBe(true)
    expect(isOpenKey({ key: 'k', ctrlKey: true }, true)).toBe(false)
    expect(isOpenKey({ key: 'k', ctrlKey: true }, false)).toBe(true)
    expect(isOpenKey({ key: 'k', metaKey: true }, false)).toBe(false)
    expect(isOpenKey({ key: 'k', metaKey: true, isComposing: true }, true)).toBe(false)
    expect(isOpenKey({ key: 'k', metaKey: true, keyCode: 229 }, true)).toBe(false)
  })
})

describe('PaletteView', () => {
  it('names the selected option from the combobox and draws group headings', () => {
    const html = renderToStaticMarkup(<PaletteView index={index} query="lingtai" selected={1} problems={[]} />)
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-controls="palette-list"')
    expect(html).toContain('aria-activedescendant="palette-opt-1"')
    expect(html).toMatch(/id="palette-opt-1"[^>]*aria-selected="true"/)
    for (const g of ['Projects', 'Recipes', 'Tickets']) expect(html).toContain(`>${g}<`)
  })
  it('says a problem, a failed fetch and a pending read in words', () => {
    const withProblem = renderToStaticMarkup(
      <PaletteView
        index={{ ...index, problems: ['tickets could not be read: boom'] }}
        query=""
        selected={0}
        problems={['tickets could not be read: boom']}
      />,
    )
    expect(withProblem).toContain('tickets could not be read: boom')
    const failed = renderToStaticMarkup(
      <PaletteView index={null} query="x" selected={0} problems={['the board could not be asked']} />,
    )
    expect(failed).toContain('the board could not be asked')
    expect(failed).not.toContain('nothing matches')
    const pending = renderToStaticMarkup(<PaletteView index="pending" query="x" selected={0} problems={[]} />)
    expect(pending).toContain('reading the log…')
    expect(pending).not.toContain('nothing matches')
  })
  it('says nothing matches only for a real answer', () => {
    const html = renderToStaticMarkup(<PaletteView index={index} query="zzzz" selected={0} problems={[]} />)
    expect(html).toContain('nothing matches')
    expect(html).not.toContain('aria-activedescendant')
  })
})

describe('the client graph', () => {
  const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const valueImports = (s: string) =>
    [...s.matchAll(/^import (?!type)[^\n]*?from ['"]([^'"]+)['"]/gm)].map((m) => m[1] as string)
  it('palette.tsx is "use client" and imports only what a client may', () => {
    const s = src('../src/app/palette.tsx')
    expect(s).toMatch(/^['"]use client['"]/m)
    for (const from of valueImports(s)) {
      expect(from.startsWith('@lingtai/')).toBe(false)
      if (from.startsWith('@/')) expect(from).toBe('@/lib/search')
    }
  })
  it.each(['../src/app/skeleton.tsx', '../src/lib/search.ts'])('%s has no value import of the server', (p) => {
    for (const from of valueImports(src(p))) {
      expect(from.startsWith('@lingtai/')).toBe(false)
      expect(from.startsWith('@/')).toBe(false)
    }
  })
})

describe('the page list', () => {
  const EXCLUDED: Record<string, string> = {
    '/setup/github-app': 'the target of add a repository, chosen by the server',
    '/setup/repository': 'the target of add a repository, chosen by the server',
    '/setup/wizard': 'a bookmark kept so old links answer something',
    '/dev/waiting': 'a developer page',
  }
  const root = new URL('../src/app', import.meta.url).pathname
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f)
      return statSync(p).isDirectory() ? walk(p) : f === 'page.tsx' ? [p] : []
    })
  const routes = walk(root)
    .map((p) => '/' + relative(root, p).replace(/\/?page\.tsx$/, ''))
    .map((r) => (r === '/' ? '/' : r.replace(/\/$/, '')))
    .filter((r) => !r.includes('['))
  it('finds every static page in PAGES or EXCLUDED', () => {
    const listed = new Set([...PAGES.map((p) => p.href), ...Object.keys(EXCLUDED)])
    expect(routes.filter((r) => !listed.has(r))).toEqual([])
  })
  it('lists nothing that no longer exists', () => {
    expect([...PAGES.map((p) => p.href), ...Object.keys(EXCLUDED)].filter((r) => !routes.includes(r))).toEqual([])
  })
})
