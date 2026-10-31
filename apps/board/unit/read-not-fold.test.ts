import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const projector = vi.hoisted(() => ({
  readLag: vi.fn(),
  readSpend: vi.fn(),
  readTicketReport: vi.fn(),
  readBacklog: vi.fn(),
}))
vi.mock('@lingtai/projector', async (original) => ({
  ...(await original<typeof import('@lingtai/projector')>()),
  ...projector,
}))

import { backlogChip } from '../src/lib/backlog.ts'
import { currentReport, reportChip } from '../src/lib/report.ts'
import { currentSpend, spendChip } from '../src/lib/spend.ts'
import { measure } from '../src/lib/timing.ts'

beforeEach(() => {
  vi.resetAllMocks()
  projector.readSpend.mockResolvedValue([])
  projector.readTicketReport.mockResolvedValue([])
})

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [join(dir, e.name)] : [],
  )

it('starts no projection runner anywhere in apps/board/src', () => {
  const offenders = sources(join(import.meta.dirname, '../src')).filter((f) =>
    readFileSync(f, 'utf8').includes('createProjectionRunner'),
  )
  expect(offenders).toEqual([])
})

describe('currentSpend', () => {
  it('returns the rows and the lag without folding', async () => {
    projector.readLag.mockResolvedValue({ lag: 5n })
    const rows = [{ ticket: 't' }]
    projector.readSpend.mockResolvedValue(rows)
    expect(await currentSpend({})).toEqual({ rows, currency: { lag: 5 } })
    expect(projector.readLag).toHaveBeenCalledWith('spend')
  })

  it('reports an unreadable lag and still returns the rows', async () => {
    projector.readLag.mockRejectedValue(new Error('down'))
    const rows = [{ ticket: 't' }]
    projector.readSpend.mockResolvedValue(rows)
    expect(await currentSpend({})).toEqual({ rows, currency: { lag: null, error: 'down' } })
  })

  it('rejects when the rows read throws', async () => {
    projector.readLag.mockResolvedValue({ lag: 0n })
    projector.readSpend.mockRejectedValue(new Error('rows'))
    await expect(currentSpend({})).rejects.toThrow('rows')
  })

  it('records spend.lag and spend.rows spans', async () => {
    projector.readLag.mockResolvedValue({ lag: 0n })
    const [, timings] = await measure(() => currentSpend({}))
    expect(timings.map((t) => t.name).toSorted()).toEqual(['spend.lag', 'spend.rows'])
  })
})

it('currentReport reads each lag once', async () => {
  projector.readLag.mockImplementation(async (name: string) => ({ lag: name === 'spend' ? 2n : 0n }))
  const r = await currentReport(null, new Date(0))
  expect(r.currency).toEqual({ ticketReport: { lag: 0 }, spend: { lag: 2 } })
  expect(projector.readLag.mock.calls.map((c) => c[0]).toSorted()).toEqual(['spend', 'ticket_report'])
})

it('no behind-N title says a reload folds', () => {
  const titles = [
    spendChip({ lag: 3 }).title,
    reportChip({ ticketReport: { lag: 3 }, spend: { lag: 0 } }).title,
    backlogChip({ lag: 3 }).title,
  ]
  for (const t of titles) expect(t).not.toContain('reload to fold')
})
