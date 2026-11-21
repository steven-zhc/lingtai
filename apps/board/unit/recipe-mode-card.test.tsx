import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { Recipe } from '@/app/recipe/[project]/page'

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
