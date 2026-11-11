import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { withProject } from '../src/app/bar.tsx'
import { LandedCount } from '../src/app/page.tsx'
import { selectedProject } from '../src/lib/board.ts'

describe('selectedProject (#993)', () => {
  it('takes the URL’s choice, else the only project there is', () => {
    expect(selectedProject('a', ['a', 'b'])).toBe('a')
    expect(selectedProject('typo', ['a'])).toBe('typo')
    expect(selectedProject(undefined, ['a'])).toBe('a')
  })

  it('has none to default to on all, or on an empty board', () => {
    expect(selectedProject(undefined, ['a', 'b'])).toBeUndefined()
    expect(selectedProject(undefined, [])).toBeUndefined()
  })

  it('makes Report and the Landed count carry the project on a one-project board', () => {
    const only = selectedProject(undefined, ['lingtai'])
    expect(withProject('/report', only)).toBe('/report?project=lingtai')
    expect(renderToStaticMarkup(<LandedCount count={2} only={only} />)).toContain('project=lingtai')
  })
})
