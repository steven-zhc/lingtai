import { describe, expect, it } from 'vitest'

import {
  attemptTabPath,
  backlogPath,
  historyPath,
  homePath,
  landedHref,
  prPath,
  recipePath,
  sandboxTabPath,
  tabPath,
  ticketIdOf,
  ticketPath,
  ticketRefOf,
} from '../src/lib/paths.ts'

describe('the address of every project page (#1498)', () => {
  it('states each shape once', () => {
    const ref = { project: 'lingtai', issue: '1474' }
    expect(homePath('lingtai')).toBe('/p/lingtai/ticket')
    expect(homePath(undefined)).toBe('/')
    expect(ticketPath(ref)).toBe('/p/lingtai/ticket/1474')
    expect(historyPath(ref)).toBe('/p/lingtai/ticket/1474/history')
    expect(attemptTabPath(ref, 2)).toBe('/p/lingtai/ticket/1474/attempt/2')
    expect(sandboxTabPath(ref)).toBe('/p/lingtai/ticket/1474/sandbox')
    expect(sandboxTabPath(ref, 3)).toBe('/p/lingtai/ticket/1474/sandbox?attempt=3')
    expect(tabPath(ref, 'ticket')).toBe('/p/lingtai/ticket/1474/history')
    expect(prPath('lingtai')).toBe('/p/lingtai/pr')
    expect(prPath('lingtai', 'next')).toBe('/p/lingtai/pr/next')
    expect(prPath('lingtai', 7)).toBe('/p/lingtai/pr/7')
    expect(recipePath('lingtai')).toBe('/p/lingtai/recipe')
    expect(backlogPath('lingtai')).toBe('/p/lingtai/backlog')
    expect(backlogPath()).toBe('/backlog')
    expect(landedHref({ project: 'lingtai', kind: 'bug' })).toBe('/p/lingtai/ticket/landed?kind=bug')
    expect(landedHref({})).toBe('/landed')
  })

  it('takes a stream id as well as a ref, and encodes the project', () => {
    expect(ticketPath('ticket-chapter-garden-1')).toBe('/p/chapter-garden/ticket/1')
    expect(ticketPath({ project: 'a b', issue: 3 })).toBe('/p/a%20b/ticket/3')
    expect(homePath('a b')).toBe('/p/a%20b/ticket')
  })

  it('reads route params back to the stream id, once', () => {
    expect(ticketIdOf('chapter-garden', '1')).toBe('ticket-chapter-garden-1')
    expect(ticketIdOf('a%20b', '3')).toBe('ticket-a b-3')
    expect(ticketIdOf('lingtai', 'landed')).toBeNull()
    expect(ticketIdOf('lingtai', '0')).toBeNull()
    expect(ticketIdOf('%E0%A4%A', '1')).toBeNull()
    expect(ticketRefOf('ticket-x-abc')).toBeNull()
  })
})
