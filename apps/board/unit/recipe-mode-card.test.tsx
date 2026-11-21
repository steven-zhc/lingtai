import { Recipe as RecipeSchema } from '@lingtai/recipe'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { ModeCard, Recipe } from '@/app/recipe/[project]/page'

describe('the refused paragraph (#1326)', () => {
  it('says recipe refused with the refusal sentence, and could not be read for the rest', () => {
    const base = { ok: false, project: 'p', at: '/h/.lingtai/p/recipe.yml', text: null } as const
    const refused = renderToStaticMarkup(
      <Recipe view={{ ...base, fault: 'refused', problem: 'take: all is refused' }} />,
    )
    expect(refused).toContain('recipe refused — take: all is refused')
    expect(refused).not.toContain('could not be read:')
    const plain = renderToStaticMarkup(<Recipe view={{ ...base, fault: 'recipe', problem: 'bad yaml' }} />)
    expect(plain).toContain('could not be read')
  })
})

const clean = (html: string) => html.replaceAll('<!-- -->', '')

describe('the CI row (#1338)', () => {
  const card = (pr: object) =>
    clean(
      renderToStaticMarkup(
        <ModeCard
          recipe={RecipeSchema.parse({
            version: 2,
            mode: 'team',
            branch: { main: 'main', personal: 'me/work' },
            source: { kinds: ['bug'] },
            repo: { submodules: false },
            env: { plantAt: '.env.local' },
            runtime: {},
            pr,
          })}
        />,
      ),
    )

  it('says detect, every check and 60m from the default', () => {
    const html = card({})
    expect(html).toContain('detect (a pull_request workflow means GitHub Actions) ← default')
    expect(html).toContain('every check ← default')
    expect(html).toContain('60m ← default')
  })

  it('marks only the values the recipe wrote', () => {
    const html = card({ ci: { timeout: '30m' } })
    expect(html).toContain('30m ← recipe.yml')
    expect(html).toContain('every check ← default')
  })
})
