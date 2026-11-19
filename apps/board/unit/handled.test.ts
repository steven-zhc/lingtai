import { PROBLEM_KINDS } from '@lingtai/domain'
import { describe, expect, it } from 'vitest'

import { HANDLED_ORDER, HANDLED_ROWS, pageHandled, shareWithoutYou, windowText } from '../src/lib/handled.ts'

describe('handled-for-you copy (#1285)', () => {
  it('has copy for every kind but other, in an order that lists each once', () => {
    for (const k of PROBLEM_KINDS) if (k !== 'other') expect(HANDLED_ROWS).toHaveProperty(k)
    expect(HANDLED_ORDER).toHaveLength(PROBLEM_KINDS.length)
    expect(new Set(HANDLED_ORDER).size).toBe(PROBLEM_KINDS.length)
    expect(HANDLED_ORDER.at(-1)).toBe('other')
  })

  it('draws no kind in an amber', () => {
    for (const r of Object.values(HANDLED_ROWS)) expect(r.colour).not.toMatch(/signal|warn/)
  })

  it('never says 100% beside someone needed, nor 0% beside something solved', () => {
    expect(shareWithoutYou(999, 1)).toBe(99)
    expect(shareWithoutYou(1, 999)).toBe(1)
    expect(shareWithoutYou(5, 0)).toBe(100)
    expect(shareWithoutYou(0, 0)).toBeNull()
  })

  it('pages newest first from a cursor that is a position', () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      at: new Date(Date.UTC(2026, 10, 18, 12, 0, 25 - i)).toISOString(),
      ticket: 't-1',
    }))
    const first = pageHandled(rows, null)
    expect(first).toMatchObject({ from: 1, to: 20, total: 25 })
    const second = pageHandled(rows, first.next)
    expect(second).toMatchObject({ from: 21, to: 25, total: 25, next: null })
    expect(second.rows).toHaveLength(5)
  })

  it('words the window', () => {
    expect(windowText('7d', new Date(2026, 10, 12), new Date(2026, 10, 19))).toBe('Nov 12 – 18 · 7 days')
    expect(windowText('7d', new Date(2026, 9, 30), new Date(2026, 10, 6))).toBe('Oct 30 – Nov 5 · 7 days')
    expect(windowText('today', new Date(2026, 10, 19), new Date(2026, 10, 20))).toBe('Nov 19 · today')
  })
})
