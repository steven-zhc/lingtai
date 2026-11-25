import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { rulesOf } from '../test/css-rules.ts'

// #1458: the board has two kinds of button and two sizes, defined once: `.btn` (secondary, regular),
// `.btn.pri` (primary) and `.btn.sm` (small). A rule that names `button` or a class ending in `btn` and sets
// what a button looks like (background, border, padding, font) fails here unless it is one of those three
// or is listed below with its reason. A new button rule is a new class on `.btn`, never a new look.
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

const EXCEPTIONS: { selector: string; why: string }[] = [
  { selector: '.wiz-tabs button', why: 'a segmented tab, `role="tab"`' },
  { selector: ".wiz-tabs button[aria-selected='true']", why: 'a segmented tab, `role="tab"`' },
]

const LOOKS = /(?:^|;)\s*(?:background[\w-]*|border[\w-]*|padding[\w-]*|font|font-size)\s*:/

const squash = (s: string) => s.replace(/\s+/g, ' ').trim()
// What is left of a selector once pseudo-classes and attribute selectors are gone.
const compoundOf = (s: string) =>
  squash(s)
    .replace(/\[[^\]]*\]/g, '')
    .replace(/::?[a-z-]+(\([^)]*\))?/g, '')
const FAMILY = new Set(['.btn', '.btn.pri', '.btn.sm'])
const namesAButton = (compound: string) => /(^|[\s>+~])button\b|\.[\w-]*btn\b/.test(compound)

export const offenders = (source: string) =>
  rulesOf(source)
    .filter((r) => LOOKS.test(r.body))
    .flatMap((r) => r.selector.split(',').map((s) => ({ selector: squash(s), body: r.body })))
    .filter(({ selector }) => namesAButton(compoundOf(selector)) && !FAMILY.has(compoundOf(selector)))
    .filter(({ selector }) => !EXCEPTIONS.some((e) => e.selector === selector))
    .map(({ selector }) => selector)

const bodyOf = (selector: string) => rulesOf(css).find((r) => squash(r.selector) === selector)?.body ?? ''
const has = (body: string, decl: string) => squash(body).includes(decl)

describe('one look for every button (#1458)', () => {
  it('has no button rule outside .btn, .btn.pri and .btn.sm', () => {
    expect(offenders(css)).toEqual([])
  })

  it('catches the rules the ticket deletes', () => {
    const old = `.pr-btn { border: 1px solid red; }
.btn.go { background: teal; }
.pbanner button { padding: 0 7px; }
.sresolutionaction .btn { padding: 1rem; }
.btn.held { color: red; }
.btn.pri[aria-busy='true']:disabled { opacity: 1; }
.sresolutionaction .btn { width: 100%; }`
    expect(offenders(old)).toEqual(['.pr-btn', '.btn.go', '.pbanner button', '.sresolutionaction .btn'])
  })

  it('draws .btn as secondary and regular, from variables alone', () => {
    const b = bodyOf('.btn')
    for (const d of [
      'font: 600 var(--fs-sm)/1.4 var(--sans)',
      'padding: 6px 12px',
      'border-radius: var(--radius)',
      'border: 1px solid var(--rule-2)',
      'color: var(--accent-ink)',
      'background: var(--surface)',
    ])
      expect(has(b, d), d).toBe(true)
    expect(has(bodyOf('.btn:hover:not(:disabled)'), 'border-color: var(--accent)')).toBe(true)
    expect(has(bodyOf('.btn:disabled'), 'opacity: 0.5')).toBe(true)
  })

  it('draws .btn.pri as primary', () => {
    const b = bodyOf('.btn.pri')
    for (const d of ['background: var(--accent)', 'border-color: var(--accent)', 'color: var(--surface)'])
      expect(has(b, d), d).toBe(true)
    expect(has(bodyOf('.btn.pri:hover:not(:disabled)'), 'background: var(--accent-ink)')).toBe(true)
  })

  it('draws .btn.sm as small', () => {
    const b = bodyOf('.btn.sm')
    expect(has(b, 'font-size: var(--fs-xs)')).toBe(true)
    expect(has(b, 'padding: 4px 9px')).toBe(true)
  })

  it('has no hex colour and no literal size in the button rules', () => {
    for (const s of ['.btn', '.btn.pri', '.btn.sm']) {
      expect(bodyOf(s)).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      expect(bodyOf(s)).not.toMatch(/font-size:\s*[\d.]+(px|rem)/)
    }
  })
})
