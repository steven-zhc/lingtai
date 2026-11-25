import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { rulesOf } from '../test/css-rules.ts'

// #1457: a link is a text link (teal, underlined) unless it is navigation, a whole card or row, or a
// button, and those opt out in one rule. `text-decoration: none` appears nowhere else, so a new
// navigation, card, row or button link adds its selector to OPT_OUT or fails here. A new text link
// needs nothing.
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
const rules = rulesOf(css)
const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
const decls = (body: string) =>
  body
    .split(';')
    .map((d) => d.replace(/\s*:\s*/, ': ').trim())
    .filter(Boolean)

const BASE = 'a, a:where(:visited)'
const REQUIRED = [
  '.bar a',
  '.place .view',
  '.tab',
  '.navlink',
  '.rtab',
  '.ti',
  '.lmeta',
  '.iss',
  '.pr-name',
  '.pr-slip-title',
  '.ltag',
  'a.btn',
]

const optOut = rules.find((r) => squash(r.selector).includes('.bar a'))

describe('links (#1457)', () => {
  it('the base rule is the text link', () => {
    const base = rules.filter((r) => squash(r.selector) === BASE)
    expect(base).toHaveLength(1)
    expect(decls(base[0]!.body)).toEqual([
      'color: var(--accent)',
      'text-decoration: underline',
      'text-decoration-thickness: 1px',
      'text-underline-offset: 2px',
    ])
  })

  it('text-decoration: none is said in the opt-out rule and nowhere else', () => {
    expect(optOut).toBeDefined()
    const stray = rules
      .filter((r) => /text-decoration\s*:\s*none/.test(r.body))
      .filter((r) => r !== optOut && squash(r.selector) !== '.bk.done .bst')
      .map((r) => squash(r.selector))
    expect(stray).toEqual([])
    expect(optOut!.body).toMatch(/text-decoration\s*:\s*none/)
  })

  it('the opt-out rule lists every navigation, card, row and button link', () => {
    const listed = squash(optOut!.selector)
      .split(',')
      .map((s) => s.trim())
    for (const s of REQUIRED) expect(listed, s).toContain(s)
  })
})
