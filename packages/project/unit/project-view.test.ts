/**
 * `projectView` (#1530): a recipe as an answer is being built, read with the pending changes laid over it and
 * nothing applied. A literal `start` is enough — the view never reads a file.
 */
import type { RecipeChange } from '@lingtai/recipe'
import { describe, expect, it } from 'vitest'

import { projectView } from '../src/index.ts'

const PATH = '/home/me/.lingtai/app/recipe.yml'

const FIXTURE = `version: 2
branch:
  main: main
source:
  kinds: [bug]
env:
  plantAt: .env.local
`

const at = (text: string | null) => ({ path: PATH, text: () => text })

describe('projectView', () => {
  it('reads the starting text where nothing is pending', () => {
    const view = projectView(at(FIXTURE), [])
    expect(view.get(['branch', 'main'])).toBe('main')
    expect(view.get(['source', 'kinds'])).toEqual(['bug'])
    expect(view.get(['branch', 'personal'])).toBeNull()
  })

  it('overlays a pending change on a key the text writes, and on one it does not', () => {
    const pending: RecipeChange[] = [
      { path: ['branch', 'main'], value: 'trunk' },
      { path: ['limits', 'refusalFixes'], value: 3 },
    ]
    const view = projectView(at(FIXTURE), pending)
    expect(view.get(['branch', 'main'])).toBe('trunk')
    expect(view.get(['limits', 'refusalFixes'])).toBe(3)
  })

  it('reads a deletion as absent', () => {
    const view = projectView(at(FIXTURE), [{ path: ['source', 'kinds'], value: undefined }])
    expect(view.get(['source', 'kinds'])).toBeNull()
    expect(view.get(['branch', 'main'])).toBe('main')
  })

  it('lets a later change at a path replace an earlier one', () => {
    const view = projectView(at(FIXTURE), [
      { path: ['branch', 'main'], value: 'one' },
      { path: ['branch', 'main'], value: 'two' },
    ])
    expect(view.get(['branch', 'main'])).toBe('two')
  })

  it('lets a deletion be answered again by a later write', () => {
    const view = projectView(at(FIXTURE), [
      { path: ['source', 'kinds'], value: undefined },
      { path: ['source', 'kinds'], value: ['feature'] },
    ])
    expect(view.get(['source', 'kinds'])).toEqual(['feature'])
  })

  it('sees a change pushed after the view was made', () => {
    const pending: RecipeChange[] = []
    const view = projectView(at(FIXTURE), pending)
    expect(view.get(['branch', 'main'])).toBe('main')
    pending.push({ path: ['branch', 'main'], value: 'later' })
    expect(view.get(['branch', 'main'])).toBe('later')
  })

  it('overlays onto a version seed where there is no text, and writes nothing', () => {
    const start = at(null)
    const view = projectView(start, [{ path: ['branch', 'main'], value: 'main' }])
    expect(view.get(['branch', 'main'])).toBe('main')
    expect(view.get(['version'])).toBe(2)
    expect(start.text()).toBeNull()
  })

  it('answers null at every path over text that is not a mapping, and never throws', () => {
    const view = projectView(at('- just\n- a list\n'), [{ path: ['branch', 'main'], value: 'main' }])
    expect(view.get(['branch', 'main'])).toBeNull()
    expect(view.get([])).toBeNull()
    expect(view.resolved()).toBeNull()
  })

  it('reads a prefix that is not yet a recipe', () => {
    const view = projectView(at(null), [{ path: ['source', 'tickets'], value: 'github' }])
    expect(view.get(['source', 'tickets'])).toBe('github')
    expect(view.resolved()).toBeNull()
  })

  it('resolves the starting text, and what is pending on it', () => {
    const view = projectView(at(FIXTURE), [{ path: ['branch', 'main'], value: 'trunk' }])
    expect(view.resolved()?.recipe.branch.main).toBe('trunk')
  })

  it('resolves null where there is no text and no env.plantAt', () => {
    expect(projectView(at(null), []).resolved()).toBeNull()
    expect(projectView(at(null), [{ path: ['branch', 'main'], value: 'main' }]).resolved()).toBeNull()
  })

  it('resolves a first run once its seeds are pending', () => {
    const view = projectView(at(null), [
      { path: ['env', 'plantAt'], value: '.env.local' },
      { path: ['source', 'kinds'], value: ['bug'] },
      { path: ['branch', 'main'], value: 'main' },
    ])
    expect(view.resolved()?.recipe.env.plantAt).toBe('.env.local')
  })
})
