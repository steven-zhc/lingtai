import { readFileSync } from 'node:fs'

import { STEPS } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EventsDoc } from '../../../packages/domain/scripts/events.ts'
import { Bar } from '../src/app/chrome'
import { EventsBody, label } from '../src/app/docs/events/events-body'
import { EventsFilter } from '../src/app/docs/events/events-filter'
import EventsPage from '../src/app/docs/events/page'
import { byGroup, byStream, parseBy, counts, groupId, matches, parseStep, shownGroups } from '../src/lib/event-filter'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const doc = JSON.parse(read('../../../doc/events.json')) as EventsDoc
const html = renderToStaticMarkup(<EventsBody doc={doc} />)
const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

describe('/docs/events/', () => {
  it('lists every event in doc/events.json, with its links and subscribe snippet', () => {
    expect(doc.events.length).toBeGreaterThan(0)
    for (const e of doc.events) {
      expect(html).toContain(`<span class="ev-name">${e.name}</span>`)
      expect(html).toContain(`href="${escaped(e.definition)}"`)
      for (const site of e.sites) expect(html).toContain(`href="${escaped(site)}"`)
      expect(html).toContain(escaped(e.subscribers))
    }
  })

  it('renders each event exactly once with its name as the id', () => {
    for (const e of doc.events) expect(html.split(`id="${e.name}"`).length - 1, e.name).toBe(1)
  })

  it('draws the spine: ten steps in order, outside and no step, each with its count', () => {
    const c = counts(doc.events, STEPS)
    const spine = html.slice(html.indexOf('class="ev-spine"'), html.indexOf('class="ev-clear"'))
    let last = -1
    STEPS.forEach((step) => {
      const at = spine.indexOf(`<span class="ev-dot">${c[step]}</span><span class="ev-step">${step}</span>`)
      expect(at, step).toBeGreaterThan(last)
      last = at
    })
    expect(spine).toContain(`<span class="ev-dot">${c.outside}</span><span class="ev-step">outside</span>`)
    expect(spine).toContain(`<span class="ev-dot">${c.none}</span><span class="ev-step">no step</span>`)
  })

  it('labels a link with the basename and line', () => {
    expect(label('https://github.com/o/r/blob/abc/packages/conductor/src/conduct.ts#L3645')).toBe('conduct.ts:3645')
    expect(label('https://github.com/o/r/blob/abc/packages/domain/src/events.ts')).toBe('events.ts')
  })

  it('has no <pre> per entry and puts the commit note after the last group', () => {
    expect(html).not.toContain('<pre')
    expect(html.indexOf('class="source"')).toBeGreaterThan(html.lastIndexOf('class="ev-group"'))
  })

  it('filters by step: review, none, and an unknown value', () => {
    const shown = (search: string) => doc.events.filter((e) => matches(e.at, parseStep(search, STEPS)))
    expect(shown('?step=review').map((e) => e.name)).toEqual(
      doc.events.filter((e) => e.at.includes('review')).map((e) => e.name),
    )
    expect(shown('?step=none').every((e) => e.at.length === 0)).toBe(true)
    expect(shown('?step=none').length).toBe(doc.events.filter((e) => e.at.length === 0).length)
    expect(shown('?step=bogus')).toHaveLength(doc.events.length)
    const expected = byGroup(doc.events)
      .filter(([, list]) => list.some((e) => e.at.includes('review')))
      .map(([group]) => group)
    expect(shownGroups(doc.events, 'review')).toEqual(expected)
    expect(expected.length).toBeLessThan(byGroup(doc.events).length)
    expect(shownGroups(doc.events, null)).toHaveLength(byGroup(doc.events).length)
  })

  it('renders unmatched groups and entries hidden under a filter', () => {
    const index = doc.events.map(({ name, group, stream, at }) => ({ name, group, stream, at }))
    const entries = Object.fromEntries(doc.events.map((e) => [e.name, <i key={e.name}>{e.name}</i>]))
    const out = renderToStaticMarkup(
      <EventsFilter steps={[...STEPS]} index={index} entries={entries} initialFilter="review" />,
    )
    const shown = new Set(shownGroups(index, 'review'))
    for (const [group, list] of byGroup(index)) {
      const tag = out.match(new RegExp(`<section[^>]*id="${groupId(group)}"[^>]*>`))?.[0] ?? ''
      expect(/\shidden=""/.test(tag), group).toBe(!shown.has(group))
      for (const e of list) {
        const wrap = out.match(new RegExp(`<div( hidden="")?><i>${e.name}</i>`))
        expect(Boolean(wrap?.[1]), e.name).toBe(!e.at.includes('review'))
      }
    }
    expect(shown.size).toBeLessThan(byGroup(index).length)
  })

  it('renders a summary as inline markdown with links resolved to the sha', () => {
    const fixture = {
      ...doc,
      events: [
        { ...doc.events[0]!, name: 'Fixture', summary: 'has `code`, **bold** and [a doc](../../../doc/x.md)' },
        { ...doc.events[0]!, name: 'Bare', summary: null },
      ],
    }
    const out = renderToStaticMarkup(<EventsBody doc={fixture} />)
    expect(out).toContain('<code>code</code>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toMatch(/<a href="https:\/\/github\.com\/[^"]+\/blob\/[0-9a-f]+\/doc\/x\.md">a doc<\/a>/)
    expect(out).toContain('no description in the source')
    const broken = renderToStaticMarkup(
      <EventsBody doc={{ ...fixture, events: [{ ...fixture.events[0]!, summary: 'open `tick and **bold' }] }} />,
    )
    expect(broken).toContain('open `tick and **bold')
  })

  it('lists by stream, an event on several streams under each, and parses ?by=', () => {
    const idx = [
      { name: 'A', group: 'g', stream: ['x-', 'y-'], at: [] },
      { name: 'B', group: 'g', stream: ['y-'], at: [] },
      { name: 'C', group: 'g', stream: [], at: [] },
    ]
    expect(byStream(idx).map(([p, l]) => [p, l.map((e) => e.name)])).toEqual([
      ['x-', ['A']],
      ['y-', ['A', 'B']],
      ['none', ['C']],
    ])
    expect(parseBy('?by=stream')).toBe('stream')
    expect(parseBy('?by=nonsense')).toBe('group')
    expect(parseBy('')).toBe('group')
  })

  it('keeps server-only imports out of the client graph', () => {
    for (const file of ['../src/app/docs/events/events-filter.tsx', '../src/lib/event-filter.ts']) {
      const source = read(file)
      expect(source, file).not.toMatch(/from 'node:/)
      expect(source, file).not.toMatch(/from '(@\/lib\/events|@\/lib\/docs|@lingtai\/domain)'/)
    }
  })

  it('names no event in its own source', () => {
    const sources = [
      '../src/app/docs/events/page.tsx',
      '../src/app/docs/events/events-body.tsx',
      '../src/lib/events.ts',
      '../src/app/docs/events/events-filter.tsx',
      '../src/lib/event-filter.ts',
    ]
    for (const file of sources) {
      const source = read(file)
      for (const e of doc.events) expect(source, `${file} names ${e.name}`).not.toContain(e.name)
    }
  })

  it('draws the docs sidebar with Events current', async () => {
    const page = renderToStaticMarkup(await EventsPage())
    expect(page).toContain('aria-label="Documentation"')
    const links = [...page.matchAll(/<a [^>]*href="\/docs\/events"[^>]*>/g)].map((m) => m[0])
    expect(links.some((a) => a.includes('aria-current="page"'))).toBe(true)
  })

  it('links Events in the bar between Plugins and GitHub', () => {
    const bar = renderToStaticMarkup(<Bar />)
    const at = (href: string) => bar.indexOf(`href="${href}"`)
    expect(at('/docs/events/')).toBeGreaterThan(at('/docs/plugins/'))
    expect(at('/docs/events/')).toBeLessThan(bar.indexOf('>GitHub<'))
  })
})
