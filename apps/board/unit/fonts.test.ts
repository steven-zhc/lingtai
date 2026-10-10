import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

/**
 * #437: the board's two typefaces are files in the repository, not a fetch to
 * Google. This reads the checked-in source rather than the built output, the
 * same way `bar.test.ts` reads `globals.css` — a `next/font/local` call and
 * its files are plain text and a static directory, not a temp-directory use
 * that would send this to `integration/`.
 */
const layout = readFileSync(new URL('../src/app/layout.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../src/app/globals.css', import.meta.url), 'utf8')
const fontsDir = fileURLToPath(new URL('../src/app/fonts/', import.meta.url))

describe('the board fonts', () => {
  it('never names next/font/google', () => {
    expect(layout).not.toContain('next/font/google')
  })

  it('names a path, for every src entry, that exists and is not empty', () => {
    const paths = [...layout.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1]!)
    expect(paths.length).toBeGreaterThan(0)

    for (const path of paths) {
      expect(path.startsWith('./fonts/')).toBe(true)
      const file = fileURLToPath(new URL(`../src/app/${path}`, import.meta.url))
      expect(existsSync(file)).toBe(true)
      expect(statSync(file).size).toBeGreaterThan(0)
    }

    const usedNames = new Set(paths.map((path) => path.replace('./fonts/', '')))
    const woff2Files = readdirSync(fontsDir).filter((name) => name.endsWith('.woff2'))
    for (const name of woff2Files) {
      expect(usedNames.has(name)).toBe(true)
    }
  })

  it('still writes --font-sans and --font-mono, and globals.css reads both', () => {
    expect(layout).toContain("variable: '--font-sans'")
    expect(layout).toContain("variable: '--font-mono'")
    expect(css).toContain('--font-sans')
    expect(css).toContain('--font-mono')
  })

  it('carries the OFL licence beside the font files', () => {
    const licence = readFileSync(new URL('../src/app/fonts/OFL.txt', import.meta.url), 'utf8')
    expect(licence).toContain('SIL Open Font License')
  })
})
