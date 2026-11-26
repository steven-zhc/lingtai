import type { PrState } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { footLine, type LandedWhereRead, whereLanded } from '../src/lib/where-landed.ts'

const pr = (over: Record<string, unknown>): PrState =>
  ({
    n: 7,
    host: null,
    status: 'in-review',
    tickets: [],
    mergedTickets: [],
    mergedExact: true,
    ...over,
  }) as unknown as PrState
const held = (...ids: string[]) => ids.map((ticket) => ({ ticket }))
const team = (prs: PrState[], draft: string[] | { error: string }): LandedWhereRead => ({
  kind: 'team',
  prs: prs.map((p) => ({ n: p.n ?? 0, pr: p })),
  draft: Array.isArray(draft) ? (held(...draft) as never) : draft,
})

describe('whereLanded', () => {
  it('a draft ticket is on your branch', () => {
    expect(whereLanded('#1', team([], ['#1']))).toEqual({ tag: 'branch' })
  })
  it('names the open PR by host number, or by n before one', () => {
    const open = { tickets: held('#1') }
    expect(whereLanded('#1', team([pr({ ...open, host: { number: 88 } })], []))).toMatchObject({
      tag: 'pr',
      name: 'PR #88',
    })
    expect(whereLanded('#1', team([pr(open)], []))).toMatchObject({ tag: 'pr', name: 'PR 7', n: 7 })
  })
  it('merged only for what the merged head held', () => {
    const merged = pr({ status: 'merged', tickets: held('#1', '#2'), mergedTickets: ['#1'] })
    expect(whereLanded('#1', team([merged], []))).toMatchObject({ tag: 'merged' })
    expect(whereLanded('#2', team([merged], []))).toBeNull()
  })
  it('in none, or on a failed read, has no tag', () => {
    expect(whereLanded('#9', team([], ['#1']))).toBeNull()
    expect(whereLanded('#1', { kind: 'failed', error: 'x' })).toBeNull()
    expect(whereLanded('#1', team([], { error: 'x' }))).toBeNull()
    expect(whereLanded('#1', { kind: 'solo' })).toBeNull()
  })
})

describe('footLine', () => {
  it('counts the draft and names the open PR', () => {
    const read = team([pr({ host: { number: 88 } })], ['#1', '#2'])
    expect(footLine(read)).toEqual({ kind: 'line', draft: 2, open: 'PR #88 in review' })
  })
  it('counts one ticket with no open PR beside it', () => {
    expect(footLine(team([], ['#1']))).toEqual({ kind: 'line', draft: 1, open: null })
  })
  it('says nothing when nothing is waiting, and says unread when it could not tell', () => {
    expect(footLine(team([], []))).toBeNull()
    expect(footLine({ kind: 'failed', error: 'x' })).toEqual({ kind: 'unread' })
    expect(footLine(team([], { error: 'x' }))).toEqual({ kind: 'unread' })
  })
})
