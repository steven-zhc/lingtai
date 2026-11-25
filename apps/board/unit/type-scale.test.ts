import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

import { describe, expect, it } from 'vitest'

import { rulesOf } from '../test/css-rules.ts'

// #1462: every text size on the board is one of seven steps, `--fs-2xs` … `--fs-2xl`, plus
// `--fs-display` for the display figures. A literal size in a rule or in a .tsx fails here by
// selector or path. A page that needs an eighth size argues for it in
// doc/design/the-board-style.md first.
const SRC = new URL('../src/', import.meta.url).pathname
const css = readFileSync(join(SRC, 'app/globals.css'), 'utf8')

const STEPS: Record<string, string> = {
  '--fs-2xs': '10px',
  '--fs-xs': '11px',
  '--fs-sm': '12px',
  '--fs-md': '13.5px',
  '--fs-lg': '16px',
  '--fs-xl': '20px',
  '--fs-2xl': '28px',
  '--fs-display': '56px',
}

// Adding a display figure is an edit to this list and to the-board-style.md, not a quiet use.
// (`.ld-header h1` was retired by 415d24223.)
const DISPLAY = ['.ld-date .dn', '.hfr-hero b', '.handled-n b']

// Measured when this test was written: 346 size declarations read a variable. The floor only
// exists to catch a walker that silently reads nothing.
const FLOOR = 340

const UNIT = /\d*\.?\d+(px|rem|em|%|vw|vh|pt)\b/
const noVars = (v: string) => v.replace(/var\([^)]*\)/g, '')

const decls = (body: string) =>
  body.split(';').flatMap((d) => {
    const i = d.indexOf(':')
    return i < 0 ? [] : [{ prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() }]
  })

const exempt = (chain: string) => chain.includes(':root') || chain.includes('prefers-color-scheme: dark')

/** Every font / font-size declaration outside :root and the dark block. */
export const sizes = (source: string) =>
  rulesOf(source)
    .filter((r) => !exempt(r.chain))
    .flatMap((r) =>
      decls(r.body)
        .filter((d) => d.prop === 'font' || d.prop === 'font-size')
        .map((d) => ({ selector: r.selector, ...d })),
    )

export const offenders = (source: string) =>
  sizes(source)
    .filter((d) => {
      if (d.value === 'inherit') return false
      if (d.prop === 'font-size') return !/^var\(--fs-[a-z0-9]+\)$/.test(d.value)
      return !d.value.includes('var(--fs-') || UNIT.test(noVars(d.value))
    })
    .map((d) => `${d.selector} { ${d.prop}: ${d.value} }`)

export const unknownVars = (source: string) => {
  const used = [...source.matchAll(/var\((--fs-[\w-]*)\)/g)].map((m) => m[1]!)
  return [...new Set(used)].filter((n) => !(n in STEPS))
}

export const displayUsers = (source: string) =>
  rulesOf(source)
    .filter((r) => r.body.includes('var(--fs-display)'))
    .map((r) => r.selector)

/** A literal size in a .ts/.tsx file: a `fontSize=` attribute, or a value with a unit. */
export const tsxHits = (source: string) =>
  [
    ...source.matchAll(/\bfontSize\s*=/g),
    ...[...source.matchAll(/(?:\bfontSize|\bfont|\bfont-size)\s*:\s*(['"`])([^'"`]*)\1/g)].filter((m) =>
      UNIT.test(noVars(m[2]!)),
    ),
  ].map((m) => m[0])

const EXEMPT: { path: string; why: string }[] = [
  { path: 'app/markdown-preview.ts', why: "`fontSize: '0'` hides fence markers; it is not a text size" },
  {
    path: 'app/setup/github-app/start/route.ts',
    why: 'a bare HTML page that auto-submits to GitHub and loads no stylesheet',
  },
]

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? filesUnder(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  )

describe('one type scale for the board', () => {
  it('declares exactly the eight --fs- variables in :root', () => {
    const root = rulesOf(css).find((r) => r.selector === ':root' && !r.chain.includes('@media'))
    const fs = Object.fromEntries(
      decls(root?.body ?? '')
        .filter((d) => d.prop.startsWith('--fs-'))
        .map((d) => [d.prop, d.value]),
    )
    expect(fs).toEqual(STEPS)
  })
  it('gives every size outside :root and the dark block a step or inherit', () => {
    expect(offenders(css)).toEqual([])
  })
  it('names only declared steps, and keeps display to its figures', () => {
    expect(unknownVars(css)).toEqual([])
    expect(displayUsers(css).sort()).toEqual([...DISPLAY].sort())
  })
  it('scanned enough to mean something', () => {
    const reading = sizes(css).filter((d) => d.value.includes('var(--fs-'))
    expect(reading.length).toBeGreaterThanOrEqual(FLOOR)
  })
  it('flags planted literals', () => {
    expect(offenders('.x { font-size: 12px }')).toHaveLength(1)
    expect(offenders('.x { font: 600 0.8rem/1.4 var(--sans) }')).toHaveLength(1)
    expect(unknownVars('.x { font-size: var(--fs-12) }')).toEqual(['--fs-12'])
    expect(displayUsers('.x { font-size: var(--fs-display) }')).toEqual(['.x'])
    expect(offenders('.x { &:hover { font-size: 11px } }')).toHaveLength(1)
    expect(offenders('.x { font: var(--fs-sm)/1.5 var(--mono); font-size: inherit; font: inherit }')).toEqual([])
    expect(offenders(':root { --fs-xs: 11px } @media (prefers-color-scheme: dark) { .x { font-size: 9px } }')).toEqual(
      [],
    )
  })
  it('sets no literal size in a .ts or .tsx file', () => {
    const hits = filesUnder(SRC)
      .map((f) => relative(SRC, f))
      .filter((p) => !EXEMPT.some((e) => e.path === p))
      .flatMap((p) => tsxHits(readFileSync(join(SRC, p), 'utf8')).map((h) => `${p}: ${h}`))
    expect(hits).toEqual([])
  })
  it('keeps every exempt path a live file', () => {
    const live = filesUnder(SRC).map((f) => relative(SRC, f))
    expect(EXEMPT.filter((e) => !live.includes(e.path)).map((e) => e.path)).toEqual([])
  })
  it('flags a planted tsx size', () => {
    expect(tsxHits('<text fontSize="11">')).toHaveLength(1)
    expect(tsxHits("<p style={{ fontSize: '12px' }}>")).toHaveLength(1)
    expect(tsxHits("style={{ font: '600 var(--fs-lg) var(--mono)' }}")).toEqual([])
  })
})
