import { readFileSync } from 'node:fs'

import { STEPS } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EventsDoc } from '../../../packages/domain/scripts/events.ts'
import { Bar } from '../src/app/chrome'
import { EventsBody } from '../src/app/docs/events/events-body'
import EventsPage from '../src/app/docs/events/page'
import { byGroup, counts, matches, parseStep } from '../src/lib/event-filter'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const doc = JSON.parse(read('../../../doc/events.json')) as EventsDoc
const html = renderToStaticMarkup(<EventsBody doc={doc} />)
const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

describe('/docs/events/', () => {
  it('lists every event in doc/events.json, with its links and subscribe snippet', () => {
    expect(doc.events.length).toBeGreaterThan(0)
    for (const e of doc.events) {
      expect(html).toContain(`<code>${e.name}</code>`)
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
    STEPS.forEach((step, i) => {
      const at = spine.indexOf(`<span class="ev-step">${i + 1} ${step}</span><span class="ev-count">${c[step]}</span>`)
      expect(at, step).toBeGreaterThan(last)
      last = at
    })
    expect(spine).toContain(`<span class="ev-step">outside</span><span class="ev-count">${c.outside}</span>`)
    expect(spine).toContain(`<span class="ev-step">no step</span><span class="ev-count">${c.none}</span>`)
  })

  it('filters by step: review, none, and an unknown value', () => {
    const shown = (search: string) => doc.events.filter((e) => matches(e.at, parseStep(search, STEPS)))
    expect(shown('?step=review').map((e) => e.name)).toEqual(
      doc.events.filter((e) => e.at.includes('review')).map((e) => e.name),
    )
    expect(shown('?step=none').every((e) => e.at.length === 0)).toBe(true)
    expect(shown('?step=none').length).toBe(doc.events.filter((e) => e.at.length === 0).length)
    expect(shown('?step=bogus')).toHaveLength(doc.events.length)
    const groups = byGroup(doc.events).filter(([, list]) => list.some((e) => matches(e.at, 'review')))
    expect(groups.length).toBeLessThanOrEqual(byGroup(doc.events).length)
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
    expect(at('/docs/events')).toBeGreaterThan(at('/docs/plugins'))
    expect(at('/docs/events')).toBeLessThan(bar.indexOf('>GitHub<'))
  })
})
