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
  '.triage-label',
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
