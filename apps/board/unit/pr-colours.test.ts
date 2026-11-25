import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// #1444: the PR pages read colour variables only, so dark mode (which changes the
// variables) reaches them. Rules are picked by selector, never by line range.
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')

const PREFIXES = ['.pr-', '.prp-', '.obs-']
const LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/

export const scan = (source: string) => {
  const bare = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ selector: m[1]!.trim(), body: m[2]! }))
    .filter((r) => PREFIXES.some((p) => r.selector.includes(p)))
  return { rules, bad: rules.filter((r) => LITERAL.test(r.body)).map((r) => r.selector) }
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
})
