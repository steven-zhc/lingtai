import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { rulesOf } from '../test/css-rules.ts'

// #1456: every section, column and panel heading is `.sec-h`. The old per-page heading rules keep
// layout only: a rule that sets type or colour on one of them outranks `.sec-h` (most are more
// specific) and the heading quietly looks as it did. Add a new heading's class to HEADINGS only
// if it must be matched; give a new heading `sec-h` instead.
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

const HEADINGS = [
  '.col-h',
  '.col.hot .col-h',
  '.handled-k',
  '.handled-k .l',
  '.hfr-k',
  '.hfr-k .l',
  '.hfr-days .h',
  '.hfr-feed .h',
  '.pr-col h2',
  '.pr-col.waiting h2',
  '.prp-panel h2',
  '.rcard-h',
  '.s2-h',
  '.rp-panel h2',
  '.ssectiontitle',
  '.tcontext-field h2',
  '.tcontext-field--watch h2',
  '.triage-label',
  '.triage-band--failed .triage-label',
  '.saftermove h2',
  '.bandsub',
  '.triage-hunk-group h3',
  '.asechead',
  '.sandbox .sbh',
  '.palette-group',
]

const TYPE = ['font-size', 'font-weight', 'font-family', 'font', 'letter-spacing', 'text-transform', 'color']

const SEC_H: Record<string, string> = {
  'font-family': 'var(--sans)',
  'font-size': 'var(--fs-xs)',
  'font-weight': '600',
  'text-transform': 'uppercase',
  'letter-spacing': '0.08em',
  color: 'var(--muted)',
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

// Split at depth 0 only: a comma inside :is(…) or :has(…) belongs to its parentheses.
export const parts = (selector: string): string[] => {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of selector) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(norm(cur))
      cur = ''
    } else cur += ch
  }
  out.push(norm(cur))
  return out.filter(Boolean)
}

export const decls = (body: string): Record<string, string> =>
  Object.fromEntries(
    body
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const i = d.indexOf(':')
        return [d.slice(0, i).trim(), norm(d.slice(i + 1))] as const
      }),
  )

const matches = (part: string, listed: string) => part === listed || part.endsWith(` ${listed}`)

export const offenders = (source: string): string[] => {
  const out: string[] = []
  for (const r of rulesOf(source)) {
    const d = decls(r.body)
    const ps = parts(r.selector)
    if (ps.some((p) => HEADINGS.some((h) => matches(p, h)))) {
      for (const prop of TYPE) if (prop in d) out.push(`${r.selector} { ${prop}: ${d[prop]} }`)
    }
    if (r.selector === '.sec-h') {
      const got = JSON.stringify(Object.entries(d).sort())
      if (got !== JSON.stringify(Object.entries(SEC_H).sort())) out.push(`.sec-h declares ${got}`)
    }
    if (r.selector === '.sec-h.wait' && JSON.stringify(d) !== JSON.stringify({ color: 'var(--signal)' }))
      out.push(`.sec-h.wait declares ${JSON.stringify(d)}`)
    if (r.selector === '.sec-h.fail' && JSON.stringify(d) !== JSON.stringify({ color: 'var(--fail)' }))
      out.push(`.sec-h.fail declares ${JSON.stringify(d)}`)
  }
  return out
}

describe('one class for every section heading', () => {
  it('has .sec-h, .sec-h.wait and .sec-h.fail', () => {
    const selectors = rulesOf(css).map((r) => r.selector)
    for (const s of ['.sec-h', '.sec-h.wait', '.sec-h.fail']) expect(selectors).toContain(s)
  })

  it('leaves no type or colour on an old heading rule, and .sec-h is the six values', () => {
    expect(offenders(css)).toEqual([])
  })

  it('catches what it should', () => {
    for (const bad of [
      '.x .pr-col h2 { color: red }',
      '.sec-h { font-size: 11px }',
      '.sec-h.wait { font-weight: 700 }',
      ':is(.detail--waiting, .detail--resolved) .tcontext-field--watch h2 { color: red }',
      '.detail--waiting .triage-hunk-group h3 { font: 12px sans-serif }',
    ])
      expect(offenders(bad), bad).not.toEqual([])
  })

  it('passes what it should', () => {
    for (const good of [
      '.col.hot .col-h .ct { font-size: 22px }',
      '.pr-col h2 { margin: 0 }',
      '.hfr-k .when { color: var(--muted) }',
      '.col > .col-h { min-height: 36px }',
    ])
      expect(offenders(good), good).toEqual([])
  })
})
