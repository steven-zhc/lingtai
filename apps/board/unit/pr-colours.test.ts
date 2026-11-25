import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { rulesOf } from '../test/css-rules.ts'

// #1444: the PR pages read colour variables only, so dark mode (which changes the
// variables) reaches them. Rules are picked by selector, never by line range.
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

const PREFIXES = ['.pr-', '.prp-', '.obs-']
const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/

// A block counts as a PR rule when its selector or any enclosing selector names a prefix,
// so nested CSS (`.pr-card { &:hover { … } }`) is covered as well as `@media` wrappers.
export const scan = (source: string) => {
  const rules = rulesOf(source)
  const picked = rules.filter((r) => PREFIXES.some((p) => r.chain.includes(p)))
  return {
    rules: picked,
    bad: picked.filter((r) => LITERAL.test(r.body)).map((r) => r.selector),
  }
}

describe('the PR pages draw from variables', () => {
  it('has no colour literal in a .pr-, .prp- or .obs- rule', () => {
    expect(scan(css).bad).toEqual([])
  })
  it('scanned enough rules to mean something', () => {
    expect(scan(css).rules.length).toBeGreaterThanOrEqual(100)
  })
  it('flags a planted literal', () => {
    expect(scan('.pr-x { color: #fff }').bad).toEqual(['.pr-x'])
  })
  it('flags a literal beside a nested rule, and inside it', () => {
    expect(scan('.pr-card { color: #fff; &:hover { opacity: .8; } }').bad).toEqual(['.pr-card'])
    expect(scan('.pr-card { &:hover { color: rgb(0 0 0); } }').bad).toEqual(['&:hover'])
  })
})
