/**
 * The place line (0.16): `Lingtai / <project ▾> / Tickets · Recipe`, the visible `Search ⌘K`
 * field, and the keys that work outside a field. Markup and reducers; no DOM.
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Bar } from '../src/app/bar.tsx'
import { PlaceLine, placeViews, viewsFor } from '../src/app/place-line.tsx'
import { GO_WINDOW_MS, goKey, isHashKey, type GoState } from '../src/lib/search.ts'

const line = (project: string | undefined, here: 'tickets' | 'recipe') =>
  renderToStaticMarkup(<PlaceLine project={project} views={viewsFor(project)} here={here} />)

describe('PlaceLine', () => {
  it('draws the crumb, then Tickets, then Recipe, with the current view marked', () => {
    const tickets = line('a', 'tickets')
    expect(tickets.indexOf('>a<')).toBeLessThan(tickets.indexOf('>Tickets<'))
    expect(tickets.indexOf('>Tickets<')).toBeLessThan(tickets.indexOf('>Recipe<'))
    expect(tickets).toMatch(/<a class="view on" aria-current="page"[^>]*>Tickets</)
    expect(tickets).toMatch(/<a class="view" href="\/p\/a\/recipe">Recipe</)
    expect(line('a', 'recipe')).toMatch(/<a class="view on" aria-current="page" href="\/p\/a\/recipe">Recipe</)
  })

  it('names its keys only in tooltips', () => {
    expect(line('a', 'tickets')).toContain('title="Tickets · G T"')
    expect(line('a', 'tickets')).toContain('data-go="t"')
  })

  it('draws Tickets alone with all projects', () => {
    const out = line(undefined, 'tickets')
    expect(out).toContain('>Tickets<')
    expect(out).not.toContain('Recipe')
  })

  it('paints a badge with the fail colour class and never a signal one', () => {
    const out = renderToStaticMarkup(
      <PlaceLine
        project="a"
        here="tickets"
        views={[{ id: 'prs', label: 'PRs', href: '/prs', key: 'P', badge: { n: 2, title: 'two' } }]}
      />,
    )
    expect(out).toContain('<span class="badge" title="two">2</span>')
    expect(out).toContain('data-go="p"')
  })

  it('puts the fifth view under More', () => {
    const five = ['a', 'b', 'c', 'd', 'e']
    expect(placeViews(five)).toEqual({ line: ['a', 'b', 'c', 'd'], more: ['e'] })
    expect(placeViews(['a']).more).toEqual([])
    const out = renderToStaticMarkup(
      <PlaceLine project="a" views={five.map((id) => ({ id, label: id.toUpperCase(), href: `/${id}` }))} />,
    )
    expect(out).toContain('class="more"')
    expect(out.indexOf('>D<')).toBeLessThan(out.indexOf('More'))
    expect(out.indexOf('More')).toBeLessThan(out.indexOf('>E<'))
  })
})

describe('the Search field', () => {
  it('is a button the palette opens on, with its key in the title', () => {
    const out = renderToStaticMarkup(<Bar project={undefined} />)
    expect(out).toMatch(/<button type="button" class="search" data-palette="true" title="Search · ⌘K \/ Ctrl K">/)
    expect(out.indexOf('class="search"')).toBeLessThan(out.indexOf('>Report<'))
    const palette = readFileSync(new URL('../src/app/palette.tsx', import.meta.url), 'utf8')
    expect(palette).toContain("closest('[data-palette]')")
  })

  it('keeps Recipe in .topnav on a bar that draws no place line', () => {
    const out = renderToStaticMarkup(<Bar project="a" registered />)
    expect(out.slice(out.indexOf('class="topnav"'))).toContain('>Recipe<')
  })
})

describe('the keys', () => {
  const page = { tag: 'BODY', editable: false }
  const none: GoState = { armedAt: null }
  const press = (state: GoState, key: string, now: number, t = page, more = {}) =>
    goKey(state, { key, ...more }, t, now)

  it('opens the palette on # outside a field only', () => {
    expect(isHashKey({ key: '#' }, page)).toBe(true)
    for (const t of ['INPUT', 'TEXTAREA', 'SELECT'])
      expect(isHashKey({ key: '#' }, { tag: t, editable: false })).toBe(false)
    expect(isHashKey({ key: '#' }, { tag: 'DIV', editable: true })).toBe(false)
    expect(isHashKey({ key: '#', isComposing: true }, page)).toBe(false)
    expect(isHashKey({ key: '#', keyCode: 229 }, page)).toBe(false)
    expect(isHashKey({ key: '#', metaKey: true }, page)).toBe(false)
    expect(isHashKey({ key: '3' }, page)).toBe(false)
  })

  it.each(['t', 'p', 's'] as const)('g then %s goes', (second) => {
    const armed = press(none, 'g', 1000)
    expect(armed.effect).toBeNull()
    expect(armed.state.armedAt).toBe(1000)
    expect(press(armed.state, second, 1200)).toEqual({ state: { armedAt: null }, effect: { go: second } })
  })

  it('does nothing on g then x, or on t after the window', () => {
    const armed = press(none, 'g', 1000).state
    expect(press(armed, 'x', 1100)).toEqual({ state: { armedAt: null }, effect: null })
    expect(press(armed, 't', 1000 + GO_WINDOW_MS + 1).effect).toBeNull()
    expect(press(none, 't', 1000).effect).toBeNull()
  })

  it('survives Shift between g and the second key', () => {
    const armed = press(none, 'G', 1000, page, { shiftKey: true }).state
    const held = press(armed, 'Shift', 1100)
    expect(held.state).toBe(armed)
    expect(press(held.state, 'T', 1200).effect).toEqual({ go: 't' })
  })

  it('never fires in a field or while composing', () => {
    const field = { tag: 'TEXTAREA', editable: false }
    expect(press(none, 'g', 1000, field).state.armedAt).toBeNull()
    const armed = press(none, 'g', 1000).state
    expect(press(armed, 't', 1100, field).effect).toBeNull()
    expect(press(armed, 't', 1100, page, { isComposing: true }).effect).toBeNull()
    expect(press(armed, 't', 1100, { tag: 'DIV', editable: true }).effect).toBeNull()
  })
})
