/** Step 3's card in each state it can be in (#972). */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { AddedCard, type Added } from '../src/app/setup/repository/added/added-card.tsx'

const html = (a: Added) => renderToStaticMarkup(<AddedCard {...a} />)
const ok = (over: Partial<{ held: string[]; owner: string | null; github: boolean }> = {}): Added => ({
  state: 'registered',
  project: 'chapter-garden',
  recipe: '~/.lingtai/chapter-garden/recipe.yml',
  read: { ok: true, kinds: ['bug', 'feature'], held: ['agent:hold'], owner: 'me', github: true, ...over },
})

describe('step 3', () => {
  it('draws the whole card', () => {
    const out = html(ok())
    expect(out).toContain('chapter-garden</span> is added')
    expect(out).toContain('~/.lingtai/chapter-garden/recipe.yml')
    expect(out).toContain('registered')
    expect(out).toContain('>bug<')
    expect(out).toContain('agent:hold')
    expect(out).toContain('href="/recipe/chapter-garden/edit"')
    expect(out).toContain('href="https://github.com/me/chapter-garden/issues/new"')
  })

  it('names no held label when the recipe holds none', () => {
    expect(html(ok({ held: [] }))).not.toContain('agent:hold')
  })

  it('hides the ticket link without an owner or on a db source', () => {
    for (const out of [html(ok({ owner: null })), html(ok({ github: false }))]) {
      expect(out).not.toContain('issues/new')
      expect(out).toContain('lingtai ticket new --project chapter-garden')
    }
  })

  it('keeps registered and the edit link when the recipe cannot be read', () => {
    const out = html({ ...(ok() as Extract<Added, { state: 'registered' }>), read: { ok: false, problem: 'bad yaml' } })
    expect(out).toContain('bad yaml')
    expect(out).toContain('registered')
    expect(out).toContain('/edit"')
    expect(out).not.toContain('issues/new')
  })

  it('says each non-card state, and links step 1 where it should', () => {
    expect(html({ state: 'none' })).toContain('Nothing was added')
    expect(html({ state: 'unregistered', project: 'x' })).toContain('not registered')
    expect(html({ state: 'unregistered', project: 'x' })).toContain('href="/setup/repository"')
    expect(html({ state: 'unreadable', project: 'x' })).not.toContain('not registered')
  })
})
