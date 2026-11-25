import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { rulesOf, stripComments } from '../test/css-rules.ts'

// #1455: every card, panel, input and button has one radius, `--radius`; pills are 999px and
// circles 50%. What is not a box (a meter, a legend square, a bar segment) is listed below with
// its reason. A new rule with any other radius fails here until it is a box on `--radius` or
// is added to MARKS with a reason. Deleting a mark's rule means deleting its entry too.
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

const ALLOWED = ['var(--radius)', '999px', '50%']

const MARKS: { selector: string; why: string }[] = [
  { selector: '.footer .meter', why: 'a meter bar' },
  { selector: '.sp-today .meter', why: 'a meter bar' },
  { selector: '.scell', why: 'a step cell' },
  { selector: '.ld-filter i', why: 'a legend square' },
  { selector: '.ld-sq i', why: 'a legend square' },
  { selector: '.hfr-t td .dot', why: 'a legend dot' },
  { selector: '.hfr-feed li .dot', why: 'a legend dot' },
  { selector: '.handled-leg li > i', why: 'a legend square' },
  { selector: '.sw-rows i', why: 'a legend square' },
  { selector: '.rp-legend i, .rp-kind i', why: 'a legend square' },
  { selector: '.ld-date .mix', why: 'a bar segment' },
  { selector: '.hfr-ticks i', why: 'a bar segment' },
  { selector: '.hfr-stack i', why: 'a bar segment' },
  { selector: '.handled-ticks i', why: 'a bar segment' },
  { selector: '.sw-bar', why: 'a bar segment' },
  { selector: '.tc .tb', why: 'a bar segment' },
  { selector: '.pr-rail::before', why: 'a rail bar' },
  { selector: '.sk-bar', why: 'a skeleton bar' },
  { selector: '.sbx-skeleton', why: 'the shape of the shield it stands in for' },
  { selector: '.ld-head p', why: 'the highlighter behind inline text' },
  { selector: 'a.ti:focus-visible', why: 'the focus ring around a title’s text' },
]

const RADIUS = /(?:^|;)\s*border-radius\s*:\s*([^;]+?)\s*(?=;|$)/

export const radii = (source: string) =>
  rulesOf(source).flatMap((r) => {
    const m = RADIUS.exec(r.body)
    return m ? [{ selector: r.selector, value: m[1]! }] : []
  })

export const offenders = (source: string) =>
  radii(source)
    .filter((r) => !ALLOWED.includes(r.value) && !MARKS.some((m) => m.selector === r.selector))
    .map((r) => `${r.selector} { border-radius: ${r.value} }`)

const rootRules = rulesOf(css).filter((r) => r.selector === ':root')
const light = rootRules.find((r) => !r.chain.includes('@media'))
const dark = rootRules.find((r) => r.chain.includes('prefers-color-scheme: dark'))
const decl = (body: string | undefined, name: string) =>
  new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+?)\\s*(?=;|$)`).exec(body ?? '')?.[1]

describe('one radius for every box', () => {
  it('declares --radius: 3px in :root', () => {
    expect(decl(light?.body, '--radius')).toBe('3px')
  })
  it('gives every border-radius var(--radius), 999px, 50% or a listed mark', () => {
    expect(offenders(css)).toEqual([])
  })
  it('keeps every mark in the list a live rule (delete its entry with its rule)', () => {
    const live = radii(css).map((r) => r.selector)
    expect(MARKS.filter((m) => !live.includes(m.selector)).map((m) => m.selector)).toEqual([])
  })
  it('has no --pr-line anywhere', () => {
    expect(stripComments(css)).not.toContain('--pr-line')
  })
  it('flags a planted radius and accepts a listed mark', () => {
    expect(offenders('.x { border-radius: 6px }')).toEqual(['.x { border-radius: 6px }'])
    expect(offenders('.x { border-radius: 0 }')).toHaveLength(1)
    expect(offenders('.x { border-radius: var(--radius) }')).toEqual([])
    expect(offenders('.footer .meter { border-radius: 4px }')).toEqual([])
    expect(offenders('.x { &:hover { border-radius: 2px } }')).toHaveLength(1)
  })
})

describe('the layers', () => {
  it('keeps light colours', () => {
    expect(decl(light?.body, '--surface')).toBe('#ffffff')
    expect(decl(light?.body, '--rule')).toBe('#d8e0e1')
    expect(decl(light?.body, '--rule-2')).toBe('#c3cfd1')
    expect(decl(light?.body, '--surface-2')).toBe('#e9eeee')
  })
  it('sets the four dark values', () => {
    expect(decl(dark?.body, '--surface')).toBe('#18262b')
    expect(decl(dark?.body, '--rule')).toBe('#2e434b')
    expect(decl(dark?.body, '--rule-2')).toBe('#3a525b')
    expect(decl(dark?.body, '--surface-2')).toBe('#0e181b')
  })
})
