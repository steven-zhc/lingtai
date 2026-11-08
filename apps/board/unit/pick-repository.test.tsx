import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  filterRows,
  type Group,
  nextHref,
  shellWord,
  type Source,
  typedSlug,
} from '../src/app/setup/repository/pick-model.ts'
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

describe('shellWord', () => {
  it('leaves a plain path alone and quotes one with a space or a quote', () => {
    expect(shellWord('/work/widget')).toBe('/work/widget')
    expect(shellWord('acme/widget')).toBe('acme/widget')
    expect(shellWord('/work/my project')).toBe("'/work/my project'")
    expect(shellWord("/work/it's")).toBe("'/work/it'\\''s'")
  })
})

describe('the step 1 screen', () => {
  it('lists App installations, keeps the install link beside them and disables added rows', () => {
    const source: Source = {
      list: viewOf({
        kind: 'app',
        picker: {
          installUrl: 'https://github.com/apps/x/installations/new',
          installations: [
            {
              installation: { account: 'me' } as never,
              unanswered: null,
              gaps: [],
              repositories: [
                { owner: 'me', repo: 'old', private: false, slug: 'me/old', onboarded: 'registered' },
                { owner: 'me', repo: 'fresh', private: false, slug: 'me/fresh', onboarded: null },
              ],
            },
          ],
        },
      }),
    }
    const out = renderToStaticMarkup(<PickRepository source={source} />)
    expect(out).toContain('me/fresh')
    expect(out).toContain('https://github.com/apps/x/installations/new')
    expect(out).toMatch(/<input[^>]*type="radio"[^>]*disabled=""[^>]*\/><span class="mono">me\/old/)
    expect(out).not.toMatch(/<input[^>]*type="radio"[^>]*disabled=""[^>]*\/><span class="mono">me\/fresh/)
  })

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
    expect(out.match(/<input[^>]*type="radio"[^>]*disabled=""/g)).toHaveLength(2)
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
    expect(out).not.toContain('type="radio"')
    expect(typedSlug('acme/new', [])).toBe('acme/new')
  })
})
