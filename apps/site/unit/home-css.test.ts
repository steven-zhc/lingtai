import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * The site loads the board's stylesheet first, so a site class named like a board class inherits its
 * rules. The home page's sandbox card was `.sbx` and drew as `inline-flex` for that reason (#1189);
 * static markup loads no CSS, so only the stylesheets themselves can say it.
 */

const SITE = path.resolve(import.meta.dirname, '../src/app/home.css')
const BOARD = path.resolve(import.meta.dirname, '../../board/src/app/globals.css')

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every class named in a selector, that is the text before a `{`. Values such as `.08em` never count. */
function classesOf(css: string): Set<string> {
  const found = new Set<string>()
  for (const [, selector] of stripComments(css).matchAll(/([^{}]*)\{/g)) {
    for (const [, name] of selector!.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) found.add(name!)
  }
  return found
}

describe('home.css sandbox block', () => {
  it('names no class the board stylesheet also names', async () => {
    const site = await readFile(SITE, 'utf8')
    const start = site.indexOf('/* The sandbox: a dark band.')
    const end = site.indexOf('/* Why not just give the agent the issue?')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)

    const mine = classesOf(site.slice(start, end))
    expect(mine.has('home-shield')).toBe(true)

    const board = classesOf(await readFile(BOARD, 'utf8'))
    expect([...mine].filter((name) => board.has(name))).toEqual([])
  })
})
