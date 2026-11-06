/**
 * The home frame (#939): bar, `<main>` and a footer outside it, inside one
 * wrapper; and no height in the stylesheet built from a viewport minus a number.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HomeFrame } from '../src/app/home-frame.tsx'

const css = readFileSync(join(__dirname, '../src/app/globals.css'), 'utf8')

describe('HomeFrame', () => {
  const html = renderToStaticMarkup(
    <HomeFrame footer={<footer>f</footer>}>
      <div className="bar" />
      <div className="cols" />
    </HomeFrame>,
  )

  it('is one wrapper holding main and then a footer that is not inside it', () => {
    expect(html.startsWith('<div class="home-frame"><main>')).toBe(true)
    expect(html.endsWith('</main><footer>f</footer></div>')).toBe(true)
    expect(html.indexOf('class="bar"')).toBeLessThan(html.indexOf('class="cols"'))
    expect(html.indexOf('class="cols"')).toBeLessThan(html.indexOf('</main>'))
  })
})

describe('the frame stylesheet', () => {
  it('sizes the page from the window and no number', () => {
    expect(css).not.toContain('calc(100vh - 41px)')
    expect(css).toMatch(/\.home-frame\s*\{[^}]*min-height:\s*100dvh/)
    expect(css).not.toMatch(/\.cols\s*\{[^}]*min-height/)
  })
})

describe('the frame class', () => {
  it("is not the bar label's class, which the stylesheet already styles", () => {
    expect(css).not.toMatch(/^\.home\s*\{/m)
    expect(css).not.toMatch(/^\.home\s*>/m)
  })
})
