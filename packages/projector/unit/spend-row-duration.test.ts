import { describe, expect, it } from 'vitest'

import { toSpendRow } from '../src/postgres.ts'

describe('a Postgres spend row (#1512)', () => {
  it('reads a bigint duration_ms, which pg returns as a string, as a number', () => {
    const row = toSpendRow({ seq: '1', duration_ms: '352304', spent_for: null })
    expect(typeof row.durationMs).toBe('number')
    expect(row.durationMs).toBe(352304)
  })

  it('adds durations instead of joining their digits', () => {
    const rows = ['352304', '1203455'].map((d) => toSpendRow({ seq: '1', duration_ms: d, spent_for: null }))
    expect(rows.reduce((n, r) => n + r.durationMs, 0)).toBe(1555759)
  })
})
