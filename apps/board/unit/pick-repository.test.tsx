import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { filterRows, type Group, nextHref, type Source, typedSlug } from '../src/app/setup/repository/pick-model.ts'
import { PickRepository } from '../src/app/setup/repository/pick-repository.tsx'
import { viewOf } from '../src/app/setup/repository/view.ts'

const groups: Group[] = [
  {
    label: 'acme',
    sentences: [],
    rows: [
      { slug: 'acme/widget', disabled: 'already added', private: false },
      { slug: 'acme/gadget', disabled: null, private: true },
    ],
  },
]

describe('pick-model', () => {
  it('filters rows by substring, case-insensitively', () => {
    expect(filterRows(groups[0]!.rows, 'GAD').map((r) => r.slug)).toEqual(['acme/gadget'])
  })
  it('accepts a typed owner/repo unless it is a disabled row', () => {
    expect(typedSlug('other/new', groups)).toBe('other/new')
    expect(typedSlug('ACME/widget', groups)).toBeNull()
    expect(typedSlug('nope', groups)).toBeNull()
  })
  it('encodes the choice in the step-2 url', () => {
    expect(nextHref({ kind: 'repo', slug: 'a/b' })).toBe('/setup/repository/read?repo=a%2Fb')
    expect(nextHref({ kind: 'path', path: '/my dir/x' })).toBe('/setup/repository/read?path=%2Fmy%20dir%2Fx')
  })
})

describe('the step 1 screen', () => {
  it('lists an App machine, disabling what is added', () => {
    const source: Source = {
      list: viewOf({
        kind: 'gh',
        login: 'me',
        more: false,
        repositories: [
          { owner: 'acme', repo: 'widget', private: false, slug: 'acme/widget', onboarded: 'registered' },
          { owner: 'acme', repo: 'taken', private: false, slug: 'acme/taken', onboarded: 'taken', takenBy: 'zed' },
        ],
      }),
    }
    const out = renderToStaticMarkup(<PickRepository source={source} />)
    expect(out).toContain('already added')
    expect(out).toContain('taken by zed')
    expect(out).toContain('GitHub')
  })
  it('offers Local only with no GitHub', () => {
    const out = renderToStaticMarkup(<PickRepository source={null} />)
    expect(out).not.toContain('>GitHub<')
    expect(out).toContain('/absolute/path')
  })
  it('shows the sentence and still takes owner/repo when the read failed', () => {
    const out = renderToStaticMarkup(<PickRepository source={{ error: 'GitHub is down' }} />)
    expect(out).toContain('GitHub is down')
    expect(out).toContain('owner/repo')
  })
})
