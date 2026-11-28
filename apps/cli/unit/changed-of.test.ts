import { describe, expect, it } from 'vitest'

import { changedOf } from '../src/project-support.ts'

const start = (doc: Record<string, unknown> | null) => ({
  text: () => (doc === null ? null : 'x'),
  get: (path: readonly (string | number)[]) =>
    path.reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key as string], doc),
})

describe('changedOf (#1525)', () => {
  it('says nothing about a new recipe', () => {
    expect(changedOf(start(null), { mode: 'team' })).toBeUndefined()
  })

  it('says nothing where the answers are the recipe as it was', () => {
    const doc = { mode: 'team', branch: { main: 'main', personal: 'steven' } }
    expect(
      changedOf(start(doc), {
        mode: 'team',
        branch: { name: 'steven', exists: true, from: null, onlyIn: null, main: 'main' },
      }),
    ).toBeUndefined()
  })

  it('reads team to solo with the personal branch it leaves and the main it lands on', () => {
    const doc = { mode: 'team', branch: { main: 'main', personal: 'steven' } }
    expect(changedOf(start(doc), { mode: 'solo' })).toEqual({
      mode: { from: 'team', to: 'solo', personal: 'steven', main: 'main' },
    })
  })

  it('reads a new personal branch that was made, from where it was cut', () => {
    const doc = { mode: 'team', branch: { main: 'main', personal: 'old' } }
    expect(
      changedOf(start(doc), {
        mode: 'team',
        branch: { name: 'new', exists: false, from: 'main', onlyIn: null, main: 'main' },
        make: { name: 'new', from: 'main' },
      }),
    ).toEqual({ branch: { from: 'old', to: 'new', made: true, madeFrom: 'main' } })
  })

  it('reads a new personal branch that existed, with the commits only the old one has', () => {
    const doc = { mode: 'team', branch: { main: 'main', personal: 'old' } }
    expect(
      changedOf(start(doc), {
        mode: 'team',
        branch: { name: 'new', exists: true, from: null, onlyIn: ['abc1234 fix'], main: 'main' },
      }),
    ).toEqual({ branch: { from: 'old', to: 'new', made: false, commits: ['abc1234 fix'] } })
  })
})
