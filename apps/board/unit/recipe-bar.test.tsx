/**
 * The recipe page's bar (#993): the home page's filter with this page's project
 * selected and `Recipe` pressed, and no `recipe · ` text in its place.
 *
 * Also the claim ticket C must keep: nothing the page's bar reaches imports
 * `app/actions`, which only the form may (the integration test that says so
 * does not run before the merge).
 */
import { readFileSync } from 'node:fs'

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RecipeBar } from '../src/app/recipe/[project]/recipe-bar.tsx'

describe('RecipeBar', () => {
  const out = renderToStaticMarkup(<RecipeBar project="b" filters={['a', 'b']} registered={['a', 'b']} app />)

  it('holds the filter naming its project', () => {
    expect(out).toContain('<summary>b ')
    expect(out).toContain('class="filter"')
  })

  it('presses Recipe, and says no recipe · ', () => {
    expect(out).toMatch(/<a class="navlink on" aria-current="page" href="\/recipe\/b">Recipe</)
    expect(out).not.toContain('recipe · ')
  })
})

describe('what the recipe page’s bar imports', () => {
  it('reaches no app/actions', () => {
    for (const f of ['bar.tsx', 'projects.tsx', 'filter-menu.tsx', 'recipe/[project]/recipe-bar.tsx']) {
      const src = readFileSync(new URL(`../src/app/${f}`, import.meta.url), 'utf8')
      expect(src.length).toBeGreaterThan(0)
      expect(src).not.toMatch(/from ['"][^'"]*actions['"]/)
    }
  })
})
