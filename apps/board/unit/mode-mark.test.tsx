import { readFileSync } from 'node:fs'

import { Recipe } from '@lingtai/recipe'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ModeLink, ProjectModeMark } from '@/app/mode-glyph.tsx'
import { ProjectRows } from '@/app/projects.tsx'
import { modeMark } from '@/lib/mode-mark.ts'

const recipe = (extra: object) =>
  Recipe.parse({
    version: 2,
    source: { kinds: ['bug'] },
    repo: { submodules: false },
    env: { plantAt: '.env.local' },
    runtime: {},
    branch: { main: 'main' },
    ...extra,
  })

const TEAM = 'team · lands on me/work; main moves when a PR merges'
const team = recipe({ mode: 'team', branch: { main: 'main', personal: 'me/work' } })

describe('modeMark (#1463)', () => {
  it('says where a team recipe lands', () => {
    expect(modeMark(team)).toEqual({ mode: 'team', sentence: TEAM })
  })
  it('says solo for solo and for no mode at all', () => {
    const solo = { mode: 'solo', sentence: 'solo · lands on main' }
    expect(modeMark(recipe({ mode: 'solo' }))).toEqual(solo)
    expect(modeMark(recipe({}))).toEqual(solo)
  })
})

const count = (html: string, tag: string) => html.split(`<${tag}`).length - 1

describe('the bar mark', () => {
  const draw = (mode: 'team' | 'solo', sentence: string) =>
    renderToStaticMarkup(<ModeLink mark={{ mode, sentence }} project="my proj" />)

  it('draws the team glyph: two paths, three dots, the sentence as name and tooltip, and no text', () => {
    const out = draw('team', TEAM)
    expect(count(out, 'svg viewBox="0 0 16 16"')).toBe(1)
    expect(count(out, 'path')).toBe(2)
    expect(count(out, 'circle')).toBe(3)
    expect(out).toContain(`aria-label="${TEAM}"`)
    expect(out).toContain(`title="${TEAM}"`)
    expect(out).toContain('href="/recipe/my%20proj#mode"')
    expect(out.replace(/<svg.*<\/svg>/, '').replace(/<[^>]*>/g, '')).toBe('')
  })
  it('draws the solo glyph: one path, two dots', () => {
    const out = draw('solo', 'solo · lands on main')
    expect(count(out, 'svg viewBox="0 0 16 16"')).toBe(1)
    expect(count(out, 'path')).toBe(1)
    expect(count(out, 'circle')).toBe(2)
    expect(out).toContain('aria-label="solo · lands on main"')
  })
})

describe('the menu rows', () => {
  const out = renderToStaticMarkup(
    <ProjectRows
      filters={['a', 'b']}
      only={undefined}
      app
      registered={['a', 'b']}
      locks={new Map()}
      mode={new Map([['a', { mode: 'team' as const, sentence: TEAM }]])}
    />,
  )
  const row = (name: string) => out.slice(out.indexOf(`href="/?project=${name}"`)).split('</a>')[0]!

  it('draws a span role=img inside the row link, and none for a project without an entry', () => {
    expect(row('a')).toContain('<span class="mode-mark mode-row" role="img"')
    expect(row('b')).not.toContain('mode-mark')
  })
  it('puts it after the sandbox mark', () => {
    const sandbox = new Map([['a', { state: 'sandboxed', projects: [], unreadable: [], sentence: 's' }]])
    const both = renderToStaticMarkup(
      <ProjectRows
        filters={['a']}
        only={undefined}
        app
        registered={['a']}
        locks={new Map()}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sandbox={sandbox as any}
        mode={new Map([['a', { mode: 'solo' as const, sentence: 'solo · lands on main' }]])}
      />,
    )
    expect(both.indexOf('sbx-row')).toBeGreaterThan(-1)
    expect(both.indexOf('sbx-row')).toBeLessThan(both.indexOf('mode-row'))
  })
  it('renders nothing for an undefined mark', () => {
    expect(renderToStaticMarkup(<ProjectModeMark mark={undefined} />)).toBe('')
  })
})

describe('where it is wired, and what it does not read', () => {
  const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
  const page = read('../src/app/page.tsx')

  it('puts the mode slot after the shield and before health in the rail', () => {
    const rail = page.slice(page.indexOf('className="rail"'))
    const at = (s: string) => rail.indexOf(s)
    expect(at('sandboxSlot(')).toBeGreaterThan(-1)
    expect(at('modeSlot(ctx.reads.board')).toBeGreaterThan(at('sandboxSlot('))
    expect(at('<Health')).toBeGreaterThan(at('modeSlot('))
  })
  it('reads no recipe of its own', () => {
    const slot = read('../src/app/mode-slot.tsx')
    for (const call of ['projectRecipe', 'readRecipe', 'projectFilter', 'readSandboxMark']) {
      expect(slot).not.toContain(call)
    }
  })
  it('keeps server-only imports out of the client graph', () => {
    for (const f of ['../src/app/projects.tsx', '../src/app/mode-glyph.tsx']) {
      const src = read(f)
      for (const m of src.matchAll(/^import .*from '@\/lib\/mode-mark\.ts'/gm)) expect(m[0]).toMatch(/^import type /)
      expect(src).not.toMatch(/recipe-lines|@lingtai\/recipe/)
    }
  })
  it('the skeleton has no text', () => {
    const slot = read('../src/app/mode-slot.tsx')
    expect(slot).toContain('<span className="mode-mark mode-skeleton" aria-hidden="true" />')
  })
})
