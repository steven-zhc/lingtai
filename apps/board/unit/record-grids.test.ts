import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

/**
 * Every grid the record holds caps its track (#899). An `auto` track takes its
 * minimum from its content, so a `pre` with one long line widened the whole
 * tab before `overflow: auto` could run. `.swhy` was the first fix.
 *
 * What this cannot do: a stylesheet does not say which selectors render inside
 * the record, so a fourth grid nobody lists here is caught only by the pointer
 * comment on `.atab`.
 */
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

const blocks = (selector: string) =>
  css
    .split('}')
    .map((piece) => piece.split('{'))
    .filter((parts) => parts.length > 1)
    .filter((parts) =>
      parts[parts.length - 2]!.split(',')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .includes(selector),
    )
    .map((parts) => parts[parts.length - 1]!)

describe('the record caps its grid tracks', () => {
  for (const selector of ['.rbody', '.atab', '.rpart', '.swhy']) {
    it(`${selector} declares minmax(0, 1fr)`, () => {
      const found = blocks(selector).filter((b) => /display:\s*grid/.test(b))
      expect(found.length).toBeGreaterThan(0)
      for (const b of found) expect(b).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/)
    })
  }
})
