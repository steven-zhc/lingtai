import type { RateRow } from '@lingtai/domain/rate-card'
import type { Summary } from '@lingtai/setup'
import { describe, expect, it } from 'vitest'

import { priceHints } from '../src/recipe-flow.ts'

describe('the price hint after the summary (#693)', () => {
  const row = (model: string): RateRow => ({ model }) as unknown as RateRow
  const hints = (models: Summary['models'], snapshot: RateRow[] = []) => priceHints(models, snapshot)

  it('a shipped model prints nothing extra', () => {
    expect(hints([{ role: 'writer', model: 'claude-sonnet-5' }])).toEqual([])
  })

  it('a model in neither the card nor the snapshot names itself and lingtai doctor, once for both roles', () => {
    const lines = hints([
      { role: 'writer', model: 'mystery-1' },
      { role: 'reviewer', model: 'mystery-1' },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('mystery-1 is not priced yet')
    expect(lines[0]).toContain('lingtai doctor')
    expect(lines[0]).not.toMatch(/cannot/)
  })

  it('a model only in the snapshot prints nothing extra', () => {
    expect(hints([{ role: 'writer', model: 'mystery-1' }], [row('mystery-1')])).toEqual([])
  })

  it('a null row in the snapshot is skipped, and an unreadable snapshot is said so', () => {
    const m: Summary['models'] = [{ role: 'writer', model: 'mystery-1' }]
    expect(hints(m, [null as unknown as RateRow, row('mystery-1')])).toEqual([])
    expect(hints(m, [null as unknown as RateRow])[0]).toContain('mystery-1 is not priced yet')
    expect(priceHints(m, null)[0]).toContain('could not be read')
  })

  it('roles with no model print the runtime-reports line once', () => {
    const lines = hints([
      { role: 'writer', model: null },
      { role: 'reviewer', model: null },
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('its runtime reports')
  })
})
