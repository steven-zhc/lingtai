import { describe, expect, it } from 'vitest'

import { legacyRedirect } from '../src/lib/legacy.ts'

const go = (path: string, search = '') => legacyRedirect(path, new URLSearchParams(search))

describe('legacyRedirect (#1498)', () => {
  it.each([
    ['/?project=x', '/p/x/ticket'],
    ['/?project=', '/'],
    ['/?project=a%20b&q=1', '/p/a%20b/ticket?q=1'],
    ['/landed?project=x', '/p/x/ticket/landed'],
    [
      '/landed?project=x&kind=bug&before=2026-01-01T00%3A00%3A00Z%7C3',
      '/p/x/ticket/landed?kind=bug&before=2026-01-01T00%3A00%3A00Z%7C3',
    ],
    ['/landed?project=&kind=bug', '/landed?kind=bug'],
    ['/backlog?project=x', '/p/x/backlog'],
    ['/backlog?project=', '/backlog'],
    ['/task/ticket-x-1474', '/p/x/ticket/1474'],
    ['/task/ticket-x-1474/ticket', '/p/x/ticket/1474/history'],
    ['/task/ticket-x-1474/ticket?events=1', '/p/x/ticket/1474/history?events=1'],
    ['/task/ticket-x-1474/attempt/2', '/p/x/ticket/1474/attempt/2'],
    ['/task/ticket-x-1474/sandbox?attempt=2', '/p/x/ticket/1474/sandbox?attempt=2'],
    ['/task/ticket-chapter-garden-1', '/p/chapter-garden/ticket/1'],
    ['/task/ticket-x-1474', '/p/x/ticket/1474'],
    ['/pr/x', '/p/x/pr'],
    ['/pr/x/next', '/p/x/pr/next'],
    ['/pr/x/7', '/p/x/pr/7'],
    ['/recipe/x', '/p/x/recipe'],
    ['/recipe/x?edit=1&allow=registry.npmjs.org&r=5', '/p/x/recipe?edit=1&allow=registry.npmjs.org&r=5'],
  ])('%s → %s', (from, to) => {
    const [path, search = ''] = from.split('?')
    expect(go(path!, search)).toBe(to)
  })

  it('decodes the stream id once', () => {
    expect(go('/task/ticket-x-1474'.replace('ticket-x', 'ticket%2Dx'))).toBe('/p/x/ticket/1474')
  })

  it.each([
    ['/task/foo'],
    ['/task/ticket-x-abc'],
    ['/task/ticket-x-1474/nope'],
    ['/task/ticket-x-1474/attempt/0'],
    ['/task/%E0%A4%A'],
    ['/pr/x/7/extra'],
    ['/recipe/x/extra'],
    ['/landed'],
    ['/backlog'],
    ['/'],
    ['/report'],
    ['/api/stream'],
    ['/p/x/ticket'],
  ])('leaves %s alone', (path) => {
    expect(go(path)).toBeNull()
  })
})
