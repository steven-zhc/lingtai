import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The waiting page's band rules reach the queued and running frames by name
 * (#911). The approved page shares `detail--framed` and must not be restyled,
 * and Discussion's Ask re-skin stays the waiting page's.
 */
const css = readFileSync(join(__dirname, '../src/app/globals.css'), 'utf8')

/** Every rule's selector list, split on commas. */
const selectors = [...css.matchAll(/(?:^|\})\s*([^{}@][^{}]*)\{/g)].flatMap((m) =>
  m[1]!
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
)

const BAND = [
  '.triage-band',
  '.triage-head',
  '.triage-head .triage-cause',
  '.triage-cause',
  '.triage-summary',
  '.triage-recommendation',
  '.sreading--advised',
  '.sreading--advised .triage-band',
  '.sreading--advised .spair',
  '.sreading--advised .chat',
]

describe('the panel rules', () => {
  it.each(BAND)('%s is drawn on the waiting, queued and running pages as whole selectors', (rule) => {
    for (const frame of ['waiting', 'queued', 'running']) {
      expect(selectors).toContain(`.detail--${frame} ${rule}`)
    }
  })

  it('never styles the band under .detail--framed, which the approved page wears', () => {
    const framed = selectors.filter((x) => /detail--framed/.test(x) && /triage-|sreading--advised|band-facts/.test(x))
    expect(framed).toEqual([])
  })

  it('leaves the Ask re-skin to the waiting page', () => {
    const ask = selectors.filter((x) => x.includes('.chatask'))
    expect(ask.filter((x) => /detail--(queued|running|framed)/.test(x))).toEqual([])
  })
})

describe('the sticky footer (#1123)', () => {
  const block = (sel: string) =>
    new RegExp(`(?:^|\\})\\s*${sel.replace(/[.()]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? ''

  it('.footer is sticky at the bottom of the window', () => {
    const b = block('.footer')
    expect(b).toContain('position: sticky')
    expect(b).toContain('bottom: 0')
  })

  it('.rfile leaves room for the footer, and only where one exists', () => {
    expect(block('.rfile')).toContain('var(--footer-h')
    expect(block(':root:has(.footer)')).toContain('--footer-h')
  })
})

describe('the hold pill (#1168)', () => {
  const block = (sel: string) =>
    new RegExp(`(?:^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? ''

  it('.pill.hold wraps inside its card, and .pill stays on one line', () => {
    const hold = block('.pill.hold')
    expect(hold).toContain('white-space: normal')
    expect(hold).toContain('overflow-wrap: anywhere')
    expect(hold).toContain('max-width: 100%')
    expect(block('.pill')).toContain('white-space: nowrap')
  })
})

describe('the figures and ticket panels (#1515)', () => {
  const OLD = ['.meters.facts', '.meters.facts .meter dt', '.meters.facts .meter dd', '.meters.facts .meter dd.sub']

  it('styles the totals strip only by [data-totals], so the running card keeps its meters', () => {
    const meters = selectors
      .map((x) => x.replace(/\/\*[\s\S]*?\*\//g, '').trim())
      .filter((x) => /\.meters\b/.test(x) && !OLD.includes(x))
    expect(meters.length).toBeGreaterThan(0)
    for (const x of meters) {
      expect(x.startsWith('.meters.facts[data-totals]') || x.startsWith('.standing > .meters.facts[data-totals]')).toBe(
        true,
      )
      expect(x).not.toContain('running-card')
    }
  })

  it('draws the ticket panel in every state, not under a page class', () => {
    const tcontext = selectors.filter((x) => /tcontext|topening/.test(x))
    expect(tcontext.length).toBeGreaterThan(0)
    expect(tcontext.filter((x) => /\.tcontext/.test(x) && /detail--/.test(x))).toEqual([])
  })

  it('adds no colour or font-size literal to the panel rules', () => {
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]*(?:tcontext|\[data-totals\])[^{}]*\{[^}]*\}/g) ?? []
    expect(rules.length).toBeGreaterThan(0)
    for (const r of rules) {
      expect(r).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/)
      expect(r).not.toMatch(/font-size:\s*[\d.]/)
    }
  })
})
