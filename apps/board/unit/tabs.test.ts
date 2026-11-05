import { describe, expect, it } from 'vitest'

import {
  attemptOfSegment,
  attemptTabPath,
  defaultTabOf,
  tabOfFragment,
  ticketTabPath,
  visibleAttempts,
} from '../src/lib/tabs.ts'
import { relativeTo } from '../src/lib/task.ts'

const runs = (n: number) => Array.from({ length: n }, (_, i) => ({ attempt: i + 1 }))

describe('the default tab (#885)', () => {
  it('is the attempt the page is deciding on while the ticket is blocked', () => {
    expect(defaultTabOf({ state: 'blocked', deciding: { attempt: 1 } }, runs(3))).toEqual({ attempt: 1 })
  })

  it('is the newest attempt otherwise, even when `deciding` names an older failure', () => {
    // `decidingOf` walks back to an earlier refusal; on a landed ticket that is
    // history and not what the page is deciding on.
    expect(defaultTabOf({ state: 'landed', deciding: { attempt: 1 } }, runs(2))).toEqual({ attempt: 2 })
    expect(defaultTabOf({ state: 'running', deciding: { attempt: 1 } }, runs(2))).toEqual({ attempt: 2 })
  })

  it('is the Ticket when nothing has been dispatched', () => {
    expect(defaultTabOf({ state: 'queued', deciding: null }, [])).toBe('ticket')
  })
})

describe('which attempts get a tab of their own', () => {
  const all = [1, 2, 3, 4, 5, 6, 7]

  it('gives every attempt a tab up to three', () => {
    expect(visibleAttempts({ attempts: [1, 2, 3], deciding: null, selected: 'ticket' })).toEqual({
      shown: [3, 2, 1],
      earlier: [],
    })
  })

  it('shows the three newest, and puts the rest under earlier attempts', () => {
    expect(visibleAttempts({ attempts: all, deciding: null, selected: 'ticket' })).toEqual({
      shown: [7, 6, 5],
      earlier: [4, 3, 2, 1],
    })
  })

  it('keeps the deciding attempt and the open one even when older, at most five', () => {
    const got = visibleAttempts({ attempts: all, deciding: 2, selected: { attempt: 4 } })
    expect(got.shown).toEqual([7, 6, 5, 4, 2])
    expect(got.earlier).toEqual([3, 1])
  })

  it('does not count the same attempt twice', () => {
    expect(visibleAttempts({ attempts: all, deciding: 7, selected: { attempt: 6 } }).shown).toEqual([7, 6, 5])
  })
})

describe('paths and old fragments', () => {
  it('builds absolute paths, so an attempt tab does not link to attempt/attempt/N', () => {
    expect(attemptTabPath('ticket-lingtai-885', 3)).toBe('/task/ticket-lingtai-885/attempt/3')
    expect(ticketTabPath('ticket-lingtai-885')).toBe('/task/ticket-lingtai-885/ticket')
  })

  it('sends an old fragment to the tab it meant', () => {
    expect(tabOfFragment('#attempt-7')).toEqual({ attempt: 7 })
    expect(tabOfFragment('#record-ticket')).toBe('ticket')
    expect(tabOfFragment('#record-diff')).toBe('default')
    expect(tabOfFragment('#resolution-Close')).toBeNull()
    expect(tabOfFragment('')).toBeNull()
  })

  it('reads an attempt segment only if it is a whole number from 1', () => {
    expect(attemptOfSegment('3')).toBe(3)
    for (const bad of ['0', '-1', '1.5', 'x', '01', '']) expect(attemptOfSegment(bad)).toBeNull()
  })
})

describe('a path as the repository names it', () => {
  it('drops the worktree and leaves anything outside it as recorded', () => {
    const tree = '/Users/x/.lingtai/worktrees/lingtai/pass-1'
    expect(relativeTo(tree, `${tree}/apps/board/a.ts`)).toBe('apps/board/a.ts')
    expect(relativeTo(tree, '/etc/hosts')).toBe('/etc/hosts')
    expect(relativeTo(null, '/a/b')).toBe('/a/b')
    expect(relativeTo(`${tree}/`, `${tree}/a.ts`)).toBe('a.ts')
  })
})
