/**
 * The footer every page but `/` fetches (#906): a skeleton until the answer, a
 * client component that imports no server module (#230), mounted on the pages
 * that read the log and on none of the others, and a loader that never throws.
 */
import { readFileSync, readdirSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@lingtai/projector', () => ({
  projectionLag: async () => {
    throw new Error('lag down')
  },
  readSpend: async () => {
    throw new Error('spend down')
  },
  readRateSnapshot: () => undefined,
}))

import { FooterFetched } from '../src/app/footer-fetched.tsx'
import { FOOTER_PROJECTIONS, footerLags, loadFooter } from '../src/lib/footer.ts'

const read = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')

describe('FooterFetched', () => {
  it('draws the skeleton inside a footer before an answer', () => {
    const html = renderToStaticMarkup(<FooterFetched />)
    expect(html).toContain('<footer')
    expect(html).toContain('class="skeleton"')
  })

  it('is a client component with no value import of a server module', () => {
    const src = read('app/footer-fetched.tsx')
    expect(src.startsWith("'use client'")).toBe(true)
    const values = (src.match(/^import .*$/gm) ?? []).filter((l) => !l.startsWith('import type'))
    for (const line of values) expect(line).not.toMatch(/@lingtai\/|@\/lib\//)
  })

  it('fetches in an effect that runs on mount only', () => {
    expect(read('app/footer-fetched.tsx')).toMatch(/\},\s*\[\]\)/)
  })
})

describe('where the footer is mounted', () => {
  const mounted = [
    'app/task/[id]/layout.tsx',
    'app/report/page.tsx',
    'app/backlog/page.tsx',
    'app/recipe/[project]/page.tsx',
  ]
  it.each(mounted)('%s ends in <FooterFetched', (file) => {
    expect(read(file)).toContain('<FooterFetched')
  })

  it('is on no setup page, nor the store-refused screen', () => {
    const dir = new URL('../src/app/setup/', import.meta.url)
    for (const f of readdirSync(dir, { recursive: true, encoding: 'utf8' })) {
      if (/\.tsx?$/.test(f)) expect(readFileSync(new URL(f, dir), 'utf8')).not.toContain('FooterFetched')
    }
    expect(read('app/not-set-up.tsx')).not.toContain('FooterFetched')
  })
})

describe('loadFooter', () => {
  it('resolves with both readings null when both reads throw', async () => {
    const r = await loadFooter()
    expect(r.day.day).toBeNull()
    expect(r.lags).toBeNull()
  })

  it('names all four projections, a missing one as null, as plain numbers', () => {
    const lags = footerLags([{ name: 'spend', lastSeq: 1n, headSeq: 4n, lag: 3n, updatedAt: null }])
    expect(lags.map((l) => l.name)).toEqual([...FOOTER_PROJECTIONS])
    expect(lags.find((l) => l.name === 'spend')?.lag).toBe(3)
    expect(lags.find((l) => l.name === 'task_view')?.lag).toBeNull()
    expect(() => JSON.stringify(lags)).not.toThrow()
  })

  it("holds the list equal to the CLI's", () => {
    const cli = readFileSync(new URL('../../cli/src/commands.ts', import.meta.url), 'utf8')
    const m = /PROJECTION_NAMES = \[([^\]]*)\]/.exec(cli)
    const names = [...(m?.[1] ?? '').matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect(names).toEqual([...FOOTER_PROJECTIONS])
  })
})
