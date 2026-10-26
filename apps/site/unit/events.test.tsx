import { readFileSync } from 'node:fs'

import { STEPS } from '@lingtai/domain'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { EventsDoc } from '../../../packages/domain/scripts/events.ts'
import { EventsBody } from '../src/app/docs/events/events-body'

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

  it('has a section for each step and for the lane outside the pass', () => {
    for (const at of [...STEPS, 'outside']) {
      expect(html).toContain(`id="at-${at}"`)
      expect(html).toContain(`href="#at-${at}"`)
    }
  })

  it('names no event in its own source', () => {
    const sources = [
      '../src/app/docs/events/page.tsx',
      '../src/app/docs/events/events-body.tsx',
      '../src/lib/events.ts',
    ]
    for (const file of sources) {
      const source = read(file)
      for (const e of doc.events) expect(source, `${file} names ${e.name}`).not.toContain(e.name)
    }
  })
})
