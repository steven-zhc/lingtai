import { readFile } from 'node:fs/promises'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { HomePage } from '@/app/page'
import { parseBooks, readBooks, type Books } from '@/lib/books'

import { BOOKS_FILE_FIXTURE as FILE } from './books-fixture'

const books = (patch: (b: Books) => void = () => {}): Books => {
  const b = parseBooks(structuredClone(FILE))
  if (!b) throw new Error('the fixture is not a books file')
  patch(b)
  return b
}
const render = (b: Books | null) => renderToStaticMarkup(<HomePage books={b} />)
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')

describe('the books section', () => {
  const html = render(books())
  const t = text(html)

  it('renders every figure, both bars and the receipts from the file', () => {
    expect(t).toContain('Lingtai builds Lingtai. Open its books.')
    expect(t).toContain('2026-10-02 → 2026-10-31')
    expect(t).toContain('291 tickets finished')
    expect(t).toContain('283 landed · 97%')
    expect(t).toContain('8 closed without landing — by a person')
    expect(t).toContain('5 still open at the end of the window')
    expect(t).toContain('62% landed with 0 or 1 fix round')
    expect(t).toContain('median 1.5 · 7% needed 5 or more')
    expect(t).toContain('$3.55 median cost per landed ticket')
    expect(t).toContain('mean $6.32 · 90% under $12.00')
    expect(t).toContain('10 min median machine time')
    expect(t).toContain('1 h 35 min')
    expect(t).toContain('40% within an hour · 20% waited for a person')
    expect(t).toContain('What the $3.55 pays for')
    expect(t).toContain('Work 56% — writing the code, and the cold review')
    expect(t).toContain('Fixes 35% — after failed checks or a refused review')
    expect(t).toContain('Judging 3%')
    expect(t).toContain('THE MEDIAN TICKET')
    expect(t).toContain('1 of 283 landed')
    expect(html).toContain('r-stamp on">TYPICAL')
    expect(t).toContain('ISSUE #782 · BUG')
    expect(html).toContain('r-stamp on">LANDED')
    expect(html).toContain('r-stamp closed on">NOT LANDED')
    expect(t).toContain('Passes 2')
    expect(html).toContain('href="https://github.com/steven-zhc/lingtai/issues/782"')
    expect(t).toContain('Open #664 →')
    expect(t).toContain('lingtai report --from 2026-10-02 --to 2026-10-31 --project lingtai')
    expect(t).toContain('No totals are published.')
  })

  it('has no Discussion key when its share rounds to 0%, and no stamp on an open receipt', () => {
    expect(t).not.toContain('Discussion')
    const open = html.slice(html.indexOf('ISSUE #539'))
    expect(open).not.toContain('r-stamp')
    expect(t).toContain('still open at the end of the window · Open #539')
  })

  it('shows no total: every dollar figure is one the file carries', () => {
    const section = html.slice(html.indexOf('class="books"'), html.indexOf('class="home-setup"'))
    const seen = [...text(section).matchAll(/\$\d+\.\d\d/g)].map((m) => m[0])
    const own = new Set(['$3.55', '$6.32', '$12.00', '$4.02', '$9.27', '$11.39'])
    expect(seen.length).toBeGreaterThan(0)
    for (const d of seen) expect(own.has(d), `${d} is not in the file`).toBe(true)
  })

  it('leaves out a figure the file has as null, and says when costs include estimates', () => {
    const t2 = text(
      render(
        books((b) => {
          b.machineMinutes = { median: null, mean: null }
          b.cost.includesEstimates = true
          b.cost.costUnknown = 3
        }),
      ),
    )
    expect(t2).not.toContain('median machine time')
    expect(t2).toContain('includes estimates')
    expect(t2).toContain('3 runs could not be priced')
  })

  it('renders a null cost as a dash, never $0.00', () => {
    const html2 = render(
      books((b) => {
        b.receipts = [{ median: true, fixRounds: 1, machineMinutes: 10, waits: 0, cost: null }]
        b.cost.median = null
        b.cost.mean = null
        b.cost.p90 = null
      }),
    )
    expect(text(html2)).not.toContain('$0.00 MEDIAN')
    expect(html2).toContain('<b>—</b>')
  })

  it('sits after "why not" and before the setup, in the rendered page', () => {
    const at = [
      'Why not just give the agent the issue?',
      'Lingtai builds Lingtai. Open its books.',
      'Three steps to your first receipt.',
    ].map((h) => t.indexOf(h))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })
})

describe('no books file', () => {
  it('renders no section', () => {
    expect(text(render(null))).not.toContain('Open its books')
  })

  it('reads null from a path that is not there', async () => {
    expect(await readBooks('/nonexistent/books.json')).toBeNull()
  })
})

describe('the server/client boundary', () => {
  it('imports no value from a "use client" file', async () => {
    const dir = new URL('../src/app/', import.meta.url)
    const src = await readFile(new URL('books-section.tsx', dir), 'utf8')
    for (const m of src.matchAll(/^import\s+(?!type\b)[^'\n]*from '\.\/([^']+)'/gm)) {
      const file = await readFile(new URL(`${m[1]}.tsx`, dir), 'utf8')
      expect(file, `${m[1]} is a client module`).not.toMatch(/^['"]use client['"]/)
    }
  })
})
